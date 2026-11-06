"""Fixtures partagées.

Les tests tournent sans base : les fonctions d'écriture de `db` sont remplacées
par des espions qui enregistrent ce qui *aurait* été écrit. C'est ce qui permet
de vérifier à la fois la logique métier et la garantie de groupage des requêtes
(cf. test_batching.py) sans dépendre d'un Postgres joignable.
"""
from __future__ import annotations

import os
import sys

import pytest

# La configuration lit DATABASE_URL à l'import ; aucune connexion n'est ouverte.
os.environ.setdefault("DATABASE_URL", "postgresql://test:test@localhost/test")
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import db  # noqa: E402
from app.models import AssetMarket  # noqa: E402

NOW_MS = 1_700_000_000_000


class DbSpy:
    """Capture les écritures d'un cycle et compte les appels."""

    def __init__(self) -> None:
        self.inserts: list[tuple] = []
        self.resolves: list[tuple[str, str]] = []
        self.confluence_updates: list[tuple] = []
        self.kv: list[tuple] = []
        self.calls: dict[str, int] = {"insert": 0, "resolve": 0, "confluence": 0}

    @property
    def inserted_criteria(self) -> list[str]:
        return sorted(r[2] for r in self.inserts)

    def severity_of(self, criterion: str) -> str | None:
        for r in self.inserts:
            if r[2] == criterion:
                return r[3]
        return None


@pytest.fixture
def active_alerts() -> dict:
    """Alertes actives au début du cycle. À peupler pour simuler l'existant."""
    return {}


@pytest.fixture
def recently_resolved() -> dict:
    """Alertes terminées récemment (refroidissement). À peupler si besoin."""
    return {}


@pytest.fixture
def spy(monkeypatch, active_alerts, recently_resolved) -> DbSpy:
    s = DbSpy()

    def insert_alerts_bulk(rows):
        s.calls["insert"] += 1
        s.inserts.extend(rows)
        return len(rows)

    def resolve_alerts_bulk(pairs, ts):
        s.calls["resolve"] += 1
        s.resolves.extend(pairs)
        return len(pairs)

    def update_confluence_alerts_bulk(rows):
        s.calls["confluence"] += 1
        s.confluence_updates.extend(rows)
        return len(rows)

    monkeypatch.setattr(db, "get_active_alerts_map", lambda: dict(active_alerts))
    monkeypatch.setattr(db, "get_recently_resolved_map", lambda since: dict(recently_resolved))
    monkeypatch.setattr(db, "insert_alerts_bulk", insert_alerts_bulk)
    monkeypatch.setattr(db, "resolve_alerts_bulk", resolve_alerts_bulk)
    monkeypatch.setattr(db, "update_confluence_alerts_bulk", update_confluence_alerts_bulk)
    monkeypatch.setattr(db, "count_active_alerts", lambda: 0)
    monkeypatch.setattr(db, "kv_set", lambda k, ts, v: s.kv.append((k, ts, v)))
    return s


def make_asset(
    coin: str = "TEST",
    *,
    mark_px: float = 100.0,
    funding: float = 0.0,
    open_interest: float = 1000.0,
    day_ntl_vlm: float = 1e9,
    change_24h_pct: float = 0.0,
) -> AssetMarket:
    return AssetMarket(
        coin=coin,
        mark_px=mark_px,
        funding=funding,
        open_interest=open_interest,
        open_interest_usd=open_interest * mark_px,
        day_ntl_vlm=day_ntl_vlm,
        change_24h_pct=change_24h_pct,
    )


def make_ctx(
    *coins: str,
    prev_px: float = 100.0,
    prev_oi: float = 1000.0,
    vol_recent: float | None = 50_000.0,
    vol_baseline: float | None = 5_000.0,
) -> db.HistoryContext:
    """HistoryContext pré-chargé, avec le même état passé pour tous les coins."""
    prev = {c: {"open_interest": prev_oi, "mark_px": prev_px, "ts": NOW_MS} for c in coins}
    return db.HistoryContext(
        now_ms=NOW_MS,
        oi_prev=prev,
        price_prev=dict(prev),
        vol_recent={c: vol_recent for c in coins},
        vol_baseline={c: vol_baseline for c in coins},
    )
