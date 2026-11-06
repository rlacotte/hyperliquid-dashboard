"""Anti-bruit : hystérésis et refroidissement.

Mesuré sur les alertes réelles avant correction : une alerte « volume » vivait
2 min en médiane et un quart se redéclenchait dans les 10 min suivant sa
résolution (24 % pour le prix) — oscillation autour du seuil.
"""
from __future__ import annotations

from app import alert_engine, config
from app.models import Severity

from .conftest import make_asset, make_ctx


def test_sous_le_seuil_mais_dans_la_zone_d_hysteresis_l_alerte_reste_active(spy, active_alerts):
    """Prix +4 % : sous le seuil de 5 % mais au-dessus de 0,7 × 5 % = 3,5 %."""
    active_alerts[("SOL", "price_change")] = {"id": 1, "coin": "SOL", "criterion": "price_change"}
    alert_engine.evaluate_all([make_asset("SOL", mark_px=104.0)], make_ctx("SOL", vol_recent=10.0, vol_baseline=10.0))
    assert ("SOL", "price_change") not in spy.resolves


def test_sous_la_zone_d_hysteresis_l_alerte_se_resout(spy, active_alerts):
    active_alerts[("SOL", "price_change")] = {"id": 1, "coin": "SOL", "criterion": "price_change"}
    alert_engine.evaluate_all([make_asset("SOL", mark_px=103.0)], make_ctx("SOL", vol_recent=10.0, vol_baseline=10.0))
    assert ("SOL", "price_change") in spy.resolves


def test_hysteresis_sur_le_funding(spy, active_alerts):
    active_alerts[("ETH", "funding_rate")] = {"id": 2, "coin": "ETH", "criterion": "funding_rate"}
    near = config.FUNDING_THRESHOLD_WARN * 0.8
    alert_engine.evaluate_all([make_asset("ETH", funding=near)], make_ctx("ETH", vol_recent=10.0, vol_baseline=10.0))
    assert ("ETH", "funding_rate") not in spy.resolves


def test_hysteresis_sur_le_volume_en_mode_multiple(spy, active_alerts):
    """Le cas le plus bruyant : multiple 2,5× alors que le seuil est 3×."""
    active_alerts[("BTC", "volume")] = {"id": 3, "coin": "BTC", "criterion": "volume"}
    base = config.VOLUME_MIN_RATE_USDPS * 2
    ctx = make_ctx("BTC", vol_recent=base * 2.5, vol_baseline=base)
    alert_engine.evaluate_all([make_asset("BTC")], ctx)
    assert ("BTC", "volume") not in spy.resolves


def test_refroidissement_bloque_une_alerte_qui_renait_aussitot(spy, recently_resolved):
    recently_resolved[("SOL", "price_change")] = {"severity": "warning", "resolved_ts": 0}
    alert_engine.evaluate_all([make_asset("SOL", mark_px=107.0)], make_ctx("SOL", vol_recent=10.0, vol_baseline=10.0))
    assert "price_change" not in spy.inserted_criteria


def test_une_aggravation_en_critique_passe_le_refroidissement(spy, recently_resolved):
    recently_resolved[("SOL", "price_change")] = {"severity": "warning", "resolved_ts": 0}
    alert_engine.evaluate_all([make_asset("SOL", mark_px=115.0)], make_ctx("SOL", vol_recent=10.0, vol_baseline=10.0))
    assert spy.severity_of("price_change") == Severity.CRITICAL.value


def test_critique_apres_critique_reste_bloquee(spy, recently_resolved):
    recently_resolved[("SOL", "price_change")] = {"severity": "critical", "resolved_ts": 0}
    alert_engine.evaluate_all([make_asset("SOL", mark_px=115.0)], make_ctx("SOL", vol_recent=10.0, vol_baseline=10.0))
    assert "price_change" not in spy.inserted_criteria


def test_le_refroidissement_ne_touche_que_le_couple_concerne(spy, recently_resolved):
    recently_resolved[("SOL", "price_change")] = {"severity": "warning", "resolved_ts": 0}
    alert_engine.evaluate_all(
        [make_asset("SOL", mark_px=107.0), make_asset("ETH", mark_px=107.0)],
        make_ctx("SOL", "ETH", vol_recent=10.0, vol_baseline=10.0),
    )
    assert [r[0] for r in spy.inserts if r[2] == "price_change"] == ["ETH"]
