"""Score de confluence v2 : matrice de régimes Prix x OI.

Chaque quadrant de la matrice a une interprétation trading distincte — c'est
tout l'intérêt de la v2 par rapport à la somme pondérée, qui confondait
« prix monte parce que des acheteurs entrent » et « prix monte parce que des
shorts se couvrent ». Les tests figent cette distinction.
"""
from __future__ import annotations

import pytest

from app import confluence

from .conftest import make_asset, make_ctx


def score_for(px_now: float, oi_now: float, **kw):
    asset = make_asset("X", mark_px=px_now, open_interest=oi_now, funding=kw.pop("funding", 0.0))
    return confluence.compute_confluence(asset, make_ctx("X", **kw))


# Référence : prix précédent 100, OI précédent 1000.
# Seuils : prix warn 5% / crit 10% ; OI warn 10% / crit 20%.
@pytest.mark.parametrize(
    "px, oi, regime, direction",
    [
        (120.0, 1500.0, "strong_bull", "bullish"),      # prix↑ OI↑ : nouveaux acheteurs
        (120.0, 500.0, "short_covering", "bullish"),    # prix↑ OI↓ : couverture de shorts
        (80.0, 1500.0, "strong_bear", "bearish"),       # prix↓ OI↑ : nouveaux shorts
        (80.0, 500.0, "exhaustion", "neutral"),         # prix↓ OI↓ : épuisement
    ],
)
def test_les_quatre_quadrants(px, oi, regime, direction):
    r = score_for(px, oi)
    assert r.regime == regime
    assert r.direction == direction


def test_pas_de_regime_sans_mouvement_sur_les_deux_axes():
    """Un régime exige que le prix ET l'OI franchissent leur seuil.

    C'est la raison pour laquelle la confluence reste muette en marché calme :
    un OI qui s'envole sur un prix immobile ne constitue pas un régime.
    """
    r = score_for(100.5, 5000.0)  # OI +400% mais prix +0.5%
    assert r.regime == "none"
    assert r.score == 0.0
    assert r.direction == "neutral"


def test_les_patterns_fragiles_sont_amortis():
    """short_covering et exhaustion sont moins fiables que les régimes solides."""
    solide = score_for(120.0, 1500.0)
    fragile = score_for(120.0, 500.0)
    epuisement = score_for(80.0, 500.0)

    assert abs(fragile.score) < abs(solide.score)
    assert abs(epuisement.score) < abs(fragile.score)
    assert solide.confidence > fragile.confidence > epuisement.confidence


def test_le_volume_amplifie_sans_changer_la_direction():
    avec = score_for(120.0, 1500.0, vol_recent=50_000.0, vol_baseline=5_000.0)
    sans = score_for(120.0, 1500.0, vol_recent=10.0, vol_baseline=10.0)

    assert avec.regime == sans.regime == "strong_bull"
    assert avec.direction == sans.direction
    assert avec.score > sans.score
    assert avec.volume_confirmed and not sans.volume_confirmed


def test_le_funding_confirme_ou_contredit_le_regime():
    """Funding positif renforce un régime haussier, négatif l'affaiblit."""
    confirme = score_for(120.0, 1500.0, funding=0.002)
    contredit = score_for(120.0, 1500.0, funding=-0.002)

    assert confirme.score > contredit.score


def test_le_score_reste_dans_l_echelle():
    """Même sur des valeurs extrêmes, le score est borné à [-10, +10]."""
    extreme = score_for(1000.0, 100_000.0, funding=0.5, vol_recent=1e9, vol_baseline=1.0)
    assert -10.0 <= extreme.score <= 10.0


def test_serialisation_kv_preserve_le_regime():
    """Le cron écrit les scores, une autre invocation les sert : l'aller-retour
    JSON par la table kv doit conserver les champs de régime."""
    from app import confluence_cache

    original = score_for(120.0, 1500.0)
    restored = confluence_cache._from_dict(confluence_cache.to_dict(original))

    assert restored.regime == original.regime
    assert restored.regime_label == original.regime_label
    assert restored.score == original.score
    assert restored.confidence == original.confidence
    assert len(restored.breakdown) == len(original.breakdown)
