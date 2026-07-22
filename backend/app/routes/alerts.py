"""Routes API : alertes."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

from .. import db
from ..models import AlertOut

router = APIRouter(prefix="/api", tags=["alerts"])


def _row_to_out(r) -> AlertOut:
    return AlertOut(
        id=r["id"],
        coin=r["coin"],
        ts=r["ts"],
        criterion=r["criterion"],
        severity=r["severity"],
        message=r["message"],
        # Colonne JSONB : psycopg désérialise déjà en dict
        details=r["details"] or {},
        acknowledged=r["acknowledged"],
        resolved_ts=r["resolved_ts"],
        active=r["active"],
        score=r["score"],
        direction=r["direction"],
    )


@router.get("/alerts", response_model=list[AlertOut])
async def list_alerts(
    limit: int = Query(100, ge=1, le=500),
    only_active: bool = Query(True),
) -> list[AlertOut]:
    rows = db.get_alerts(limit=limit, only_active=only_active)
    return [_row_to_out(r) for r in rows]


@router.patch("/alerts/{alert_id}/ack", response_model=AlertOut)
async def acknowledge(alert_id: int):
    ok = db.acknowledge_alert(alert_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Alerte introuvable")
    return _row_to_out(db.get_alert(alert_id))


@router.post("/alerts/ack-all")
async def acknowledge_all():
    """Acquitte toutes les alertes actives."""
    n = db.acknowledge_all()
    return {"acknowledged": n}
