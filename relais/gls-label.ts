// Supabase Edge Function : gls-label
//
// ÉDITER LES ÉTIQUETTES GLS DEPUIS L'ERP.
//
// Pourquoi un relais et pas un appel direct depuis index.html :
//   1. le dépôt GitHub de l'ERP est PUBLIC. Une clé GLS dans la page, c'est
//      une clé publiée — et n'importe qui pourrait éditer des étiquettes
//      FACTURÉES sur notre compte.
//   2. l'API GLS ne répond pas aux appels d'un navigateur (pas d'en-têtes
//      CORS). Même sans le point 1, ça ne marcherait pas.
// Une seule des deux raisons suffirait. Mêmes principes que shopify-refund
// et shopify-cancel : les secrets restent côté serveur, l'ERP ne connaît que
// l'adresse de cette fonction.
//
// Authentification : OAuth2 client_credentials, comme Shopify. UNE différence
// qui compte : le jeton GLS ne vit que 4 HEURES (14400 s), contre 24 h chez
// Shopify. Le cache ci-dessous s'en souvient tout seul.
//
// Documentation : GLS Web API ShipIT-Farm V01-04.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const CID = Deno.env.get("GLS_CLIENT_ID");
const CSEC = Deno.env.get("GLS_CLIENT_SECRET");
const CONTACT = Deno.env.get("GLS_CONTACT_ID");

// Deux environnements. On reste sur le bac à sable TANT QUE GLS n'a pas validé
// nos étiquettes de test : ils ne garantissent pas le service sinon. Les
// étiquettes du bac à sable portent « TEST » entre les deux codes 2D, donc
// aucune confusion possible avec une vraie.
const BASES: Record<string, string> = {
  sandbox: "https://api-sandbox.gls-group.net",
  prod: "https://api.gls-group.net",
};
const envOf = (x: unknown) => (String(x || "") === "prod" ? "prod" : "sandbox");

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// ---------------------------------------------------------------------------
// Le jeton, un par environnement.
// ---------------------------------------------------------------------------
const _tok: Record<string, { v: string; exp: number }> = {};

async function getToken(env: string, force = false): Promise<string> {
  const now = Date.now();
  const c = _tok[env];
  if (!force && c && now < c.exp) return c.v;

  const r = await fetch(`${BASES[env]}/oauth2/v2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: CID || "",
      client_secret: CSEC || "",
    }),
  });
  const txt = await r.text();
  let j: any = {};
  try { j = JSON.parse(txt); } catch (_) { /* réponse illisible : on garde le texte */ }
  if (!r.ok || !j.access_token)
    throw new Error("jeton GLS refusé (HTTP " + r.status + ") : " + txt.slice(0, 400));

  // expires_in vaut 14400 (4 h). On retire une minute pour ne jamais présenter
  // un jeton qui expire pendant le trajet.
  _tok[env] = { v: j.access_token, exp: now + ((j.expires_in || 14400) - 60) * 1000 };
  return j.access_token;
}

// ---------------------------------------------------------------------------
// Un appel à ShipIT-Farm.
//
// PIÈGE DE CETTE API : les messages d'erreur ne sont PAS dans le corps de la
// réponse, ils sont dans les EN-TÊTES (message, error, args). Un relais qui ne
// lirait que le corps échouerait en silence, avec un corps vide et aucune idée
// de ce qui cloche. On les lit donc systématiquement.
// ---------------------------------------------------------------------------
async function gls(env: string, chemin: string, corps: unknown, methode = "POST") {
  const url = `${BASES[env]}/shipit-farm/v1/backend/rs${chemin}`;
  const appel = async (tok: string) =>
    fetch(url, {
      method: methode,
      headers: {
        "Authorization": "Bearer " + tok,
        "Accept": "application/glsVersion1+json, application/json",
        "Content-Type": "application/glsVersion1+json",
      },
      body: corps === undefined ? undefined : JSON.stringify(corps),
    });

  let tok = await getToken(env);
  let r = await appel(tok);
  // 401 = jeton expiré ou invalide. Une seule reprise, avec un jeton neuf.
  if (r.status === 401) { tok = await getToken(env, true); r = await appel(tok); }

  const txt = await r.text();
  let data: any = null;
  try { data = txt ? JSON.parse(txt) : null; } catch (_) { /* pas du JSON */ }

  const entete = {
    message: r.headers.get("message") || "",
    error: r.headers.get("error") || "",
    args: r.headers.get("args") || "",
  };
  return { ok: r.ok, status: r.status, data, texte: txt, entete };
}

/* Les refus de GLS sont exacts mais muets sur la suite à donner. On traduit en
   disant QUOI FAIRE : c'est la seule chose utile quand on a le colis en main. */
function litErreur(x: { status: number; entete: { message: string; error: string; args: string }; texte: string }): string {
  const e = x.entete;
  const brut = [e.message, e.error, e.args].filter(Boolean).join(" · ") || x.texte.slice(0, 400);

  if (x.status === 401)
    return "GLS refuse l'authentification. La clé ou le secret sont faux, ou l'App ID n'est pas encore activé sur cet environnement. " + brut;
  if (x.status === 403)
    return "GLS authentifie l'application mais refuse l'accès : l'App ID n'est pas rattaché à ce compte client, "
      + "ou le service demandé n'est pas ouvert sur le contrat. " + brut;
  if (/MANDATORY_PARAMETER_NOT_SET/i.test(brut))
    return "Un champ obligatoire manque pour ce service GLS : " + brut;
  if (x.status === 404)
    return "Ressource GLS introuvable : " + brut;
  if (x.status === 503)
    return "L'API GLS est momentanément indisponible. À réessayer dans quelques minutes. " + brut;
  return "GLS a refusé (HTTP " + x.status + ") : " + brut;
}

// ---------------------------------------------------------------------------
// Action : debug
//
// Le point de contrôle d'installation. Il ne produit RIEN et n'écrit nulle
// part : il dit seulement où on en est.
//   1. les trois secrets sont-ils posés ?
//   2. GLS délivre-t-il un jeton ? (clé + secret valides)
//   3. allowedservices répond-il ? (App ID activé ET rattaché au contrat)
//      La réponse liste en prime les produits et services réellement ouverts,
//      ce qui évite d'avoir à le demander à GLS par mail.
// ---------------------------------------------------------------------------
async function doDebug(p: any) {
  const env = envOf(p.env);
  const out: any = {
    ok: true,
    env,
    base: BASES[env],
    secrets: {
      GLS_CLIENT_ID: !!CID,
      GLS_CLIENT_SECRET: !!CSEC,
      GLS_CONTACT_ID: !!CONTACT,
    },
  };
  if (!CID || !CSEC) {
    out.ok = false;
    out.etape = "secrets";
    out.error = "Il manque GLS_CLIENT_ID et/ou GLS_CLIENT_SECRET dans les secrets Supabase.";
    return out;
  }

  // 2 — le jeton
  try {
    const t = await getToken(env, true);
    out.jeton = { obtenu: true, longueur: t.length, valideHeures: 4 };
  } catch (e) {
    out.ok = false;
    out.etape = "jeton";
    out.jeton = { obtenu: false };
    out.error = String((e as Error)?.message || e);
    return out;
  }

  // 3 — allowedservices. Sans ContactID, GLS ne peut pas répondre : on le dit
  //     plutôt que d'envoyer un appel qu'on sait voué à l'échec.
  if (!CONTACT) {
    out.etape = "contactid";
    out.services = null;
    out.hint = "Le jeton fonctionne. Il manque GLS_CONTACT_ID (ton identifiant expéditeur, "
      + "donné par GLS) pour aller plus loin.";
    return out;
  }

  const r = await gls(env, "/shipments/allowedservices", {
    Source: { CountryCode: p.srcPays || "FR", ZIPCode: p.srcCP || "03200" },
    Destination: { CountryCode: p.dstPays || "FR", ZIPCode: p.dstCP || "69003" },
    ContactID: CONTACT,
  });

  if (!r.ok) {
    out.ok = false;
    out.etape = "allowedservices";
    out.httpStatus = r.status;
    out.error = litErreur(r);
    return out;
  }

  out.etape = "pret";
  out.services = r.data?.AllowedServices || r.data || null;
  out.hint = "Jeton, App ID et ContactID fonctionnent. On peut éditer une étiquette de test.";
  return out;
}

// ---------------------------------------------------------------------------
// LES POINTS RELAIS
//
// Avant une étiquette ShopDelivery, il faut l'identifiant du point. GLS offre
// trois méthodes de recherche ; celle par ADRESSE est la bonne ici, puisqu'on
// part toujours de l'adresse du client.
// ---------------------------------------------------------------------------

/* KEEPER, c'est la livraison chez un VOISIN. Exclu d'office : une paire à
   800 € déposée chez un inconnu du quartier, c'est exactement ce qu'on
   cherche à éviter. Restent les commerces, les commerces-dans-commerce et
   les casiers. */
const TYPES_POINTS = "SHOP,SHOPINSHOP,LOCKER";

const JOURS: Record<string, string> = { MON: "lundi", TUE: "mardi", WED: "mercredi",
  THU: "jeudi", FRI: "vendredi", SAT: "samedi", SUN: "dimanche" };

/* Les horaires arrivent en MILLISECONDES UTC. La règle de GLS : diviser par
   3 600 000 puis ajouter une heure. On suit leur règle, c'est leur donnée —
   en sachant qu'elle est calée sur l'heure d'hiver et que l'affichage peut
   glisser d'une heure l'été. */
function heureGLS(ms: unknown): string {
  const n = Number(ms);
  if (!isFinite(n)) return "";
  const h = Math.floor(n / 3600000) + 1;
  const m = Math.round((n % 3600000) / 60000);
  return String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0");
}

/* GLS demande expressément de ne proposer que les points ouverts dans les
   10 jours. Un relais fermé pour congés, c'est un colis qui dort. */
function fermetureProche(s: any): boolean {
  const hs = s.Holidays || s.Holiday || [];
  if (!Array.isArray(hs) || !hs.length) return false;
  const maintenant = Date.now(), limite = maintenant + 10 * 86400000;
  return hs.some((h: any) => {
    const d1 = Date.parse(h.StartDate || h.startDate || "");
    if (!isFinite(d1)) return false;
    const d2 = Date.parse(h.EndDate || h.endDate || "");
    const fin = isFinite(d2) ? d2 : d1;
    return d1 <= limite && fin >= maintenant;
  });
}

function normShop(s: any) {
  const a = s.Address || {};
  const horaires = (s.WorkingDay || []).map((w: any) => ({
    jour: JOURS[String(w.DayOfWeek || "")] || String(w.DayOfWeek || ""),
    plages: (((w.OpeningHours || {}).OpeningHours) || [])
      .map((o: any) => heureGLS(o.From) + "–" + heureGLS(o.To)),
  }));
  const km = Number(s.AirlineDistance);
  return {
    id: s.ParcelShopID || "",
    nom: a.Name1 || "",
    rue: ((a.Street || "") + " " + (a.StreetNumber || "")).trim(),
    cp: a.ZIPCode || "",
    ville: a.City || "",
    pays: a.CountryCode || "",
    lat: Number(s.Location?.Latitude) || null,
    lon: Number(s.Location?.Longitude) || null,
    distanceKm: isFinite(km) ? Math.round(km * 10) / 10 : null,
    horaires,
    fermeBientot: fermetureProche(s),
  };
}

// ---------------------------------------------------------------------------
// Action : parcelshops — les relais autour de l'adresse du client.
// ---------------------------------------------------------------------------
async function doShops(p: any) {
  const env = envOf(p.env);
  if (!CID || !CSEC) return { ok: false, etape: "secrets", error: "Secrets GLS absents." };

  const d = p.destinataire || p;
  const pays = String(d.pays || "FR").toUpperCase().slice(0, 2);
  const cp = String(d.cp || "").trim();
  const ville = String(d.ville || "").trim();
  if (!cp || !ville)
    return { ok: false, etape: "champs",
      error: "Il faut au moins le code postal et la ville du client pour chercher un relais." };

  const corps: any = {
    Street: String(d.rue || "").slice(0, 35),
    CountryCode: pays,
    ZIPCode: cp,
    City: ville,
    MaxNumberOfShops: Math.min(Math.max(Number(p.max) || 12, 1), 30),
    Distance: String(Number(p.rayon) || 20),
    ParcelShopType: TYPES_POINTS,
  };
  if (d.numero) corps.StreetNumber = String(d.numero).slice(0, 10);

  const r = await gls(env, "/parcelshop/address", corps);
  if (!r.ok) return { ok: false, etape: "parcelshop", httpStatus: r.status, error: litErreur(r), envoye: corps };

  const bruts: any[] = r.data?.ParcelShop || [];
  const tous = bruts.map(normShop);
  // On écarte les points bientôt fermés, sauf demande explicite du contraire.
  const retenus = (p.tousLesPoints ? tous : tous.filter((s) => !s.fermeBientot))
    .sort((a, b) => (a.distanceKm ?? 999) - (b.distanceKm ?? 999));

  return {
    ok: true,
    env,
    rayonKm: Number(p.rayon) || 20,
    trouves: tous.length,
    ecartesFermeture: tous.length - retenus.length,
    relais: retenus,
  };
}

// ---------------------------------------------------------------------------
// L'EXPÉDITEUR. Ce qui s'imprime sur l'étiquette et ce que GLS reprend dans
// ses SMS et mails au client.
// ---------------------------------------------------------------------------
const EXPEDITEUR = {
  Name1: "SELECT",
  Street: "2 rue de Paris",
  ZIPCode: "03200",
  City: "Vichy",
  CountryCode: "FR",
};

/* Le téléphone au format GLS : « 0033612345678 ». Un « 06 12 34 56 78 » saisi
   normalement ne déclencherait jamais le SMS de livraison — et on ne s'en
   apercevrait que par les réclamations. */
function telGLS(brut: unknown, pays?: string): string {
  let s = String(brut == null ? "" : brut).replace(/[^\d+]/g, "");
  if (!s) return "";
  if (s.slice(0, 1) === "+") return "00" + s.slice(1);
  if (s.slice(0, 2) === "00") return s;
  if (s.slice(0, 1) === "0") {
    const ind: Record<string, string> = { FR: "0033", BE: "0032", ES: "0034", IT: "0039",
      DE: "0049", PT: "00351", NL: "0031", LU: "00352", IE: "00353" };
    const i = ind[String(pays || "FR").toUpperCase()];
    if (i) return i + s.slice(1);
  }
  return s;
}

/* Minimum 0,1 kg chez GLS, et deux décimales. Une virgule française passe. */
function poidsGLS(x: unknown): string {
  let n = parseFloat(String(x == null ? "" : x).replace(",", "."));
  if (!isFinite(n) || n < 0.1) n = 0.1;
  if (n > 99999) n = 99999;
  return n.toFixed(2);
}

/* On dit en FRANÇAIS ce qui manque, AVANT d'appeler. GLS refuserait de toute
   façon, mais dans le langage de son schéma
   (« Shipment.Consignee.Address.eMail »), que personne ne lit au moment où on
   a le colis en main. */
const OBLIGATOIRES: Array<[string, string]> = [
  ["nom", "Nom du destinataire"], ["rue", "Rue"], ["cp", "Code postal"],
  ["ville", "Ville"], ["pays", "Pays"], ["email", "E-mail"], ["tel", "Téléphone mobile"],
];
function manquants(d: any): string[] {
  return OBLIGATOIRES.filter((c) => !String((d || {})[c[0]] || "").trim()).map((c) => c[1]);
}

// Jeu d'essai, pour valider l'aller-retour sans dépendre d'une vraie commande.
const ESSAI = {
  reference: "TEST-ERP",
  destinataire: { nom: "Marc Dubois", rue: "14 rue des Lilas", cp: "69003",
    ville: "Lyon", pays: "FR", email: "test@wathe.fr", tel: "06 12 34 56 78" },
  colis: [{ poids: 2 }],
};

// ---------------------------------------------------------------------------
// Action : label — éditer les étiquettes d'une expédition.
//
// UNE expédition = UNE adresse = N colis = N étiquettes, en UN seul appel.
// C'est exactement le modèle de l'ERP, où les paires partageant un numéro de
// suivi forment un colis.
//
// LE POINT DÉLICAT, et c'est la famille de bug de la commande #8167 : GLS rend
// les étiquettes dans l'ORDRE des unités envoyées. Cet ordre ne se recalcule
// pas après coup, il se fige à l'appel. On glisse en plus un repère neutre
// (« C1 », « C2 ») dans la référence d'unité, que GLS réémet : la concordance
// est donc VÉRIFIÉE, pas supposée. Le repère ne dit rien du contenu — pas de
// nom de produit sur l'étiquette, les livreurs n'ont pas à savoir.
// ---------------------------------------------------------------------------
async function doLabel(p: any) {
  const env = envOf(p.env);
  if (!CID || !CSEC) return { ok: false, etape: "secrets", error: "Secrets GLS absents." };
  if (!CONTACT) return { ok: false, etape: "secrets", error: "GLS_CONTACT_ID absent." };

  /* Le jeu d'essai accepte qu'on lui impose le service et le relais : on peut
     ainsi tester le point relais sans inventer une commande. */
  const src = p.test
    ? { ...ESSAI, ...(p.reference ? { reference: p.reference } : {}),
        ...(p.service ? { service: p.service } : {}),
        ...(p.parcelShopId ? { parcelShopId: p.parcelShopId } : {}),
        ...(p.colis ? { colis: p.colis } : {}) }
    : p;
  const d = src.destinataire || {};
  const colis = Array.isArray(src.colis) && src.colis.length ? src.colis : [{ poids: 2 }];
  const ref = String(src.reference || "").trim().slice(0, 20);
  if (!ref) return { ok: false, etape: "reference", error: "Référence de commande absente." };

  const trous = manquants(d);
  if (trous.length)
    return { ok: false, etape: "champs", manquants: trous,
      error: "Impossible d'éditer l'étiquette, il manque : " + trous.join(", ") + "." };

  /* Deux services : domicile et point relais. Chacun porte un nom de nœud
     DIFFÉRENT dans le JSON GLS — « Service » pour le domicile, « ShopDelivery »
     pour le relais. Se tromper de nœud fait refuser toute la requête. */
  const service = String(src.service || "flexdelivery");
  if (service !== "flexdelivery" && service !== "shopdelivery")
    return { ok: false, etape: "service", error: "Service inconnu : " + service + "." };

  const relais = String(src.parcelShopId || "").trim();
  if (service === "shopdelivery" && !relais)
    return { ok: false, etape: "relais",
      error: "Aucun point relais choisi. Cherche-le d'abord avec l'action « parcelshops »." };

  const noeudService = service === "shopdelivery"
    ? { ShopDelivery: { ServiceName: "service_shopdelivery", ParcelShopID: relais } }
    : { Service: { ServiceName: "service_flexdelivery" } };

  const pays = String(d.pays || "FR").toUpperCase().slice(0, 2);
  /* Note1 et Note2 s'impriment dans le bloc du MILIEU de l'étiquette, bien
     plus lisibles que la ligne « References » en petits caractères du bas.
     Quand on cherche une commande dans une pile de colis, c'est là qu'on
     regarde. Le numéro de commande et le rang du colis ne disent toujours
     rien du contenu : la règle « pas de produit sur l'étiquette » tient. */
  const nbColis = colis.length;
  const unites = colis.map((c: any, i: number) => {
    const u: any = {
      ShipmentUnitReference: [ref, "C" + (i + 1)],
      Weight: poidsGLS(c && c.poids),
      Note1: ("Commande " + ref).slice(0, 42),
    };
    if (nbColis > 1) u.Note2 = ("Colis " + (i + 1) + " sur " + nbColis).slice(0, 42);
    return u;
  });

  const corps = {
    Shipment: {
      ShipmentReference: [ref],
      Middleware: "ERP WATHE",
      Product: "PARCEL",
      Consignee: {
        Address: {
          Name1: String(d.nom).slice(0, 35),
          Name2: String(d.nom2 || "").slice(0, 35),
          CountryCode: pays,
          ZIPCode: String(d.cp).slice(0, 10),
          City: String(d.ville).slice(0, 35),
          Street: String(d.rue).slice(0, 35),
          eMail: String(d.email).slice(0, 80),
          MobilePhoneNumber: telGLS(d.tel, pays),
          // Obligatoire en point relais : c'est le nom présenté au comptoir.
          ContactPerson: service === "shopdelivery"
            ? String(d.contact || d.nom).slice(0, 35) : undefined,
        },
      },
      Shipper: { ContactID: CONTACT, AlternativeShipperAddress: EXPEDITEUR },
      ShipmentUnit: unites,
      Service: [noeudService],
    },
    PrintingOptions: { ReturnLabels: { TemplateSet: "NONE", LabelFormat: "PDF" } },
  };

  const r = await gls(env, "/shipments", corps);
  if (!r.ok) return { ok: false, etape: "shipments", httpStatus: r.status, error: litErreur(r), envoye: corps };

  const cree = r.data?.CreatedShipment || {};
  const parcels: any[] = cree.ParcelData || [];
  const prints: any[] = cree.PrintData || [];
  if (!parcels.length)
    return { ok: false, etape: "reponse", error: "GLS a répondu sans aucune étiquette.", recu: r.data };

  /* On apparie par POSITION — c'est le contrat de l'API — puis on VÉRIFIE
     avec le repère que GLS nous réémet. Une discordance ne s'avale pas en
     silence : elle remonte, et l'ERP n'écrira rien. */
  let discordance = false;
  const etiquettes = parcels.map((pc: any, i: number) => {
    const attendu = "C" + (i + 1);
    const recu = (pc.ShipmentUnitReference || [])[1] || "";
    if (recu && recu !== attendu) discordance = true;
    // Une étiquette par colis quand GLS en rend autant ; sinon le PDF unique.
    const pr = prints.length === parcels.length ? prints[i] : (prints[0] || {});
    return {
      colis: i + 1,
      trackId: pc.TrackID || pc.ParcelNumber || "",
      repere: recu,
      concorde: !recu || recu === attendu,
      poids: unites[i] ? unites[i].Weight : "",
      pdf: pr.Data || "",
    };
  });

  if (discordance)
    return { ok: false, etape: "concordance", etiquettes,
      error: "GLS n'a pas rendu les étiquettes dans l'ordre demandé. Rien n'a été enregistré — "
        + "à signaler, c'est anormal." };

  return {
    ok: true,
    env,
    reference: ref,
    service,
    parcelShopId: relais || null,
    pdfUnique: prints.length === 1 && parcels.length > 1,
    trackIds: etiquettes.map((e) => e.trackId),
    etiquettes,
  };
}

// ---------------------------------------------------------------------------
// Action : cancelparcel — annuler une étiquette avant la clôture.
//
// Une étiquette éditée par erreur n'est pas un drame tant que le colis n'est
// pas scanné (« not scanned = not invoiced », dit la doc), mais on l'annule
// proprement pour que GLS n'attende pas un colis fantôme.
// ---------------------------------------------------------------------------
async function doCancelParcel(p: any) {
  const env = envOf(p.env);
  const id = String(p.trackId || "").trim();
  if (!id) return { ok: false, etape: "trackid", error: "Numéro de suivi absent." };

  const r = await gls(env, "/shipments/cancel/" + encodeURIComponent(id), undefined);
  if (!r.ok) return { ok: false, etape: "cancel", httpStatus: r.status, error: litErreur(r) };

  /* GLS répond « CANCELLATION_PENDING » : l'annulation est prise, pas encore
     effective. On le dit tel quel plutôt que d'affirmer qu'elle est faite. */
  const res = String(r.data?.result || "");
  return { ok: true, env, trackId: r.data?.TrackID || id, resultat: res,
    enCours: /PENDING/i.test(res) };
}

// ---------------------------------------------------------------------------
// Action : endofday — la clôture de journée.
//
// Ce n'est pas une formalité : c'est elle qui déclare les colis prêts à GLS,
// et SANS elle la recherche de colis par date ne répond pas. Elle peut être
// lancée plusieurs fois par jour pour séparer les vagues de préparation.
// ---------------------------------------------------------------------------
async function doEndOfDay(p: any) {
  const env = envOf(p.env);
  const d = String(p.date || "").trim() || new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d))
    return { ok: false, etape: "date", error: "Date attendue au format AAAA-MM-JJ." };

  const r = await gls(env, "/shipments/endofday?date=" + d, undefined);
  if (!r.ok) return { ok: false, etape: "endofday", httpStatus: r.status, error: litErreur(r) };
  return { ok: true, env, date: d, rapport: r.data ?? null };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const action = body.action || "debug";

    if (action === "debug") return json(await doDebug(body));
    if (action === "label") return json(await doLabel(body));
    if (action === "parcelshops") return json(await doShops(body));
    if (action === "cancelparcel") return json(await doCancelParcel(body));
    if (action === "endofday") return json(await doEndOfDay(body));

    return json({ ok: false, error: "action inconnue ou pas encore déployée : " + action });
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message || e) }, 500);
  }
});
