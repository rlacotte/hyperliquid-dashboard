"""Application FastAPI.

La collecte ne tourne plus dans le processus : elle est déclenchée par Vercel
Cron sur /api/cron/poll (cf. poller.py). En dev local, poser RUN_POLLER=1
relance la boucle asyncio d'origine pour retrouver le confort du `uvicorn --reload`.
"""
from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import cache, config, db, poller
from .hyperliquid_client import get_client
from .routes import alerts, cron, markets

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("hyperliquid-dashboard")


@asynccontextmanager
async def lifespan(app: FastAPI):
    # En serverless, ce lifespan tourne à chaque cold start : init_db est
    # idempotent et ne coûte qu'un aller-retour.
    try:
        db.init_db()
    except Exception:
        logger.exception("init_db en échec au démarrage")

    task = None
    if config.RUN_POLLER:
        task = asyncio.create_task(poller.poller_loop())
        logger.info("Backend prêt (poller in-process actif)")
    else:
        logger.info("Backend prêt (collecte déléguée au cron /api/cron/poll)")

    yield

    if task is not None:
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
    await get_client().aclose()


app = FastAPI(
    title="Hyperliquid Dashboard API",
    description="Dashboard crypto avec alertes d'investissement basé sur l'API publique Hyperliquid",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=config.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(markets.router)
app.include_router(alerts.router)
app.include_router(cron.router)


@app.get("/api/health")
async def health():
    ts, assets = cache.get_latest_market_snapshot()
    return {
        "status": "ok",
        "last_fetch_ms": ts,
        "assets_count": len(assets) if assets else 0,
        "poll_interval_sec": config.POLL_INTERVAL_SEC,
    }


@app.get("/api/db/stats")
async def db_stats():
    """Statistiques BDD : nb de snapshots, taille, état du downsampling."""
    return db.get_db_stats()
