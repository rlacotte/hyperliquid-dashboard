"""Replay historique : mécanique de reconstruction et agrégats, sans base.

Les séries sont synthétiques et construites pour que l'issue soit connue
d'avance : un coin qui pompe avec OI croissant (strong_bull garanti, rendement
à +1h positif garanti) et un coin immobile (groupe témoin « none »).
"""
from __future__ import annotations

import pytest

from app import replay

H = 3_600_000
MIN5 = 300_000


def mk_points(px_fn, oi_fn, *, start=0, end=8 * H, step=MIN5, vlm=1e9, funding=0.0):
    """Série (ts, px, funding, oi, vlm) échantillonnée toutes les 5 min."""
    return [
        (t, px_fn(t), funding, oi_fn(t), vlm)
        for t in range(start, end + 1, step)
    ]


def pump_after(base: float, t0: int, slope_per_h: float):
    """Constant jusqu'à t0, puis croissance linéaire de slope_per_h par heure."""
    return lambda t: base if t < t0 else base * (1 + slope_per_h * (t - t0) / H)


@pytest.fixture
def series(monkeypatch):
    data = {
        # Prix +30%/h et OI +100%/h à partir de t=3h : régime strong_bull
        # garanti dès que le lookback de 60 min tombe dans la pente.
        "BULL": mk_points(pump_after(100.0, 3 * H, 0.30), pump_after(1000.0, 3 * H, 1.0)),
        # Témoin parfaitement immobile : ne doit jamais produire de régime.
        "FLAT": mk_points(lambda t: 100.0, lambda t: 1000.0),
    }
    monkeypatch.setattr(replay, "load_series", lambda since, until: data)
    return data


# --- Primitives ---------------------------------------------------------------
def test_value_at_respecte_la_tolerance():
    points = [(0, 1.0, 0.0, 1.0, 1.0), (10 * MIN5, 2.0, 0.0, 1.0, 1.0)]
    assert replay.value_at(points, 10 * MIN5 + 60_000)[1] == 2.0  # à 1 min : ok
    assert replay.value_at(points, 25 * MIN5) is None  # à 75 min du plus proche


def test_volume_rate_exige_deux_points():
    points = [(0, 1.0, 0.0, 1.0, 1000.0)]
    assert replay._volume_rate(points, 0, MIN5) is None


def test_volume_rate_mesure_la_pente():
    # +600 USD de volume cumulé en 60 s -> 10 USD/s
    points = [(0, 1.0, 0.0, 1.0, 1000.0), (60_000, 1.0, 0.0, 1.0, 1600.0)]
    assert replay._volume_rate(points, 0, 60_000) == pytest.approx(10.0)


# --- Run complet ---------------------------------------------------------------
def test_le_pump_est_detecte_et_gagne(series):
    result = replay.run(0, 8 * H, 30 * 60_000, [60])

    bull = result["regimes"]["strong_bull"]["horizons"]["60min"]
    assert bull["n"] >= 1
    # Le prix monte de façon monotone après le signal : 100% de réussite attendu
    assert bull["hit_rate"] == 1.0
    assert bull["avg_pct"] > 0

    # Tous les signaux viennent du coin qui pompe, jamais du témoin
    assert {e["coin"] for e in result["examples"]} == {"BULL"}


def test_le_temoin_alimente_le_groupe_none(series):
    result = replay.run(0, 8 * H, 30 * 60_000, [60])

    none = result["regimes"]["none"]["horizons"]["60min"]
    assert none["n"] > 0
    # Aucun pari directionnel dans le groupe témoin
    assert none["hit_rate"] is None


def test_la_grille_respecte_warmup_et_horizon(series):
    """Warm-up 2h (baseline volume) + dernier horizon mesurable : sur 8h avec
    un horizon de 60 min, la grille couvre [2h, 7h] -> 11 points au pas de 30 min."""
    result = replay.run(0, 8 * H, 30 * 60_000, [60])
    assert result["grid_points"] == 11


def test_fenetre_trop_courte_grille_vide(series):
    """3h de fenêtre - 2h de warm-up - 4h d'horizon : rien d'évaluable."""
    result = replay.run(0, 3 * H, 30 * 60_000, [240])
    assert result["grid_points"] == 0
    assert result["signals"] == 0
