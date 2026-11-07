"""Routes API : données marché."""
from __future__ import annotations

import time

from fastapi import APIRouter, HTTPException, Query

from .. import cache, confluence_cache
from ..hyperliquid_client import get_client
from ..models import AssetMarket, Candle, FundingPoint, MarketsResponse

router = APIRouter(prefix="/api", tags=["markets"])


def _coin_id(coin: str) -> str:
    """Les identifiants HIP-3 sont sensibles à la casse ("xyz:TSLA") : mettre en
    majuscules cassait ces marchés. Seuls les coins du DEX principal sont normalisés."""
    return coin if ":" in coin else coin.upper()


@router.get("/markets", response_model=MarketsResponse)
async def get_markets() -> MarketsResponse:
    """Retourne le dernier snapshot marché mis en cache par le poller."""
    ts, assets = cache.get_latest_market_snapshot()
    if assets is None:
        raise HTTPException(status_code=503, detail="Données marché pas encore disponibles (poller en cours de démarrage)")
    return MarketsResponse(ts=ts, assets=assets)


@router.get("/markets/{coin}/candles", response_model=list[Candle])
async def get_candles(
    coin: str,
    interval: str = Query("1h", description="1m,5m,15m,1h,2h,4h,1d..."),
    hours: int = Query(24, ge=1, le=720),
) -> list[Candle]:
    client = get_client()
    end_ms = int(time.time() * 1000)
    start_ms = end_ms - hours * 3600 * 1000
    raw = await client.get_candles(_coin_id(coin), interval, start_ms, end_ms)
    candles = []
    for c in raw:
        candles.append(
            Candle(
                t=c.get("t", 0),
                o=float(c["o"]),
                h=float(c["h"]),
                l=float(c["l"]),
                c=float(c["c"]),
                v=float(c.get("v", 0)),
            )
        )
    return candles


@router.get("/markets/{coin}/funding", response_model=list[FundingPoint])
async def get_funding(coin: str, hours: int = Query(72, ge=1, le=720)) -> list[FundingPoint]:
    client = get_client()
    end_ms = int(time.time() * 1000)
    start_ms = end_ms - hours * 3600 * 1000
    raw = await client.get_funding_history(_coin_id(coin), start_ms, end_ms)
    return [FundingPoint(time=e["time"], funding=float(e.get("fundingRate", e.get("funding", 0)))) for e in raw]


@router.get("/confluence")
async def get_confluence(min_score: float = Query(0.0, ge=0.0, le=10.0)):
    """Scores de confluence de tous les coins (triés par amplitude décroissante).

    min_score permet de filtrer les signaux faibles (ex: min_score=4 pour ne
    garder que les signaux notables).
    """
    ts, results = confluence_cache.get_confluence_scores()
    if not results:
        raise HTTPException(status_code=503, detail="Scores pas encore disponibles")
    scores = [confluence_cache.to_dict(r) for r in results if abs(r.score) >= min_score]
    return {"ts": ts, "scores": scores}

