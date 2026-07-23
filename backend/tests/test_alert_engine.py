"""Moteur d'alertes : déclenchement, sévérité, anti-spam, résolution."""
from __future__ import annotations

from app import alert_engine
from app.models import Criterion, Severity

from .conftest import make_asset, make_ctx

ALL_CRITERIA = ["confluence", "funding_rate", "open_interest", "price_change", "volume"]


def test_marche_calme_aucune_alerte(spy):
    """Sous tous les seuils : rien ne doit être créé."""
    asset = make_asset("BTC", mark_px=100.0, funding=0.00001, open_interest=1000.0)
    ctx = make_ctx("BTC", vol_recent=100.0, vol_baseline=100.0)

    alert_engine.evaluate_all([asset], ctx)

    assert spy.inserts == []
    assert spy.resolves == []


def test_seuils_critiques_declenchent_les_cinq_criteres(spy):
    """funding 0.2%, prix +20%, OI +50%, volume 10x -> les 5 critères."""
    asset = make_asset("ETH", mark_px=120.0, funding=0.002, open_interest=1500.0)
    ctx = make_ctx("ETH")

    alert_engine.evaluate_all([asset], ctx)

    assert spy.inserted_criteria == ALL_CRITERIA
    for criterion in ("funding_rate", "price_change", "open_interest"):
        assert spy.severity_of(criterion) == Severity.CRITICAL.value


def test_severite_warning_entre_les_deux_seuils(spy):
    """Prix +7% : au-dessus du seuil warn (5%) mais sous le crit (10%)."""
    asset = make_asset("SOL", mark_px=107.0)
    ctx = make_ctx("SOL", vol_recent=10.0, vol_baseline=10.0)

    alert_engine.evaluate_all([asset], ctx)

    assert spy.severity_of("price_change") == Severity.WARNING.value


def test_alerte_deja_active_pas_de_doublon(spy, active_alerts):
    """L'anti-spam : tant qu'une alerte est active, on n'en recrée pas."""
    active_alerts[("ETH", "funding_rate")] = {"id": 1, "coin": "ETH", "criterion": "funding_rate"}
    asset = make_asset("ETH", funding=0.002)
    ctx = make_ctx("ETH", vol_recent=10.0, vol_baseline=10.0)

    alert_engine.evaluate_all([asset], ctx)

    assert "funding_rate" not in spy.inserted_criteria
    assert spy.resolves == []


def test_condition_normalisee_resout_l_alerte(spy, active_alerts):
    active_alerts[("SOL", "price_change")] = {"id": 7, "coin": "SOL", "criterion": "price_change"}
    asset = make_asset("SOL", mark_px=100.0)  # identique au prix précédent
    ctx = make_ctx("SOL", vol_recent=10.0, vol_baseline=10.0)

    alert_engine.evaluate_all([asset], ctx)

    assert ("SOL", "price_change") in spy.resolves


def test_confluence_active_est_mise_a_jour_pas_reinseree(spy, active_alerts):
    """Le score de confluence évolue en continu : on rafraîchit l'alerte."""
    active_alerts[("AVAX", "confluence")] = {"id": 9, "coin": "AVAX", "criterion": "confluence"}
    asset = make_asset("AVAX", mark_px=120.0, funding=0.002, open_interest=1500.0)
    ctx = make_ctx("AVAX")

    alert_engine.evaluate_all([asset], ctx)

    assert "confluence" not in spy.inserted_criteria
    assert len(spy.confluence_updates) == 1
    coin, criterion, score, *_ = spy.confluence_updates[0]
    assert (coin, criterion) == ("AVAX", Criterion.CONFLUENCE.value)
    assert score > 0  # régime haussier


def test_coin_sans_historique_est_ignore(spy):
    """Un perp tout juste listé n'a pas d'historique : aucun crash, aucune alerte."""
    from app.db import HistoryContext

    alert_engine.evaluate_all([make_asset("NEW")], HistoryContext(now_ms=0))

    assert spy.inserts == []


def test_oi_a_zero_n_entraine_pas_de_division_par_zero(spy):
    """prev.open_interest == 0 : le critère OI doit être sauté proprement."""
    asset = make_asset("ZERO", mark_px=120.0, open_interest=1500.0)
    ctx = make_ctx("ZERO", prev_oi=0.0)

    alert_engine.evaluate_all([asset], ctx)

    assert "open_interest" not in spy.inserted_criteria


def test_volume_sans_historique_suffisant_est_ignore(spy):
    """vol_recent None = un seul point dans la fenêtre : pas d'évaluation."""
    asset = make_asset("THIN", mark_px=100.0)
    ctx = make_ctx("THIN", vol_recent=None, vol_baseline=None)

    alert_engine.evaluate_all([asset], ctx)

    assert "volume" not in spy.inserted_criteria
