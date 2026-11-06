"""Route : leaderboard distillé avec profils de traders."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException

from .. import db, leaderboard

router = APIRouter(prefix="/api", tags=["leaderboard"])


@router.get("/leaderboard")
async def get_leaderboard():
    cached = leaderboard.get_cached()
    if cached is None:
        raise HTTPException(status_code=503, detail="Leaderboard pas encore distillé (prochain cycle de collecte)")
    ts, data = cached
    days = db.leaderboard_snapshot_days()
    return {
        "ts": ts,
        "total": data["total"],
        "rows": data["rows"],
        # Avancement de l'étude de persistance (photos quotidiennes accumulées).
        "snapshots": {"days": len(days), "since": days[0] if days else None},
    }
