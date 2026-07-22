"""Derniers scores de confluence (1 par coin), partagés cron -> API.

Les scores changent à chaque cycle, on ne les historise donc pas : on garde
seulement le snapshot courant. Mais comme pour le snapshot marché, ce courant
doit traverser la frontière entre l'invocation du cron et celle qui sert
`/api/confluence` — il vit donc dans la table `kv`, avec un cache mémoire à TTL
par-dessus pour les instances chaudes.
"""
from __future__ import annotations

import threading
import time
from dataclasses import asdict

from . import db
from .confluence import ConfluenceResult, SignalScore
from .models import Criterion

_KEY = "latest_confluence"
_TTL_SEC = 5.0

_lock = threading.Lock()
_local_ts: int = 0
_local_scores: dict[str, ConfluenceResult] = {}
_local_fetched_at: float = 0.0


def to_dict(result: ConfluenceResult) -> dict:
    d = asdict(result)
    # Les enum Criterion doivent être sérialisés en string
    d["breakdown"] = [
        {**b, "criterion": b["criterion"].value if hasattr(b["criterion"], "value") else b["criterion"]}
        for b in d["breakdown"]
    ]
    return d


def _from_dict(d: dict) -> ConfluenceResult:
    return ConfluenceResult(
        coin=d["coin"],
        score=d["score"],
        direction=d["direction"],
        active_count=d["active_count"],
        regime=d.get("regime", "none"),
        regime_label=d.get("regime_label", ""),
        confidence=d.get("confidence", 0.0),
        volume_confirmed=d.get("volume_confirmed", False),
        breakdown=[
            SignalScore(
                criterion=Criterion(b["criterion"]),
                score=b["score"],
                direction=b["direction"],
                value=b["value"],
                active=b["active"],
                label=b["label"],
            )
            for b in d["breakdown"]
        ],
    )


def set_confluence_scores(ts: int, results: list[ConfluenceResult]) -> None:
    global _local_ts, _local_scores, _local_fetched_at
    db.kv_set(_KEY, ts, [to_dict(r) for r in results])
    with _lock:
        _local_ts = ts
        _local_scores = {r.coin: r for r in results}
        _local_fetched_at = time.time()


def _load() -> tuple[int, dict[str, ConfluenceResult]]:
    global _local_ts, _local_scores, _local_fetched_at
    with _lock:
        if _local_scores and (time.time() - _local_fetched_at) < _TTL_SEC:
            return _local_ts, _local_scores

    stored = db.kv_get(_KEY)
    if stored is None:
        return 0, {}
    ts, raw = stored
    scores = {d["coin"]: _from_dict(d) for d in raw}

    with _lock:
        _local_ts = ts
        _local_scores = scores
        _local_fetched_at = time.time()
    return ts, scores


def get_confluence_scores() -> tuple[int, list[ConfluenceResult]]:
    ts, scores = _load()
    # Tri par amplitude de score décroissante (signaux forts en premier)
    ranked = sorted(scores.values(), key=lambda r: abs(r.score), reverse=True)
    return ts, ranked


def get_confluence_score(coin: str) -> ConfluenceResult | None:
    _, scores = _load()
    return scores.get(coin)
