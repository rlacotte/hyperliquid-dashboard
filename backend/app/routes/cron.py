"""Route de collecte déclenchée par Vercel Cron.

Remplace la boucle asyncio du poller : chaque appel exécute exactement un cycle
(fetch -> snapshot -> alertes -> maintenance éventuelle).
"""
from __future__ import annotations

import hmac
import logging

from fastapi import APIRouter, Header, HTTPException

from .. import config, db, poller

router = APIRouter(prefix="/api/cron", tags=["cron"])

logger = logging.getLogger(__name__)


def _authorized(authorization: str | None) -> bool:
    """Vercel Cron envoie `Authorization: Bearer $CRON_SECRET`.

    Comparaison à temps constant : la route est publiquement joignable, et une
    comparaison naïve fuiterait le secret octet par octet.
    """
    if not config.CRON_SECRET:
        # Pas de secret configuré : route ouverte (déconseillé en production).
        return True
    if not authorization or not authorization.startswith("Bearer "):
        return False
    return hmac.compare_digest(authorization[len("Bearer ") :], config.CRON_SECRET)


@router.get("/poll")
async def cron_poll(authorization: str | None = Header(default=None)):
    if not _authorized(authorization):
        raise HTTPException(status_code=401, detail="Non autorisé")
    # Idempotent, et indispensable au tout premier appel sur une base vierge.
    db.init_db()
    return await poller.poll_once()
