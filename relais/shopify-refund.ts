// Supabase Edge Function : shopify-refund
//
// REMBOURSER UNE COMMANDE SHOPIFY DEPUIS L'ERP.
//
// Jusqu'ici l'ERP faisait tout le retour — remise en stock, avoir, pénalité,
// resynchro du catalogue — sauf rendre l'argent : la fenêtre de retour disait
// elle-même « le remboursement Shopify reste à faire manuellement ». La
// commande restait donc « Payé » alors que le client avait été remboursé, et
// la comptabilité Shopify ne correspondait plus à celle de l'ERP.
//
// Fonction SÉPARÉE de shopify-write, volontairement : cette dernière fait
// tourner la synchro produit de toute la boutique. On ne mélange pas un geste
// qui déplace de l'argent avec le code qui publie les tailles.
//
// Elle partage ses secrets avec shopify-write (même projet Supabase) et vise
// donc la MÊME boutique. La boutique SBT a ses propres secrets et n'est pas
// couverte ici.
//
// API Admin GraphQL 2026-01. Authentification : client_credentials (jeton 24h).

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SHOP = Deno.env.get("SHOPIFY_SHOP");
const CID  = Deno.env.get("SHOPIFY_CLIENT_ID");
const CSEC = Deno.env.get("SHOPIFY_CLIENT_SECRET");
const LOC_ID_RAW = Deno.env.get("SHOPIFY_LOCATION_ID");
const API_VERSION = "2026-01";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const r2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

// ---- Jeton (client credentials), mis en cache ----
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

let _loc: string | null = null;
async function getLocation(): Promise<string | null> {
  if (_loc) return _loc;
  if (LOC_ID_RAW) {
    _loc = LOC_ID_RAW.startsWith("gid://") ? LOC_ID_RAW : `gid://shopify/Location/${LOC_ID_RAW}`;
    return _loc;
  }
  const j = await gql(`{ locations(first:10){ nodes{ id } } }`);
  const n = j?.data?.locations?.nodes?.[0];
  _loc = n ? n.id : null;
  return _loc;
}

/* Une autorisation manquante se lit mal dans la réponse brute de Shopify :
   « Access denied for refundCreate field » n'apprend pas QUOI ajouter. On
   traduit, en nommant l'autorisation, parce que c'est l'information utile. */
function litErreur(x: any): string {
  const s = JSON.stringify(x || "");
  if (/access denied|not approved|requires.*scope/i.test(s)) {
    return "Shopify refuse l'opération : l'application personnalisée n'a pas "
      + "l'autorisation « write_orders ». Ajoute-la dans Shopify → Paramètres → "
      + "Applications → ton application → Configuration → Admin API, puis "
      + "réinstalle l'application. Réponse de Shopify : " + s;
  }
  return s;
}

const norm = (x: any) => String(x == null ? "" : x).trim().toLowerCase();

// ---------------------------------------------------------------------------
// Action : rembourser
//
// Entrée :
//   orderId        identifiant Shopify de la commande
//   lines          [{ sku, quantity }] — les lignes retournées
//   shippingAmount port remboursé (0 si aucun)
//   amount         CE QUI PART VRAIMENT du compte, pénalité déduite
//   restock        true = la paire revient en stock, false = colis perdu
//   notify         true = Shopify envoie son mail de remboursement
//   note           ce qui s'affichera sur la commande Shopify
//
// Le montant et l'allocation sont deux choses différentes, et c'est ce qui
// permet la pénalité : refundLineItems + shipping disent CE QUI est rendu,
// transactions[].amount dit COMBIEN part. Quand le second est plus petit,
// Shopify crée un ajustement de commande pour l'écart — exactement ce qu'est
// une pénalité de retour, et elle apparaît comme telle dans ses rapports.
// ---------------------------------------------------------------------------
async function doRefund(p: any) {
  if (!p.orderId) return { ok: false, error: "orderId manquant" };
  const orderGID = String(p.orderId).startsWith("gid://")
    ? String(p.orderId) : `gid://shopify/Order/${p.orderId}`;

  const montant = r2(p.amount);
  if (!(montant > 0)) return { ok: false, error: "montant à rembourser nul" };
  const port = r2(p.shippingAmount);
  const restock = p.restock !== false;

  // 1) La commande, ses lignes et ce qui reste remboursable sur chacune.
  const oj = await gql(
    `query($id:ID!){
       order(id:$id){
         id name currencyCode
         displayFinancialStatus
         totalRefundedSet{ shopMoney{ amount } }
         lineItems(first:100){ nodes{ id sku quantity refundableQuantity } }
       }
     }`,
    { id: orderGID },
  );
  if (oj.errors) return { ok: false, step: "order", error: litErreur(oj.errors) };
  const order = oj?.data?.order;
  if (!order) return { ok: false, error: "commande introuvable sur Shopify" };

  // 2) Nos SKU -> lignes de la commande, dans la limite du remboursable.
  const want = new Map<string, number>();
  for (const li of (Array.isArray(p.lines) ? p.lines : [])) {
    const k = norm(li?.sku);
    if (!k) continue;
    want.set(k, (want.get(k) || 0) + (Number.isFinite(+li?.quantity) ? +li.quantity : 1));
  }
  const refundLineItems: any[] = [];
  const unmatched: string[] = [];
  const loc = restock ? await getLocation() : null;
  for (const n of (order.lineItems?.nodes || [])) {
    const k = norm(n.sku);
    const need = want.get(k) || 0;
    if (!k || need <= 0) continue;
    const dispo = Number.isFinite(+n.refundableQuantity) ? +n.refundableQuantity : 0;
    if (dispo <= 0) continue;
    const take = Math.min(need, dispo);
    const item: any = { lineItemId: n.id, quantity: take, restockType: restock ? "RETURN" : "NO_RESTOCK" };
    if (restock && loc) item.locationId = loc;
    refundLineItems.push(item);
    want.set(k, need - take);
  }
  for (const [sku, reste] of want) if (reste > 0) unmatched.push(sku + " ×" + reste);

  if (!refundLineItems.length && !(port > 0)) {
    return { ok: false, error: "aucune ligne remboursable trouvée sur la commande "
      + (order.name || "") + " (déjà remboursée ?)", unmatched };
  }

  // 3) Le remboursement suggéré par Shopify. On ne s'en sert PAS pour le
  //    montant — c'est l'ERP qui le décide — mais pour deux choses qu'on ne
  //    peut pas inventer : sur quelle transaction d'origine imputer le
  //    remboursement, et par quelle passerelle. Et pour le plafond.
  const sj = await gql(
    `query($id:ID!,$li:[RefundLineItemInput!],$ship:Money){
       order(id:$id){
         suggestedRefund(refundLineItems:$li, shippingAmount:$ship){
           amountSet{ shopMoney{ amount currencyCode } }
           maximumRefundableSet{ shopMoney{ amount } }
           suggestedTransactions{
             kind gateway
             amountSet{ shopMoney{ amount } }
             maximumRefundableSet{ shopMoney{ amount } }
             parentTransaction{ id }
           }
         }
       }
     }`,
    {
      id: orderGID,
      li: refundLineItems.map((x) => ({ lineItemId: x.lineItemId, quantity: x.quantity })),
      ship: port > 0 ? String(port) : "0",
    },
  );
  if (sj.errors) return { ok: false, step: "suggestedRefund", error: litErreur(sj.errors), unmatched };
  const sug = sj?.data?.order?.suggestedRefund;
  if (!sug) return { ok: false, error: "Shopify n'a pas su calculer le remboursement de cette commande.", unmatched };

  const maxi = r2(sug.maximumRefundableSet?.shopMoney?.amount);
  if (montant > maxi + 0.005) {
    return { ok: false, error: "montant trop élevé : " + montant + " € demandés alors que "
      + "Shopify n'autorise que " + maxi + " € sur cette commande (déjà remboursée en partie ?).",
      maximumRefundable: maxi, unmatched };
  }

  // 4) Répartir CE QU'ON REND sur les transactions d'origine. Un seul paiement
  //    dans la quasi-totalité des cas ; la boucle existe pour les commandes
  //    réglées en deux fois, où il faut rendre à chaque moyen de paiement sans
  //    dépasser ce qu'il a encaissé.
  const sugTx = (sug.suggestedTransactions || []).filter((t: any) => t && t.parentTransaction?.id);
  if (!sugTx.length) {
    return { ok: false, error: "aucune transaction à rembourser sur cette commande "
      + "(paiement non capturé, ou réglé hors Shopify). Le remboursement doit se faire "
      + "par le moyen d'origine.", unmatched };
  }
  const transactions: any[] = [];
  let reste = montant;
  for (const t of sugTx) {
    if (reste <= 0.005) break;
    const plafond = r2(t.maximumRefundableSet?.shopMoney?.amount ?? t.amountSet?.shopMoney?.amount);
    const part = r2(Math.min(reste, plafond > 0 ? plafond : reste));
    if (part <= 0.005) continue;
    transactions.push({
      orderId: orderGID,
      parentId: t.parentTransaction.id,
      gateway: t.gateway || "manual",
      kind: "REFUND",
      amount: String(part),
    });
    reste = r2(reste - part);
  }
  if (reste > 0.005) {
    return { ok: false, error: "impossible de rendre " + montant + " € : les paiements "
      + "d'origine n'en couvrent que " + r2(montant - reste) + " €.", unmatched };
  }

  // 5) Le remboursement.
  const input: any = {
    orderId: orderGID,
    notify: p.notify !== false,
    refundLineItems,
    transactions,
  };
  if (port > 0) input.shipping = { amount: String(port) };
  if (p.note) input.note = String(p.note).slice(0, 500);
  /* L'écart entre ce qui est rendu et ce qui est imputé — la pénalité de
     retour — devient un ajustement de commande. On le qualifie, sinon il
     apparaît comme « autre » dans les rapports de Shopify. */
  /* amountSet est déjà le total suggéré, port compris : le découper en deux
     cas revenait à compter le port deux fois quand il y avait des lignes. */
  const alloue = r2(sug.amountSet?.shopMoney?.amount);
  if (alloue - montant > 0.005) input.discrepancyReason = "CUSTOMER";

  const rj = await gql(
    `mutation($input:RefundInput!){
       refundCreate(input:$input){
         refund{ id totalRefundedSet{ shopMoney{ amount currencyCode } } }
         order{ id displayFinancialStatus }
         userErrors{ field message }
       }
     }`,
    { input },
  );
  if (rj.errors) return { ok: false, step: "refundCreate", error: litErreur(rj.errors), unmatched };
  const ue = rj?.data?.refundCreate?.userErrors || [];
  if (ue.length) return { ok: false, step: "refundCreate", userErrors: ue, error: litErreur(ue), unmatched };

  const ref = rj?.data?.refundCreate?.refund;
  return {
    ok: true,
    refundId: ref?.id || null,
    refunded: r2(ref?.totalRefundedSet?.shopMoney?.amount),
    currency: ref?.totalRefundedSet?.shopMoney?.currencyCode || order.currencyCode,
    financialStatus: rj?.data?.refundCreate?.order?.displayFinancialStatus || null,
    restocked: restock,
    lines: refundLineItems.length,
    unmatched,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    if (!SHOP || !CID || !CSEC)
      return json({ ok: false, error: "secrets Shopify manquants (SHOPIFY_SHOP / CLIENT_ID / CLIENT_SECRET)" });
    const body = await req.json().catch(() => ({}));
    const action = body.action || "debug";

    /* « debug » ne rembourse rien : il dit si l'autorisation est là. C'est ce
       qu'on regarde en premier quand un remboursement échoue. */
    if (action === "debug") {
      let scopes: string[] = [];
      try {
        const j = await gql(`{ currentAppInstallation{ accessScopes{ handle } } }`);
        scopes = (j?.data?.currentAppInstallation?.accessScopes || []).map((s: any) => s.handle);
      } catch (_) { /* ignore */ }
      const peut = scopes.some((s) => /^write_orders$/.test(s));
      return json({
        ok: true, shop: SHOP, apiVersion: API_VERSION, scopes,
        canRefund: peut,
        hint: peut ? "" : "L'autorisation « write_orders » manque : les remboursements seront refusés.",
      });
    }
    if (action === "refund") return json(await doRefund(body));
    return json({ ok: false, error: "action inconnue : " + action });
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message || e) });
  }
});
