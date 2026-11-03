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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const action = body.action || "debug";

    if (action === "debug") return json(await doDebug(body));

    // L'édition d'étiquette arrive à la prochaine version, une fois le
    // diagnostic au vert. On ne déploie pas un geste qui engage de l'argent
    // avant d'être sûr du chemin.
    return json({ ok: false, error: "action inconnue ou pas encore déployée : " + action });
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message || e) }, 500);
  }
});
