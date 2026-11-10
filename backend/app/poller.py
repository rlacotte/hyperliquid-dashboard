"""Cycle de collecte : fetch Hyperliquid -> snapshot -> alertes.

C'était une boucle asyncio permanente. En serverless il n'existe pas de
processus long : un cycle = une invocation, déclenchée par Vercel Cron sur
/api/cron/poll. La boucle reste disponible pour le dev local (RUN_POLLER=1).
"""
from __future__ import annotations

import asyncio
import logging
import time

from . import alert_engine, cache, config, db, funding_arb, notifier
from .hyperliquid_client import HyperliquidClient, fresh_client
from .models import AssetMarket

logger = logging.getLogger(__name__)

_MAINTENANCE_KEY = "last_maintenance_ms"


def _build_assets(universe: list[dict], asset_ctxs: list[dict], mids: dict) -> list[AssetMarket]:
    assets: list[AssetMarket] = []
    for meta, ctx in zip(universe, asset_ctxs):
        coin = meta.get("name", "")
        # Marché retiré de la cote : plus de négociation, son OI tombe à zéro.
        # L'évaluer produisait une fausse alerte « OI −100 % » critique, restée
        # active des mois (VINE, retiré le 26 août 2026).
        if not coin or meta.get("isDelisted"):
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
    """Un cycle complet. Retourne un résumé (utilisé comme réponse du cron).

    Client HTTP neuf par cycle, fermé à la fin : cf. hyperliquid_client.fresh_client.
    """
    async with fresh_client() as client:
        return await _poll_with(client)


_HIP3_DEXS_KEY = "hip3_dexs"
_HIP3_DEXS_TTL_MS = 3600_000


async def _hip3_plan(client: HyperliquidClient, now_ms: int) -> tuple[list[str], bool]:
    """DEX à interroger ce cycle, et s'il s'agit d'un balayage complet.

    Une fois par heure : tous les DEX (un nouveau peut apparaître, un ancien
    s'activer). Entre-temps : seulement ceux qui avaient au moins un marché
    actif — la majorité des DEX HIP-3 sont vides, et chacun coûtait une
    requête, une analyse JSON et une poignée de main TLS par cycle.
    """
    stored = db.kv_get(_HIP3_DEXS_KEY)
    if stored and now_ms - stored[0] < _HIP3_DEXS_TTL_MS and "active" in stored[1]:
        return list(stored[1]["active"]), False
    return await client.get_perp_dexs(), True


async def _hip3_assets(client: HyperliquidClient, now_ms: int) -> tuple[list[AssetMarket], list[str], list[str]]:
    """Marchés HIP-3 actifs, DEX interrogés en parallèle.

    Un DEX en échec n'interrompt pas le cycle : le DEX principal reste la
    donnée critique. Renvoie (actifs retenus, DEX en échec pour le compte rendu
    du cycle, DEX lus avec succès — seuls ceux-là peuvent clore les alertes
    d'un marché disparu).
    """
    if not config.HIP3_ENABLED:
        return [], [], []
    try:
        dexs, full_scan = await _hip3_plan(client, now_ms)
    except Exception:
        logger.exception("Liste des DEX HIP-3 indisponible")
        return [], ["*"], []
    results = await asyncio.gather(*(client.get_meta_and_asset_ctxs(d) for d in dexs), return_exceptions=True)
    assets: list[AssetMarket] = []
    failed: list[str] = []
    active: list[str] = []
    scanned: list[str] = []
    for dex, res in zip(dexs, results):
        if isinstance(res, Exception):
            failed.append(dex)
            continue
        scanned.append(dex)
        universe, ctxs = res
        # Pas de mids websocket pour HIP-3 côté serveur : le midPx du contexte suffit.
        kept = [
            a for a in _build_assets(universe, ctxs, {})
            if max(a.day_ntl_vlm, a.open_interest_usd) >= config.HIP3_MIN_ACTIVITY_USD
        ]
        if kept:
            active.append(dex)
        assets.extend(kept)
    if full_scan:
        # Un DEX en échec pendant le balayage est gardé : mieux vaut une requête
        # de trop qu'un DEX actif oublié pendant une heure.
        db.kv_set(_HIP3_DEXS_KEY, now_ms, {"dexs": dexs, "active": sorted(set(active) | set(failed))})
    return assets, failed, scanned


def is_hip3(coin: str) -> bool:
    return ":" in coin


async def _poll_with(client: HyperliquidClient) -> dict:
    started = time.time()
    try:
        universe, asset_ctxs = await client.get_meta_and_asset_ctxs()
        mids = await client.get_all_mids()
    except Exception:
        logger.exception("Erreur fetch Hyperliquid")
        raise

    now_ms = int(time.time() * 1000)
    crypto = _build_assets(universe, asset_ctxs, mids)
    hip3, hip3_failed, hip3_scanned = await _hip3_assets(client, now_ms)
    assets = crypto + hip3

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

    # Arbitrage de funding : état rafraîchi au plus toutes les 5 min (une
    # requête), puis évalué à chaque cycle avec les autres critères.
    arb_info = None
    try:
        arb_info = await funding_arb.maybe_refresh(client, crypto, now_ms)
    except Exception:
        logger.exception("Erreur arbitrage de funding")
    arb = funding_arb.current_state(now_ms)

    # DEX entièrement lus ce cycle : une alerte active sur un de leurs marchés
    # absent de la collecte (retiré, ou HIP-3 devenu inactif) peut être close.
    covered = {""} | set(hip3_scanned)
    after_active, before_active, created = alert_engine.evaluate_all(assets, ctx, arb[1] if arb else None, covered)
    delta = after_active - before_active
    if delta != 0:
        logger.info("Alertes: %d actives (%+d ce cycle)", after_active, delta)

    # Notification des alertes créées ce cycle (no-op sans canal configuré).
    # Après l'évaluation mais avant la maintenance : un downsampling lent ne
    # doit pas retarder un ping critique.
    notified: dict = {}
    try:
        notified = await notifier.notify_new_alerts(created)
    except Exception:
        logger.exception("Erreur notifications")

    # Bot Telegram : alertes critiques aux abonnés qui l'ont demandé, puis
    # mouvements des wallets suivis (no-op sans token).
    telegram_info = None
    try:
        from . import telegram_bot
        telegram_info = await telegram_bot.run_cycle(client, created, now_ms)
    except Exception:
        logger.exception("Erreur bot Telegram")

    # Métriques globales (agrégats HL + sources externes cache-ées)
    try:
        from . import global_metrics
        # Agrégats du DEX principal uniquement : « OI totale », funding moyen ou
        # advance/decline mélangeant cryptos et actions perdraient leur sens.
        gm = await global_metrics.collect_all(crypto, client._client)
        global_metrics.persist_history(gm)
    except Exception:
        logger.exception("Erreur collecte métriques globales")

    # Leaderboard distillé : au plus toutes les 2 h (fetch de ~39 Mo).
    # Placé après les alertes : un téléchargement lent ne doit jamais les retarder.
    leaderboard_info = None
    try:
        from . import leaderboard
        leaderboard_info = await leaderboard.maybe_refresh(client._client, now_ms)
    except Exception:
        logger.exception("Erreur leaderboard")

    # Track record : mesure ce qui a suivi les alertes passées, par petits lots
    # (au plus 3 coins toutes les 2 min). Même règle : jamais avant les alertes.
    track_info = None
    try:
        from . import track_record
        track_info = await track_record.maybe_process(client, now_ms)
    except Exception:
        logger.exception("Erreur track record")

    # Revenus des protocoles et multiples MC/FDV : toutes les 3 h (~14 Mo
    # DefiLlama + un appel CoinGecko). En dernier : jamais avant les alertes.
    revenue_info = None
    try:
        from . import revenue
        revenue_info = await revenue.maybe_refresh(client._client, client, [a.coin for a in crypto], now_ms)
    except Exception:
        logger.exception("Erreur revenus des protocoles")

    maintenance = _maybe_run_maintenance(now_ms)

    return {
        "ts": now_ms,
        "assets": len(crypto),
        "hip3_assets": len(hip3),
        "hip3_failed": hip3_failed,
        "funding_arb": arb_info,
        "alerts_active": after_active,
        "alerts_delta": delta,
        "alerts_created": len(created),
        "notified": notified,
        "telegram": telegram_info,
        "leaderboard": leaderboard_info,
        "track_record": track_info,
        "revenue": revenue_info,
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
