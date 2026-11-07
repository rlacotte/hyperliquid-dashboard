"""Route : écarts de funding suivis et leur durée."""
from __future__ import annotations

from fastapi import APIRouter

from .. import funding_arb

router = APIRouter(prefix="/api", tags=["funding"])


@router.get("/funding-arb")
async def get_funding_arb():
    """Écarts Hyperliquid ↔ CEX au-dessus du seuil de suivi, avec depuis quand
    ils durent (même paire de plateformes, sans interruption)."""
    state = funding_arb.current_state()
    if state is None:
        return {"ts": None, "stale": True, "coins": {}}
    ts, coins = state
    return {"ts": ts, "stale": False, "track_min_apr": funding_arb.config.ARB_TRACK_MIN_APR, "coins": coins}
