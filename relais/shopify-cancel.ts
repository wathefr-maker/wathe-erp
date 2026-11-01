// Supabase Edge Function : shopify-cancel
//
// ANNULER UNE COMMANDE SHOPIFY DEPUIS L'ERP.
//
// La fenêtre d'annulation de l'ERP promettait déjà « l'annulation côté
// Shopify sera poussée automatiquement » — et rien ne le faisait. La commande
// restait ouverte et payée sur la boutique pendant que l'ERP la disait
// annulée, ses paires remises en stock et sa facture supprimée.
//
// Fonction à part, comme shopify-refund : on ne mélange pas les gestes qui
// engagent de l'argent avec la synchro produit de shopify-write.
//
// Shopify refuse d'annuler une commande déjà expédiée, et c'est tant mieux :
// c'est un retour qu'il faut faire, pas une annulation. La fonction rend
// alors un motif lisible plutôt qu'une erreur brute, pour que l'ERP puisse
// renvoyer vers le bon geste.
//
// API Admin GraphQL 2026-01. Authentification : client_credentials (jeton 24h).

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SHOP = Deno.env.get("SHOPIFY_SHOP");
const CID  = Deno.env.get("SHOPIFY_CLIENT_ID");
const CSEC = Deno.env.get("SHOPIFY_CLIENT_SECRET");
const API_VERSION = "2026-01";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });

let _tok: string | null = null;
let _tokExp = 0;
async function getToken(force = false): Promise<string> {
  const now = Date.now();
  if (!force && _tok && now < _tokExp) return _tok;
  const r = await fetch(`https://${SHOP}.myshopify.com/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: CID, client_secret: CSEC, grant_type: "client_credentials" }),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.access_token) throw new Error("token: " + JSON.stringify(j));
  _tok = j.access_token;
  _tokExp = now + (j.expires_in ? (j.expires_in - 60) * 1000 : 23 * 3600 * 1000);
  return _tok;
}

async function gql(query: string, variables?: unknown): Promise<any> {
  const call = async (tok: string) =>
    fetch(`https://${SHOP}.myshopify.com/admin/api/${API_VERSION}/graphql.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": tok },
      body: JSON.stringify({ query, variables }),
    });
  let tok = await getToken();
  let r = await call(tok);
  if (r.status === 401) { tok = await getToken(true); r = await call(tok); }
  return await r.json().catch(() => ({ errors: [{ message: "réponse illisible (HTTP " + r.status + ")" }] }));
}

/* Les refus de Shopify sont exacts mais muets sur la suite à donner. On les
   traduit en disant QUOI FAIRE, parce que c'est la seule chose utile au
   moment où l'on tient le client au téléphone. */
function litErreur(x: any): string {
  const s = JSON.stringify(x || "");
  if (/access denied|not approved|requires.*scope/i.test(s))
    return "Shopify refuse l'opération : l'application n'a pas l'autorisation "
      + "« write_orders ». Réponse de Shopify : " + s;
  if (/fulfilled|fulfillment/i.test(s))
    return "Shopify refuse d'annuler cette commande : elle est déjà expédiée, "
      + "en tout ou en partie. Une commande partie se traite en RETOUR, pas en "
      + "annulation. Réponse de Shopify : " + s;
  if (/already.*cancel|cancelled/i.test(s))
    return "Cette commande est déjà annulée sur Shopify. Réponse : " + s;
  if (/return/i.test(s))
    return "Shopify refuse d'annuler : un retour est en cours sur cette "
      + "commande. Termine-le d'abord. Réponse : " + s;
  return s;
}

const RAISONS = ["CUSTOMER", "DECLINED", "FRAUD", "INVENTORY", "OTHER", "STAFF"];

// ---------------------------------------------------------------------------
// Action : annuler
//
//   orderId   identifiant Shopify de la commande
//   reason    CUSTOMER | DECLINED | FRAUD | INVENTORY | OTHER | STAFF
//   refund    true = rendre l'argent déjà encaissé
//   restock   true = Shopify réintègre les paires
//   notify    true = Shopify envoie son mail d'annulation
//   note      note interne, invisible du client (255 caractères max)
//
// Une autorisation simplement bloquée (paiement non capturé) est libérée par
// Shopify quelle que soit la valeur de refund : c'est son comportement, pas
// une décision de l'ERP, et il vaut mieux le savoir que le découvrir.
// ---------------------------------------------------------------------------
async function doCancel(p: any) {
  if (!p.orderId) return { ok: false, error: "orderId manquant" };
  const orderGID = String(p.orderId).startsWith("gid://")
    ? String(p.orderId) : `gid://shopify/Order/${p.orderId}`;
  const reason = RAISONS.indexOf(String(p.reason || "").toUpperCase()) >= 0
    ? String(p.reason).toUpperCase() : "STAFF";

  /* On regarde d'abord dans quel état est la commande. Shopify refuserait de
     toute façon, mais son message parle de « fulfillment orders » : ici on
     peut dire « elle est déjà expédiée » avant même d'essayer. */
  const oj = await gql(
    `query($id:ID!){
       order(id:$id){
         id name cancelledAt
         displayFulfillmentStatus displayFinancialStatus
         totalPriceSet{ shopMoney{ amount currencyCode } }
         totalRefundedSet{ shopMoney{ amount } }
       }
     }`,
    { id: orderGID },
  );
  if (oj.errors) return { ok: false, step: "order", error: litErreur(oj.errors) };
  const order = oj?.data?.order;
  if (!order) return { ok: false, error: "commande introuvable sur Shopify" };
  if (order.cancelledAt)
    return { ok: false, dejaAnnulee: true,
      error: "Cette commande est déjà annulée sur Shopify (le " + String(order.cancelledAt).slice(0, 10) + ")." };
  const ful = String(order.displayFulfillmentStatus || "");
  if (ful === "FULFILLED" || ful === "PARTIALLY_FULFILLED")
    return { ok: false, expediee: true,
      error: "Commande déjà expédiée" + (ful === "PARTIALLY_FULFILLED" ? " en partie" : "")
        + " : Shopify n'annule pas une commande partie. Fais un RETOUR à la place — "
        + "les paires reviennent en stock et le client est remboursé." };

  const variables: any = {
    id: orderGID,
    reason,
    restock: p.restock !== false,
    notify: p.notify !== false,
  };
  if (p.note) variables.note = String(p.note).slice(0, 255);
  /* refundMethod est un « oneOf » : on le passe seulement quand on rembourse.
     L'omettre vaut « ne rends rien », ce qui est bien ce qu'on veut sinon. */
  if (p.refund) variables.refundMethod = { originalPaymentMethodsRefund: true };

  /* ON NE DEMANDE QUE job ET orderCancelUserErrors, et c'est tout.
     OrderCancelPayload n'a pas de champ userErrors, contrairement à la
     plupart des mutations. Il n'a pas non plus de jobResult sur la version
     servie à cette boutique : le demander faisait rejeter TOUTE la requête
     avant exécution — « Field 'jobResult' doesn't exist ». La documentation
     du schéma le listait pourtant ; c'est la boutique qui tranche, pas la
     documentation.
     On n'essaie donc plus de deviner si la tâche est finie à partir de la
     réponse : on va le DEMANDER à la commande juste après, ce qui marche
     quelle que soit la version.

     Et on ne demande plus que ce dont on se sert VRAIMENT — ni job.done, ni
     le code d'erreur. Chaque champ réclamé est une façon de plus de voir la
     requête entière rejetée sur une version qui ne le connaît pas, et aucun
     de ces deux-là ne changeait quoi que ce soit à ce qu'on fait ensuite.

     Le commentaire est ici et pas dans la requête : GraphQL ne connaît que
     le dièse. */
  const cj = await gql(
    `mutation($id:ID!,$reason:OrderCancelReason!,$restock:Boolean!,$notify:Boolean,
              $note:String,$refundMethod:OrderCancelRefundMethodInput){
       orderCancel(orderId:$id, reason:$reason, restock:$restock,
                   notifyCustomer:$notify, staffNote:$note, refundMethod:$refundMethod){
         job{ id }
         orderCancelUserErrors{ field message }
       }
     }`,
    variables,
  );
  if (cj.errors) return { ok: false, step: "orderCancel", error: litErreur(cj.errors) };
  const oc = cj?.data?.orderCancel || {};
  const ue = oc.orderCancelUserErrors || [];
  if (ue.length) return { ok: false, step: "orderCancel", userErrors: ue, error: litErreur(ue) };

  /* Shopify annule en tâche de fond : la commande n'est pas forcément annulée
     à la seconde où il répond. On relit donc la commande pour savoir où on en
     est, plutôt que de l'affirmer. Une seule relecture, après un court
     battement : si ce n'est pas encore fait, ça le sera dans la minute, et
     l'ERP le dit ainsi au lieu de prétendre le contraire. */
  let annuleeLe: string | null = null;
  let finance: string | null = null;
  try {
    await new Promise((r) => setTimeout(r, 1200));
    const vj = await gql(
      `query($id:ID!){ order(id:$id){ cancelledAt displayFinancialStatus } }`,
      { id: orderGID },
    );
    annuleeLe = vj?.data?.order?.cancelledAt || null;
    finance = vj?.data?.order?.displayFinancialStatus || null;
  } catch (_) { /* la relecture est un confort, pas une condition */ }
  /* La relecture fait foi : c'est la commande elle-même qui dit si elle est
     annulée, pas une promesse de tâche. */
  const fini = !!annuleeLe;
  return {
    ok: true,
    jobId: oc.job?.id || null,
    enCours: !fini,
    fini,
    annuleeLe,
    financialStatus: finance,
    reason,
    rembourse: !!p.refund,
    restock: p.restock !== false,
    montant: Number(order.totalPriceSet?.shopMoney?.amount || 0),
    devise: order.totalPriceSet?.shopMoney?.currencyCode || "EUR",
    dejaRembourse: Number(order.totalRefundedSet?.shopMoney?.amount || 0),
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    if (!SHOP || !CID || !CSEC)
      return json({ ok: false, error: "secrets Shopify manquants (SHOPIFY_SHOP / CLIENT_ID / CLIENT_SECRET)" });
    const body = await req.json().catch(() => ({}));
    const action = body.action || "debug";

    if (action === "debug") {
      let scopes: string[] = [];
      try {
        const j = await gql(`{ currentAppInstallation{ accessScopes{ handle } } }`);
        scopes = (j?.data?.currentAppInstallation?.accessScopes || []).map((s: any) => s.handle);
      } catch (_) { /* ignore */ }
      const peut = scopes.some((s) => /^write_orders$/.test(s));
      return json({ ok: true, shop: SHOP, apiVersion: API_VERSION, scopes, canCancel: peut,
        hint: peut ? "" : "L'autorisation « write_orders » manque : les annulations seront refusées." });
    }
    if (action === "cancel") return json(await doCancel(body));
    return json({ ok: false, error: "action inconnue : " + action });
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message || e) });
  }
});
