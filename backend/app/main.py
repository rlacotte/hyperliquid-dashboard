"""Application FastAPI.

La collecte ne tourne plus dans le processus : elle est déclenchée par Vercel
Cron sur /api/cron/poll (cf. poller.py). En dev local, poser RUN_POLLER=1
relance la boucle asyncio d'origine pour retrouver le confort du `uvicorn --reload`.
"""
from __future__ import annotations

import asyncio
import logging
import re
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import cache, config, db, poller
from .hyperliquid_client import get_client
from .routes import alerts, cron, funding_arb, global_metrics, leaderboard, markets, replay, signals, telegram

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
app.include_router(global_metrics.router)
app.include_router(replay.router)
app.include_router(leaderboard.router)
app.include_router(signals.router)
app.include_router(funding_arb.router)
app.include_router(telegram.router)


# --- Cache CDN sur les routes de lecture --------------------------------------
# La donnée ne change qu'au rythme de la collecte (30 s) : servir chaque
# visiteur depuis Postgres est du gaspillage, d'autant que l'instance est
# partagée avec d'autres bases de production (max_connections=100). Un
# s-maxage court fait absorber les rafales par le CDN Vercel.
#
# Volontairement exclus :
#   - /api/alerts : l'acquittement doit se refléter immédiatement ;
#   - /api/cron/* : un cache servirait une réponse au lieu de déclencher la
#     collecte — le cron ne tournerait plus.
_CACHE_RULES: tuple[tuple[re.Pattern, int], ...] = (
    (re.compile(r"^/api/(markets|confluence)$"), 15),
    # Interrogé par chaque visiteur pour la pastille « Signaux » : 10 s de
    # cache partagé suffisent face à une collecte par minute.
    (re.compile(r"^/api/health$"), 10),
    (re.compile(r"^/api/global-metrics$"), 30),
    (re.compile(r"^/api/global-metrics/history$"), 60),
    # Rafraîchi au plus toutes les 2 h côté serveur.
    (re.compile(r"^/api/leaderboard$"), 300),
    (re.compile(r"^/api/track-record$"), 300),
    (re.compile(r"^/api/funding-arb$"), 60),
    # Nom du bot : ne change qu'à sa (re)configuration.
    (re.compile(r"^/api/telegram/info$"), 300),
    (re.compile(r"^/api/markets/[^/]+/(candles|funding)$"), 60),
)


@app.middleware("http")
async def cdn_cache_headers(request, call_next):
    response = await call_next(request)
    if request.method == "GET" and response.status_code == 200:
        for pattern, ttl in _CACHE_RULES:
            if pattern.match(request.url.path):
                response.headers["Cache-Control"] = (
                    f"public, s-maxage={ttl}, stale-while-revalidate=30"
                )
                break
    return response


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
