"""Métriques globales : agrégats et dégradation des sources externes."""
from __future__ import annotations

import pytest

from app import global_metrics as gm

from .conftest import make_asset


@pytest.fixture
def assets():
    return [
        make_asset("BTC", mark_px=100.0, funding=0.001, open_interest=100.0, day_ntl_vlm=5000.0, change_24h_pct=0.05),
        make_asset("ETH", mark_px=50.0, funding=-0.002, open_interest=20.0, day_ntl_vlm=2000.0, change_24h_pct=-0.02),
        make_asset("SOL", mark_px=10.0, funding=0.05, open_interest=1.0, day_ntl_vlm=100.0, change_24h_pct=0.0),
    ]


def test_agregats_de_base(assets):
    agg = gm.compute_hl_aggregates(assets)
    assert agg["hl_open_interest_usd"] == 100 * 100 + 20 * 50 + 1 * 10
    assert agg["hl_volume_24h_usd"] == 7100
    # change_24h_pct == 0 ne compte ni en hausse ni en baisse
    assert agg["hl_advance_count"] == 1
    assert agg["hl_decline_count"] == 1


def test_le_funding_moyen_est_pondere_par_l_oi(assets):
    """SOL affiche +5% de funding mais ne pèse que 10$ d'OI.

    En moyenne simple il dominerait l'indicateur (+1.6%) et rendrait la tuile
    inutilisable. La pondération par l'OI le ramène à sa part réelle.
    """
    agg = gm.compute_hl_aggregates(assets)
    moyenne_simple = (0.001 - 0.002 + 0.05) / 3

    attendu = (0.001 * 10000 + -0.002 * 1000 + 0.05 * 10) / 11010
    assert agg["hl_avg_funding"] == pytest.approx(attendu, abs=1e-8)
    assert agg["hl_avg_funding"] < moyenne_simple / 10


def test_aucun_actif_ne_divise_pas_par_zero():
    agg = gm.compute_hl_aggregates([])
    assert agg["hl_avg_funding"] == 0.0
    assert agg["hl_open_interest_usd"] == 0


def test_persistance_complete(monkeypatch):
    rows = []
    monkeypatch.setattr(gm.db, "insert_global_metrics_history", rows.extend)

    gm.persist_history({
        "ts": 1,
        "fear_greed": {"value": 31},
        "coingecko": {"total_marketcap_usd": 2.3e12, "btc_dominance": 56.65},
        "hl_open_interest_usd": 11010.0,
        "hl_volume_24h_usd": 7100.0,
        "hl_avg_funding": 0.00077,
        "hl_advance_count": 1,
        "hl_decline_count": 1,
    })

    metriques = [r[1] for r in rows]
    assert "fear_greed" in metriques and "btc_dominance" in metriques
    assert dict((r[1], r[2]) for r in rows)["hl_advance_ratio"] == 0.5


def test_une_source_externe_absente_n_interrompt_pas_la_serie(monkeypatch):
    """Si FNG et CoinGecko tombent, les agrégats HL doivent continuer d'être
    persistés — sinon la sparkline se troue à chaque incident d'API tierce."""
    rows = []
    monkeypatch.setattr(gm.db, "insert_global_metrics_history", rows.extend)

    gm.persist_history({
        "ts": 1,
        "fear_greed": None,
        "coingecko": None,
        "hl_open_interest_usd": 11010.0,
        "hl_volume_24h_usd": 7100.0,
        "hl_avg_funding": 0.00077,
        "hl_advance_count": 1,
        "hl_decline_count": 1,
    })

    assert [r[1] for r in rows] == [
        "hl_open_interest_usd",
        "hl_volume_24h_usd",
        "hl_avg_funding",
        "hl_advance_ratio",
    ]
