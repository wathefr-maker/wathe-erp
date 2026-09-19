import hashlib
import hmac
import base64
import json
import logging
import os
import asyncio
import datetime
from typing import Optional

import httpx

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("pipeline")

from fastapi import BackgroundTasks, FastAPI, Header, HTTPException, Request
from dotenv import load_dotenv
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger

load_dotenv()

from shopify import (
    get_all_products, get_sku_metafield, find_product_by_sku, update_product,
    save_metafield, add_tag_photo_ok, get_product_tags, _headers, _BASE,
)
from http_client import TIMEOUT
from sneakers import search_sku
from photoroom import process_image
from sheets import log_not_found
from translate import translate_title_to_french

app = FastAPI(title="Sneakers Pipeline")

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

# Tag posé quand le SKU est absent de KicksDB : le produit sort de la sélection
# du cron (sinon il serait re-tenté deux fois par jour indéfiniment).
TAG_PHOTO_OK    = "photo-ok"
TAG_SKU_INTROUV = "sku-introuvable"

# Fenêtre de sélection du cron, en heures (défaut 72 = 3 jours).
# Un produit raté a donc 6 passages de cron pour être rattrapé, au lieu de 2
# avec l'ancienne fenêtre de 24h.
# Mettre 0 pour supprimer toute limite de date : tout produit actif sans
# photo-ok et sans sku-introuvable reste alors candidat indéfiniment
# (utile ponctuellement pour résorber un ancien backlog).
CRON_LOOKBACK_HOURS = int(os.getenv("CRON_LOOKBACK_HOURS", "72"))

# Nombre max de produits traités par run de cron (0 = illimité).
# Utile au premier run après déploiement si le backlog est important.
CRON_MAX_PER_RUN = int(os.getenv("CRON_MAX_PER_RUN", "0"))

# Token optionnel pour protéger /reprocess
REPROCESS_TOKEN = os.getenv("REPROCESS_TOKEN", "")


# ---------------------------------------------------------------------------
# Helpers tags
# ---------------------------------------------------------------------------

def _tag_list(tags: str) -> list[str]:
    return [t.strip() for t in tags.split(",") if t.strip()]


async def sync_tags(product_id: int, add: list[str] = None, remove: list[str] = None) -> None:
    """Ajoute et retire des tags en UNE lecture + UNE écriture.

    Important : ne jamais enchaîner deux fonctions qui font chacune GET puis PUT
    sur les tags. La seconde relit une liste potentiellement pas encore propagée
    et écrase ce que la première vient d'écrire.
    """
    add = add or []
    remove = remove or []
    h = await _headers()
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        r = await client.get(f"{_BASE}/products/{product_id}.json?fields=id,tags", headers=h)
        r.raise_for_status()
        current = _tag_list(r.json().get("product", {}).get("tags", ""))

        final = [t for t in current if t not in remove]
        for t in add:
            if t not in final:
                final.append(t)

        if final == current:
            return

        r2 = await client.put(
            f"{_BASE}/products/{product_id}.json",
            headers=h,
            json={"product": {"id": product_id, "tags": ", ".join(final)}},
        )
        r2.raise_for_status()


async def add_tag(product_id: int, tag: str) -> None:
    """Ajoute un tag à un produit sans écraser les autres."""
    await sync_tags(product_id, add=[tag])


async def remove_tag(product_id: int, tag: str) -> None:
    """Retire un tag d'un produit (utile pour re-tenter un sku-introuvable)."""
    await sync_tags(product_id, remove=[tag])


# ---------------------------------------------------------------------------
# Scheduler — batch 2x/jour à 7h et 17h (Europe/Paris)
# ---------------------------------------------------------------------------

scheduler = AsyncIOScheduler(timezone="Europe/Paris")

async def scheduled_batch():
    log.info("CRON batch démarré")
    products = await get_all_products()

    candidates = []
    skipped_ok = skipped_kdb = skipped_old = 0

    cutoff = None
    if CRON_LOOKBACK_HOURS > 0:
        cutoff = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(hours=CRON_LOOKBACK_HOURS)

    for p in products:
        tags = _tag_list(p.get("tags", ""))

        if TAG_PHOTO_OK in tags:
            skipped_ok += 1
            continue
        if TAG_SKU_INTROUV in tags:
            skipped_kdb += 1
            continue

        if cutoff is not None:
            created = p.get("created_at", "")
            if not created:
                continue
            try:
                if datetime.datetime.fromisoformat(created.replace("Z", "+00:00")) <= cutoff:
                    skipped_old += 1
                    continue
            except ValueError:
                pass

        candidates.append(p)

    # Les plus anciens d'abord : le backlog se résorbe au lieu de stagner
    candidates.sort(key=lambda p: p.get("created_at", ""))

    if CRON_MAX_PER_RUN > 0 and len(candidates) > CRON_MAX_PER_RUN:
        log.info(f"CRON {len(candidates)} candidats — limité à {CRON_MAX_PER_RUN} pour ce run")
        candidates = candidates[:CRON_MAX_PER_RUN]

    log.info(
        f"CRON {len(products)} actifs — {len(candidates)} à traiter "
        f"(déjà ok: {skipped_ok}, sku introuvable: {skipped_kdb}, hors fenêtre: {skipped_old})"
    )

    done = failed = 0
    for product in candidates:
        try:
            await process_product(product)
            done += 1
        except Exception as e:
            log.error(f"[{product.get('id')}] erreur inattendue : {e}")
            failed += 1

    log.info(f"CRON batch terminé — {done} passés, {failed} en erreur")


@app.on_event("startup")
async def start_scheduler():
    # misfire_grace_time : si le conteneur redémarre pile à l'heure du cron,
    # le run est rattrapé dans l'heure au lieu d'être perdu.
    # coalesce : plusieurs runs manqués ne déclenchent qu'une exécution.
    scheduler.add_job(scheduled_batch, CronTrigger(hour=7,  minute=0),
                      misfire_grace_time=3600, coalesce=True, max_instances=1)
    scheduler.add_job(scheduled_batch, CronTrigger(hour=17, minute=0),
                      misfire_grace_time=3600, coalesce=True, max_instances=1)
    scheduler.start()
    log.info(
        f"Scheduler démarré — batch à 07:00 et 17:00 (Europe/Paris) — "
        f"fenêtre={'illimitée' if CRON_LOOKBACK_HOURS == 0 else str(CRON_LOOKBACK_HOURS) + 'h'}"
    )

@app.on_event("shutdown")
async def stop_scheduler():
    scheduler.shutdown()


# ---------------------------------------------------------------------------
# Core pipeline
# ---------------------------------------------------------------------------

async def process_product(product: dict, force: bool = False) -> None:
    """force=True : ignore les tags photo-ok / sku-introuvable et retraite quand même."""
    product_id = product["id"]
    shopify_title = product.get("title", "")
    prefix = f"[{product_id}] {shopify_title[:45]}" if shopify_title else f"[{product_id}]"

    # Vérifier les vrais tags depuis Shopify (pas ceux passés en paramètre)
    if not force:
        tags = _tag_list(await get_product_tags(product_id))
        if TAG_PHOTO_OK in tags:
            log.info(f"{prefix} — skipped (photo-ok)")
            return
        if TAG_SKU_INTROUV in tags:
            log.info(f"{prefix} — skipped (sku-introuvable)")
            return
    else:
        log.info(f"{prefix} — FORCÉ (tags ignorés)")

    log.info(f"{prefix} — début traitement")

    sku = await get_sku_metafield(product_id)
    if not sku:
        log.warning(f"{prefix} — pas de SKU flowstock, ignoré")
        return

    log.info(f"{prefix} — SKU={sku} → KicksDB...")
    result = await search_sku(sku)
    if result is None:
        log.warning(f"{prefix} — SKU={sku} introuvable KicksDB → Sheets + tag {TAG_SKU_INTROUV}")
        try:
            await log_not_found(sku, shopify_title, datetime.date.today().isoformat())
        except Exception as e:
            log.error(f"{prefix} — Sheets erreur : {e}")
        try:
            await add_tag(product_id, TAG_SKU_INTROUV)
        except Exception as e:
            log.error(f"{prefix} — tag {TAG_SKU_INTROUV} erreur : {e}")
        return

    kicks_title, gallery_urls = result
    log.info(f"{prefix} — KicksDB OK : {kicks_title[:50]} ({len(gallery_urls)} images)")

    log.info(f"{prefix} — traduction Claude...")
    fr_title = await translate_title_to_french(kicks_title)
    await save_metafield(product_id, "custom", "titre_fr_leclerc", fr_title)
    log.info(f"{prefix} — titre FR : {fr_title[:50]}")

    log.info(f"{prefix} — PhotoRoom ({len(gallery_urls)} images)...")
    processed: list[bytes] = []
    for url in gallery_urls:
        img = await process_image(url)
        if img:
            processed.append(img)

    if not processed:
        log.error(f"{prefix} — PhotoRoom : aucune image traitée (sera re-tenté au prochain run)")
        return

    log.info(f"{prefix} — Shopify update ({len(processed)} images)...")
    await update_product(product_id, kicks_title, processed)
    # Un seul appel : pose photo-ok et retire sku-introuvable en une écriture.
    await sync_tags(product_id, add=[TAG_PHOTO_OK], remove=[TAG_SKU_INTROUV])

    # Vérification : le tag est bien en place côté Shopify
    final_tags = _tag_list(await get_product_tags(product_id))
    if TAG_PHOTO_OK not in final_tags:
        log.error(f"{prefix} — ⚠ tag {TAG_PHOTO_OK} absent après update, nouvelle tentative")
        await sync_tags(product_id, add=[TAG_PHOTO_OK])

    log.info(f"{prefix} — ✓ traitement terminé")


# ---------------------------------------------------------------------------
# Webhook — products/create
# ---------------------------------------------------------------------------

def _verify_shopify_hmac(body: bytes, hmac_header: Optional[str]) -> bool:
    secret = os.getenv("SHOPIFY_WEBHOOK_SECRET", "")
    if not secret:
        log.error("SHOPIFY_WEBHOOK_SECRET absent — webhook rejeté")
        return False
    if not hmac_header:
        log.warning("Webhook sans en-tête HMAC — rejeté")
        return False
    digest = hmac.new(secret.encode(), body, hashlib.sha256).digest()
    computed = base64.b64encode(digest).decode()
    ok = hmac.compare_digest(computed, hmac_header)
    if not ok:
        log.warning("Webhook HMAC invalide — vérifier SHOPIFY_WEBHOOK_SECRET")
    return ok


@app.post("/webhooks/products/create", status_code=202)
async def webhook_product_create(
    request: Request,
    background_tasks: BackgroundTasks,
    x_shopify_hmac_sha256: Optional[str] = Header(default=None),
):
    body = await request.body()

    if not _verify_shopify_hmac(body, x_shopify_hmac_sha256):
        raise HTTPException(status_code=401, detail="Invalid HMAC signature")

    product = json.loads(body)
    if product.get("status") != "active":
        return {"status": "ignored", "reason": "product is not active"}
    background_tasks.add_task(process_product, product)
    return {"status": "accepted"}


# ---------------------------------------------------------------------------
# Reprocess — relance manuelle sur une liste d'IDs produit Shopify
# ---------------------------------------------------------------------------

def _check_token(token: Optional[str]) -> None:
    if REPROCESS_TOKEN and token != REPROCESS_TOKEN:
        raise HTTPException(status_code=401, detail="Invalid token")


async def _reprocess_ids(ids: list, force: bool) -> None:
    log.info(f"REPROCESS démarré — {len(ids)} produits (force={force})")
    done = errors = 0
    for pid in ids:
        try:
            await process_product({"id": pid, "title": ""}, force=force)
            done += 1
        except Exception as e:
            log.error(f"[{pid}] REPROCESS erreur : {e}")
            errors += 1
        await asyncio.sleep(0.3)
    log.info(f"REPROCESS terminé — {done} passés, {errors} en erreur")


@app.post("/reprocess", status_code=202)
async def reprocess(
    payload: dict,
    background_tasks: BackgroundTasks,
    x_token: Optional[str] = Header(default=None),
):
    """
    Body JSON :
      {"ids": [16331786748239, 16331176902991], "force": true}

    force=true retraite même les produits déjà taggés photo-ok / sku-introuvable.
    """
    _check_token(x_token)

    ids = payload.get("ids") or []
    if not isinstance(ids, list) or not ids:
        raise HTTPException(status_code=400, detail="Champ 'ids' manquant ou vide")

    force = bool(payload.get("force", True))
    background_tasks.add_task(_reprocess_ids, ids, force)
    return {"status": "accepted", "count": len(ids), "force": force}


@app.post("/run-now", status_code=202)
async def run_now(
    background_tasks: BackgroundTasks,
    x_token: Optional[str] = Header(default=None),
):
    """Déclenche immédiatement le batch du cron, sans attendre 07:00 / 17:00."""
    _check_token(x_token)
    background_tasks.add_task(scheduled_batch)
    return {"status": "accepted"}


@app.get("/status")
async def status(x_token: Optional[str] = Header(default=None)):
    """Compte les produits par état — utile pour vérifier qu'il ne reste rien en attente."""
    _check_token(x_token)
    products = await get_all_products()
    ok = kdb = pending = 0
    for p in products:
        tags = _tag_list(p.get("tags", ""))
        if TAG_PHOTO_OK in tags:
            ok += 1
        elif TAG_SKU_INTROUV in tags:
            kdb += 1
        else:
            pending += 1
    return {
        "total_actifs": len(products),
        "photo_ok": ok,
        "sku_introuvable": kdb,
        "en_attente": pending,
    }


# ---------------------------------------------------------------------------
# Batch — process SKUs from Excel file
# ---------------------------------------------------------------------------

async def _run_batch():
    import pandas as pd

    df = pd.read_excel("paire à faire .xlsx", header=None)
    skus = df[0].astype(str).str.strip().tolist()

    log.info(f"Batch lancé — {len(skus)} SKUs à traiter depuis Excel")

    done = 0
    skipped = 0
    errors = 0

    for sku in skus:
        await asyncio.sleep(0.5)
        try:
            result = await find_product_by_sku(sku)
            if result is None:
                log.warning(f"SKU {sku} introuvable dans Shopify")
                errors += 1
                continue
            product_id, title = result
            await process_product({"id": product_id, "title": title})
            done += 1
        except Exception as e:
            log.error(f"SKU {sku} — erreur : {e}")
            errors += 1

    log.info(f"Batch terminé — {done} traités, {skipped} skippés, {errors} erreurs")

@app.post("/batch", status_code=202)
async def batch_process(background_tasks: BackgroundTasks):
    background_tasks.add_task(_run_batch)
    return {"status": "accepted", "message": "Batch lancé en arrière-plan"}


# ---------------------------------------------------------------------------
# Single SKU — process one product by SKU
# ---------------------------------------------------------------------------

@app.post("/process/{sku}", status_code=202)
async def process_by_sku(sku: str, background_tasks: BackgroundTasks):
    result = await find_product_by_sku(sku)
    if result is None:
        raise HTTPException(status_code=404, detail=f"No Shopify product found with SKU {sku}")
    product_id, title = result
    background_tasks.add_task(process_product, {"id": product_id, "title": title})
    return {"status": "accepted", "sku": sku, "product_id": product_id}
