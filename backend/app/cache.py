"""Dernier snapshot marché, partagé entre le cron de collecte et l'API.

C'était un cache en mémoire process. En serverless, la requête `/api/markets` et
le cycle de collecte s'exécutent dans des instances distinctes : une variable
globale ne les relie plus. Le snapshot transite donc par la table `kv`.

Un cache mémoire est conservé *en plus*, expiré par TTL : plusieurs requêtes
servies par une même instance chaude évitent un aller-retour SQL, sans jamais
resservir de données périmées au-delà du TTL.
"""
from __future__ import annotations

import threading
import time

from . import db
from .models import AssetMarket

_KEY = "latest_markets"
# Le cron collecte toutes les POLL_INTERVAL_SEC ; un TTL court garde l'UI
# fraîche tout en absorbant les rafales de requêtes.
_TTL_SEC = 5.0

_lock = threading.Lock()
_local_ts: int = 0
_local_assets: list[AssetMarket] | None = None
_local_fetched_at: float = 0.0


def set_latest_market_snapshot(ts: int, assets: list[AssetMarket]) -> None:
    global _local_ts, _local_assets, _local_fetched_at
    db.kv_set(_KEY, ts, [a.model_dump() for a in assets])
    with _lock:
        _local_ts = ts
        _local_assets = assets
        _local_fetched_at = time.time()


def get_latest_market_snapshot() -> tuple[int, list[AssetMarket] | None]:
    global _local_ts, _local_assets, _local_fetched_at
    with _lock:
        if _local_assets is not None and (time.time() - _local_fetched_at) < _TTL_SEC:
            return _local_ts, _local_assets

    stored = db.kv_get(_KEY)
    if stored is None:
        return 0, None
    ts, raw = stored
    assets = [AssetMarket(**a) for a in raw]

    with _lock:
        _local_ts = ts
        _local_assets = assets
        _local_fetched_at = time.time()
    return ts, assets
