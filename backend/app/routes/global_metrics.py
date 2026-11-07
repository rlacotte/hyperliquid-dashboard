"""Routes API : métriques globales de marché."""
from __future__ import annotations

import time

from fastapi import APIRouter, HTTPException, Query

from .. import cache, db
from ..hyperliquid_client import get_client

router = APIRouter(prefix="/api", tags=["global-metrics"])


@router.get("/global-metrics")
async def get_global_metrics():
    """Toutes les métriques globales actuelles (HL agrégats + FNG + CoinGecko).

    Les agrégats HL viennent du cache marché (calcul instantané, 0 appel réseau).
    Les sources externes sont cache-ées côté backend (FNG 1h, CoinGecko 60s).
    Si une source externe est indisponible, sa section vaut null.
    """
    from .. import global_metrics

    ts, assets = cache.get_latest_market_snapshot()
    if assets is None:
        raise HTTPException(status_code=503, detail="Données marché pas encore disponibles")

    client = get_client()
    # Le snapshot inclut les marchés HIP-3 ; les agrégats restent ceux du DEX
    # principal (cf. poller : OI totale ou funding moyen mêlant actions et
    # cryptos perdraient leur sens).
    crypto = [a for a in assets if ":" not in a.coin]
    metrics = await global_metrics.collect_all(crypto, client._client)

    # Deltas vs valeurs précédentes (pour afficher la variation).
    # Attention : les métriques CoinGecko sont imbriquées sous metrics["coingecko"],
    # pas à la racine — on teste donc la présence de la section, pas de la clé.
    prev: dict[str, float | None] = {}
    hl_keys = ["hl_open_interest_usd", "hl_volume_24h_usd", "hl_avg_funding"]
    cg_keys = ["total_marketcap_usd", "btc_dominance"] if metrics.get("coingecko") else []
    for metric_key in hl_keys + cg_keys:
        latest = db.get_latest_global_metrics(metric_key)
        prev[metric_key] = latest["value"] if latest else None

    return {**metrics, "prev": prev}


@router.get("/global-metrics/history")
async def get_history(
    metric: str = Query(..., description="fear_greed | total_marketcap_usd | btc_dominance | hl_open_interest_usd | hl_volume_24h_usd | hl_avg_funding | hl_advance_ratio"),
    hours: int = Query(24, ge=1, le=720),
):
    """Série temporelle d'une métrique pour sparkline (dernières N heures)."""
    since_ms = int(time.time() * 1000) - hours * 3600 * 1000
    rows = db.get_global_metrics_history(metric, since_ms)
    return {"metric": metric, "points": [{"t": r["ts"], "v": r["value"]} for r in rows]}
