#!/usr/bin/env node
/* ============================================================================
   RELAIS TWS — donne une adresse IP fixe aux appels vers la caisse Rezomatic
   ----------------------------------------------------------------------------
   Pourquoi il existe : depuis la version 3.0.2 du Web Service, TWS n'accepte
   que les adresses IP déclarées par TGM. Nos fonctions Supabase sortent d'un
   pool d'adresses qui change à chaque appel — une sur deux était refusée avec
   « ... invalide pour se connecter à T.W.S. ».

   Ce service tourne sur une machine à IP fixe. TGM n'a donc plus qu'UNE adresse
   à déclarer, une fois pour toutes. Les fonctions Supabase ne changent pas : il
   suffit de pointer REZOMATIC_ENDPOINT ici au lieu de TWS.

   Il est volontairement bête : il recopie le corps et l'en-tête SOAPAction, et
   rend la réponse telle quelle. Aucune intelligence, donc rien à maintenir
   quand le Web Service évolue.

   ---- CE QU'IL NE FAIT PAS, ET POURQUOI -------------------------------------
   · Il ne relaie QUE vers TWS_URL, jamais vers une adresse fournie par
     l'appelant. Un relais qui accepte une destination arbitraire est un proxy
     ouvert : on le trouve en quelques heures et on s'en sert pour attaquer des
     tiers depuis notre IP.
   · Il n'écrit JAMAIS le corps des requêtes dans ses journaux. Chaque appel
     contient le SESSIONID de la caisse en clair ; le journaliser reviendrait à
     déposer la clef sur le paillasson.
   ========================================================================== */

const http = require("http");

const TWS_URL = process.env.TWS_URL
  || "https://wathe.rezomatic.com/soap/rezomaticSoapServer.php";
const CHEMIN  = process.env.RELAIS_CHEMIN || "";   // segment secret de l'URL
const PORT    = parseInt(process.env.PORT || "8787", 10);
const DELAI   = parseInt(process.env.TIMEOUT_MS || "30000", 10);
const TAILLE_MAX = 2 * 1024 * 1024;                // 2 Mo : large pour du SOAP

if (!CHEMIN || CHEMIN.length < 24) {
  console.error("RELAIS_CHEMIN manquant ou trop court (24 caractères minimum).");
  console.error("Génère-le avec :  openssl rand -hex 24");
  process.exit(1);
}

/* Horodatage court, sans le corps : on veut savoir QUE ça a transité et avec
   quel résultat, jamais CE qui a transité. */
const log = (...a) => console.log(new Date().toISOString().slice(0, 19), ...a);

const serveur = http.createServer((req, res) => {
  const url = new URL(req.url, "http://local");

  // Sonde de vie, sans secret : sert à vérifier que le service tourne.
  if (req.method === "GET" && url.pathname === "/sante") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, service: "relais-tws" }));
  }

  /* Le secret est dans le chemin plutôt que dans un en-tête : c'est ce qui
     permet aux fonctions Supabase de l'utiliser SANS modification — elles ne
     savent envoyer qu'une URL. Comparaison à longueur constante pour ne pas
     laisser deviner le secret caractère par caractère. */
  const attendu = "/" + CHEMIN;
  if (req.method !== "POST" || !egal(url.pathname, attendu)) {
    log("refus", req.method, url.pathname.slice(0, 12) + "…");
    res.writeHead(404, { "Content-Type": "text/plain" });
    return res.end("not found");
  }

  const morceaux = [];
  let taille = 0;
  req.on("data", (c) => {
    taille += c.length;
    if (taille > TAILLE_MAX) { req.destroy(); return; }
    morceaux.push(c);
  });
  req.on("error", () => { /* client parti : rien à faire */ });
  req.on("end", async () => {
    const corps = Buffer.concat(morceaux);
    if (!corps.length) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      return res.end("corps vide");
    }
    const t0 = Date.now();
    const ctrl = new AbortController();
    const minuteur = setTimeout(() => ctrl.abort(), DELAI);
    try {
      const amont = await fetch(TWS_URL, {
        method: "POST",
        headers: {
          "Content-Type": req.headers["content-type"] || "text/xml; charset=utf-8",
          // SOAPAction désigne la méthode appelée : la perdre casse tout.
          "SOAPAction": req.headers["soapaction"] || "",
        },
        body: corps,
        signal: ctrl.signal,
      });
      const texte = await amont.text();
      log("ok", amont.status, (Date.now() - t0) + "ms", texte.length + "o");
      res.writeHead(amont.status, {
        "Content-Type": amont.headers.get("content-type") || "text/xml; charset=utf-8",
      });
      res.end(texte);
    } catch (e) {
      /* Une panne du relais ne doit pas ressembler à une panne de la caisse :
         on renvoie 502 avec un motif lisible, que les fonctions font remonter. */
      const motif = (e && e.name === "AbortError")
        ? "délai dépassé vers TWS (" + DELAI + " ms)"
        : String((e && e.message) || e);
      log("ECHEC", motif);
      res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("relais : " + motif);
    } finally {
      clearTimeout(minuteur);
    }
  });
});

/* Comparaison insensible au temps : une comparaison ordinaire s'arrête au
   premier caractère différent, ce qui laisse mesurer le secret. */
function egal(a, b) {
  const A = Buffer.from(String(a)), B = Buffer.from(String(b));
  if (A.length !== B.length) return false;
  return require("crypto").timingSafeEqual(A, B);
}

serveur.listen(PORT, () => {
  log("relais-tws à l'écoute sur le port " + PORT);
  log("destination :", TWS_URL);
  log("chemin secret : /" + CHEMIN.slice(0, 4) + "…" + " (" + CHEMIN.length + " caractères)");
});
