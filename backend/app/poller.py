"""Cycle de collecte : fetch Hyperliquid -> snapshot -> alertes.

C'était une boucle asyncio permanente. En serverless il n'existe pas de
processus long : un cycle = une invocation, déclenchée par Vercel Cron sur
/api/cron/poll. La boucle reste disponible pour le dev local (RUN_POLLER=1).
"""
from __future__ import annotations

import asyncio
import logging
import time

from . import alert_engine, cache, config, db
from .hyperliquid_client import get_client
from .models import AssetMarket

logger = logging.getLogger(__name__)

_MAINTENANCE_KEY = "last_maintenance_ms"


def _build_assets(universe: list[dict], asset_ctxs: list[dict], mids: dict) -> list[AssetMarket]:
    assets: list[AssetMarket] = []
    for meta, ctx in zip(universe, asset_ctxs):
        coin = meta.get("name", "")
        if not coin:
            continue
        mark_px = float(ctx.get("markPx", 0) or 0)
        prev_day_px = float(ctx.get("prevDayPx", 0) or 0)
        change_pct = ((mark_px - prev_day_px) / prev_day_px) if prev_day_px > 0 else 0.0
        oi = float(ctx.get("openInterest", 0) or 0)
        assets.append(
            AssetMarket(
                coin=coin,
                sz_decimals=int(meta.get("szDecimals", 0) or 0),
                max_leverage=int(meta.get("maxLeverage", 0) or 0),
                mark_px=mark_px,
                oracle_px=float(ctx.get("oraclePx", 0) or 0),
                mid_px=float(mids.get(coin, ctx.get("midPx", 0)) or 0),
                funding=float(ctx.get("funding", 0) or 0),
                open_interest=oi,
                open_interest_usd=oi * mark_px,
                prev_day_px=prev_day_px,
                day_ntl_vlm=float(ctx.get("dayNtlVlm", 0) or 0),
                day_base_vlm=float(ctx.get("dayBaseVlm", 0) or 0),
                change_24h_pct=change_pct,
            )
        )
    return assets


def _maybe_run_maintenance(now_ms: int) -> dict | None:
    """Downsample + purge, au plus une fois par MAINTENANCE_INTERVAL_SEC.

    Le compteur de cycles en mémoire du poller d'origine ne survit pas d'une
    invocation à l'autre : on garde donc l'horodatage de la dernière passe en base.
    """
    stored = db.kv_get(_MAINTENANCE_KEY)
    last_ms = stored[1].get("ms", 0) if stored else 0
    if now_ms - last_ms < config.MAINTENANCE_INTERVAL_SEC * 1000:
        return None

    # Marqué avant l'exécution : si la passe dépasse le budget de la fonction,
    # on préfère la sauter que la relancer en boucle à chaque cycle.
    db.kv_set(_MAINTENANCE_KEY, now_ms, {"ms": now_ms})
    try:
        deleted = db.downsample_snapshots()
        purged = db.purge_old_snapshots()
        gm_deleted = db.downsample_global_metrics()
    except Exception:
        logger.exception("Erreur maintenance BDD")
        return None
    if deleted or purged or gm_deleted:
        logger.info(
            "Maintenance BDD: %d snapshots downsamplés, %d purgés, %d métriques globales downsamplées",
            deleted,
            purged,
            gm_deleted,
        )
    return {"downsampled": deleted, "purged": purged, "gm_downsampled": gm_deleted}


async def poll_once() -> dict:
    """Un cycle complet. Retourne un résumé (utilisé comme réponse du cron)."""
    started = time.time()
    client = get_client()
    try:
        universe, asset_ctxs = await client.get_meta_and_asset_ctxs()
        mids = await client.get_all_mids()
    except Exception:
        logger.exception("Erreur fetch Hyperliquid")
        raise

    now_ms = int(time.time() * 1000)
    assets = _build_assets(universe, asset_ctxs, mids)

    # Persistance snapshots pour l'historique (alertes temporelles).
    # Écrit AVANT le chargement de l'historique pour que la fenêtre de volume
    # récente contienne bien le point courant.
    db.insert_snapshots(
        [(a.coin, now_ms, a.mark_px, a.funding, a.open_interest, a.day_ntl_vlm) for a in assets]
    )

    # Snapshot courant exposé à l'API
    cache.set_latest_market_snapshot(now_ms, assets)

    # Évaluation des alertes sur l'historique pré-chargé
    ctx = db.load_history_context(now_ms)
    after_active, before_active = alert_engine.evaluate_all(assets, ctx)
    delta = after_active - before_active
    if delta != 0:
        logger.info("Alertes: %d actives (%+d ce cycle)", after_active, delta)

    # Métriques globales (agrégats HL + sources externes cache-ées)
    try:
        from . import global_metrics
        gm = await global_metrics.collect_all(assets, client._client)
        global_metrics.persist_history(gm)
    except Exception:
        logger.exception("Erreur collecte métriques globales")

    maintenance = _maybe_run_maintenance(now_ms)

    return {
        "ts": now_ms,
        "assets": len(assets),
        "alerts_active": after_active,
        "alerts_delta": delta,
        "maintenance": maintenance,
        "duration_ms": int((time.time() - started) * 1000),
    }


async def poller_loop() -> None:
    """Boucle de collecte pour le dev local (RUN_POLLER=1). Inutilisée en serverless."""
    logger.info("Poller démarré (intervalle=%ss)", config.POLL_INTERVAL_SEC)
    while True:
        try:
            await poll_once()
        except Exception:
            logger.exception("Cycle de collecte en échec")
        await asyncio.sleep(config.POLL_INTERVAL_SEC)
