"""Arbitrage de funding : écarts, suivi de leur durée, alertes."""
from __future__ import annotations

import time

import pytest

from app import alert_engine, config
from app import funding_arb as fa
from app.models import Severity

from .conftest import make_ctx

M = 60_000
H = 3600_000


def venue(rate, h):
    return {"fundingRate": str(rate), "nextFundingTime": 0, "fundingIntervalHours": h}


# --- Écarts ------------------------------------------------------------------------
def test_annualisation_heures_vs_8h():
    assert fa.annualize(0.0001, 1) == pytest.approx(fa.annualize(0.0008, 8))


def test_shorte_le_funding_le_plus_haut_avec_hyperliquid_obligatoire():
    s = fa.compute_spreads([["BTC", [["HlPerp", venue(0.0001, 1)], ["BinPerp", venue(0.0001, 8)], ["BybitPerp", venue(-0.01, 8)]]]])["BTC"]
    # Binance ↔ Bybit aurait l'écart le plus grand, mais n'inclut pas HL.
    assert "HlPerp" in (s["short"], s["long"])
    assert s["short"] == "HlPerp" and s["long"] == "BybitPerp"


def test_coin_sans_hyperliquid_ignore():
    assert fa.compute_spreads([["X", [["BinPerp", venue(0.01, 8)], ["BybitPerp", venue(-0.01, 8)]]]]) == {}


# --- Suivi de la durée ----------------------------------------------------------------
def spreads(apr=0.5, short="HlPerp", long_="BinPerp"):
    return {"ETH": {"short": short, "long": long_, "spread_apr": apr, "aprs": {}}}


OI = {"ETH": 5e6}


def test_un_ecart_continu_garde_son_origine():
    s1 = fa.update_state({}, spreads(), OI, 0)
    s2 = fa.update_state(s1, spreads(0.6), OI, 5 * M)
    assert s2["ETH"]["since"] == 0
    assert s2["ETH"]["max_apr"] == 0.6


def test_un_changement_de_sens_est_un_nouvel_ecart():
    s1 = fa.update_state({}, spreads(), OI, 0)
    s2 = fa.update_state(s1, spreads(short="BinPerp", long_="HlPerp"), OI, 5 * M)
    assert s2["ETH"]["since"] == 5 * M


def test_un_trou_de_suivi_remet_le_compteur_a_zero():
    s1 = fa.update_state({}, spreads(), OI, 0)
    s2 = fa.update_state(s1, spreads(), OI, 2 * H)  # aucune passe pendant 2 h
    assert s2["ETH"]["since"] == 2 * H


def test_sous_le_seuil_de_suivi_ou_sans_profondeur_pas_de_suivi():
    assert fa.update_state({}, spreads(apr=config.ARB_TRACK_MIN_APR / 2), OI, 0) == {}
    assert fa.update_state({}, spreads(), {"ETH": 1_000}, 0) == {}


def test_etat_perime_ignore(monkeypatch):
    monkeypatch.setattr(fa.db, "kv_get", lambda k: (0, {"coins": {"ETH": {}}}))
    assert fa.current_state(now_ms=4 * config.ARB_REFRESH_SEC * 1000) is None
    assert fa.current_state(now_ms=config.ARB_REFRESH_SEC * 1000) is not None


# --- Alertes ------------------------------------------------------------------------
def real_now() -> int:
    """evaluate_all mesure les durées sur l'heure RÉELLE : les tests aussi."""
    return int(time.time() * 1000)


def tracked(apr, since, now):
    return {"ETH": {"short": "HlPerp", "long": "BinPerp", "spread_apr": apr, "since": since, "max_apr": apr, "last": now, "oi_usd": 5e6}}


def test_pas_d_alerte_avant_la_duree_minimale(spy):
    now = real_now()
    alert_engine.evaluate_all([], make_ctx(), tracked(0.8, now - 30 * M, now))
    assert spy.inserted_criteria == []


def test_alerte_sur_ecart_large_et_persistant(spy):
    now = real_now()
    alert_engine.evaluate_all([], make_ctx(), tracked(0.8, now - 3 * H, now))
    assert spy.inserted_criteria == ["funding_arb"]
    assert spy.severity_of("funding_arb") == Severity.CRITICAL.value
    msg = spy.inserts[0][4]
    assert "short Hyperliquid / long Binance" in msg


def test_severite_warning_entre_les_seuils(spy):
    now = real_now()
    alert_engine.evaluate_all([], make_ctx(), tracked(0.4, now - 3 * H, now))
    assert spy.severity_of("funding_arb") == Severity.WARNING.value


def test_hysteresis_puis_resolution(spy, active_alerts):
    now = real_now()
    active_alerts[("ETH", "funding_arb")] = {"id": 1, "coin": "ETH", "criterion": "funding_arb"}
    # 25 %/an : sous le seuil (30 %) mais au-dessus de 0,7 × 30 % → reste active.
    alert_engine.evaluate_all([], make_ctx(), tracked(0.25, now - 3 * H, now))
    assert spy.resolves == []
    alert_engine.evaluate_all([], make_ctx(), tracked(0.10, now - 3 * H, now))
    assert ("ETH", "funding_arb") in spy.resolves


def test_ecart_sorti_du_suivi_resout_l_alerte(spy, active_alerts):
    active_alerts[("ETH", "funding_arb")] = {"id": 1, "coin": "ETH", "criterion": "funding_arb"}
    alert_engine.evaluate_all([], make_ctx(), {})
    assert ("ETH", "funding_arb") in spy.resolves


def test_etat_perime_ne_resout_rien(spy, active_alerts):
    """None = taux indisponibles : on ne conclut rien plutôt que tout résoudre."""
    active_alerts[("ETH", "funding_arb")] = {"id": 1, "coin": "ETH", "criterion": "funding_arb"}
    alert_engine.evaluate_all([], make_ctx(), None)
    assert spy.resolves == []
