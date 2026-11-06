"""Route de collecte déclenchée par Vercel Cron.

Remplace la boucle asyncio du poller : chaque appel exécute exactement un cycle
(fetch -> snapshot -> alertes -> maintenance éventuelle).
"""
from __future__ import annotations

import hmac
import logging
import time

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


# Intervalle minimal entre deux cycles. La cadence visée est d'une minute
# (cf. infra/scaleway-pinger/handler.js pour le choix) ; tout appel arrivant
# moins de 40 s après le précédent est un doublon (relance du déclencheur,
# chevauchement, déclenchement manuel) — constaté : ~4 cycles/min avec un seul
# déclencheur aux premiers démarrages à froid. Sans garde, chaque doublon coûte
# un cycle complet en CPU Vercel (plafond dur du plan Hobby) et en appels
# Hyperliquid.
MIN_POLL_INTERVAL_MS = 40_000
_CLAIM_KEY = "poll_claim"

# init_db exécute ~15 instructions DDL (CREATE … IF NOT EXISTS, ALTER ROLE) :
# une fois par instance suffit, pas à chaque cycle sur une base partagée.
_schema_ready = False


@router.get("/poll")
async def cron_poll(
    authorization: str | None = Header(default=None),
    x_pinger: str | None = Header(default=None),
):
    global _schema_ready
    if not _authorized(authorization):
        raise HTTPException(status_code=401, detail="Non autorisé")
    if not _schema_ready:
        # Indispensable au tout premier appel sur une base vierge.
        db.init_db()
        _schema_ready = True

    now_ms = int(time.time() * 1000)
    if not db.try_claim(_CLAIM_KEY, now_ms, MIN_POLL_INTERVAL_MS):
        logger.info("poll ignoré (doublon) source=%s", x_pinger or "?")
        return {"skipped": True, "reason": "cycle précédent il y a moins de 40 s"}

    logger.info("poll source=%s", x_pinger or "?")
    return await poller.poll_once()
