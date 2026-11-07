"""Marchés retirés de la cote et alertes orphelines.

Cas réel : VINE, retiré le 26 août 2026. Son OI est tombé à zéro, une alerte
critique « OI −100 % » est née et elle est restée active plus de deux mois,
car la règle OI sortait sans rien faire dès que l'OI de référence était nul.
"""
from __future__ import annotations

from app import alert_engine, poller

from .conftest import make_asset, make_ctx


def test_un_marche_retire_n_est_pas_collecte():
    universe = [{"name": "BTC", "szDecimals": 5}, {"name": "VINE", "szDecimals": 0, "isDelisted": True}]
    ctxs = [{"markPx": "75000", "openInterest": "10"}, {"markPx": "0.0075", "openInterest": "0.0"}]
    assert [a.coin for a in poller._build_assets(universe, ctxs, {})] == ["BTC"]


def test_un_oi_qui_tombe_a_zero_ne_cree_pas_d_alerte(spy):
    alert_engine.evaluate_all([make_asset("VINE", open_interest=0.0)], make_ctx("VINE", vol_recent=10.0, vol_baseline=10.0))
    assert "open_interest" not in spy.inserted_criteria


def test_une_alerte_oi_figee_par_un_oi_nul_se_resout(spy, active_alerts):
    active_alerts[("VINE", "open_interest")] = {"id": 3050, "coin": "VINE", "criterion": "open_interest"}
    ctx = make_ctx("VINE", prev_oi=0.0, vol_recent=10.0, vol_baseline=10.0)
    alert_engine.evaluate_all([make_asset("VINE", open_interest=0.0)], ctx)
    assert ("VINE", "open_interest") in spy.resolves


def test_les_alertes_d_un_marche_disparu_sont_closes(spy, active_alerts):
    active_alerts[("VINE", "open_interest")] = {"id": 3050, "coin": "VINE", "criterion": "open_interest"}
    active_alerts[("xyz:OLD", "funding_rate")] = {"id": 3051, "coin": "xyz:OLD", "criterion": "funding_rate"}
    alert_engine.evaluate_all([make_asset("BTC")], make_ctx("BTC", vol_recent=10.0, vol_baseline=10.0), None, {"", "xyz"})
    assert ("VINE", "open_interest") in spy.resolves
    assert ("xyz:OLD", "funding_rate") in spy.resolves


def test_un_dex_non_lu_ce_cycle_ne_clot_rien(spy, active_alerts):
    """DEX en panne ou hors du balayage de ce cycle : absence ≠ retrait."""
    active_alerts[("abc:TSLA", "price_change")] = {"id": 7, "coin": "abc:TSLA", "criterion": "price_change"}
    alert_engine.evaluate_all([make_asset("BTC")], make_ctx("BTC", vol_recent=10.0, vol_baseline=10.0), None, {""})
    assert ("abc:TSLA", "price_change") not in spy.resolves


def test_l_arbitrage_n_est_pas_concerne(spy, active_alerts):
    """Les alertes d'arbitrage ont leur propre cycle de vie (état de suivi)."""
    active_alerts[("ZEC", "funding_arb")] = {"id": 8, "coin": "ZEC", "criterion": "funding_arb"}
    alert_engine.evaluate_all([make_asset("BTC")], make_ctx("BTC", vol_recent=10.0, vol_baseline=10.0), None, {""})
    assert ("ZEC", "funding_arb") not in spy.resolves


def test_sans_perimetre_rien_n_est_clos(spy, active_alerts):
    active_alerts[("VINE", "open_interest")] = {"id": 3050, "coin": "VINE", "criterion": "open_interest"}
    alert_engine.evaluate_all([make_asset("BTC")], make_ctx("BTC", vol_recent=10.0, vol_baseline=10.0))
    assert ("VINE", "open_interest") not in spy.resolves
