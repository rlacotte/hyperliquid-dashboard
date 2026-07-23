"""Métriques globales de marché : agrégats Hyperliquid + sources externes.

Deux catégories :
- **Agrégats Hyperliquid** (OI totale, volume 24h, funding moyen pondéré, advance/decline) :
  calculés depuis le cache marché en mémoire — 0 appel réseau.
- **Sources externes** (Fear & Greed Index, total marketcap, BTC dominance) :
  fetchés avec un cache TTL pour ne pas spammer les APIs (FNG 1h, CoinGecko 60s).

L'historique est persisté en base pour les sparklines (table global_metrics_history).
"""
from __future__ import annotations

import logging
import threading
import time
from typing import Any

import httpx

from . import config, db
from .models import AssetMarket

logger = logging.getLogger(__name__)

# --- Cache mémoire TTL pour les sources externes -----------------------------
# (évite un aller-retour Postgres à chaque appel ; TTL court pour FNG/CG)
_cache_lock = threading.Lock()
_cache: dict[str, tuple[float, Any]] = {}  # key -> (fetched_at_epoch, payload)


def _cache_get(key: str, ttl_sec: int) -> Any | None:
    with _cache_lock:
        entry = _cache.get(key)
        if entry is None:
            return None
        fetched_at, payload = entry
        if time.time() - fetched_at > ttl_sec:
            return None
        return payload


def _cache_set(key: str, payload: Any) -> None:
    with _cache_lock:
        _cache[key] = (time.time(), payload)


# --- Agrégats Hyperliquid (depuis le cache, 0 appel réseau) ------------------
def compute_hl_aggregates(assets: list[AssetMarket]) -> dict[str, float | int]:
    """Calcule les agrégats depuis la liste d'actifs déjà récupérés."""
    total_oi_usd = sum(a.open_interest_usd for a in assets)
    total_volume = sum(a.day_ntl_vlm for a in assets)
    # Funding moyen pondéré par l'OI en USD (évite le bruit des petits perps)
    if total_oi_usd > 0:
        weighted_funding = sum(a.funding * a.open_interest_usd for a in assets) / total_oi_usd
    else:
        weighted_funding = 0.0
    advance = sum(1 for a in assets if a.change_24h_pct > 0)
    decline = sum(1 for a in assets if a.change_24h_pct < 0)
    return {
        "hl_open_interest_usd": round(total_oi_usd, 0),
        "hl_volume_24h_usd": round(total_volume, 0),
        "hl_avg_funding": round(weighted_funding, 8),
        "hl_advance_count": advance,
        "hl_decline_count": decline,
    }


# --- Sources externes --------------------------------------------------------
async def fetch_fear_greed(client: httpx.AsyncClient) -> dict | None:
    """Fear & Greed Index (alternative.me). Quotidien, historique 30j inclus."""
    cached = _cache_get("fng", config.FNG_CACHE_TTL_SEC)
    if cached is not None:
        return cached
    try:
        resp = await client.get(
            f"{config.FNG_BASE_URL}/",
            params={"limit": "30", "format": "json"},
            timeout=10.0,
        )
        resp.raise_for_status()
        data = resp.json()
        items = data.get("data", [])
        if not items:
            return None
        # items[0] = valeur actuelle, le reste = historique (du plus récent au plus ancien)
        current = items[0]
        history = [int(i["value"]) for i in reversed(items)]  # chronologique (ancien→récent)
        result = {
            "value": int(current["value"]),
            "label": current.get("value_classification", ""),
            "history": history,
            "ts": int(current["timestamp"]) * 1000,
        }
        _cache_set("fng", result)
        return result
    except Exception:
        logger.warning("Fetch Fear & Greed échoué", exc_info=True)
        return None


async def fetch_coingecko_global(client: httpx.AsyncClient) -> dict | None:
    """Total marketcap, BTC dominance, volume global (CoinGecko /global)."""
    cached = _cache_get("coingecko_global", config.COINGECKO_CACHE_TTL_SEC)
    if cached is not None:
        return cached
    headers = {"accept": "application/json"}
    if config.COINGECKO_API_KEY:
        headers["x-cg-demo-api-key"] = config.COINGECKO_API_KEY
    try:
        resp = await client.get(
            f"{config.COINGECKO_BASE_URL}/global",
            headers=headers,
            timeout=10.0,
        )
        resp.raise_for_status()
        data = resp.json().get("data", {})
        result = {
            "total_marketcap_usd": float(data.get("total_market_cap", {}).get("usd", 0)),
            "btc_dominance": float(data.get("market_cap_percentage", {}).get("btc", 0)),
            "eth_dominance": float(data.get("market_cap_percentage", {}).get("eth", 0)),
            "total_volume_usd": float(data.get("total_volume", {}).get("usd", 0)),
            "marketcap_change_24h_pct": float(data.get("market_cap_change_percentage_24h_usd", 0)),
        }
        _cache_set("coingecko_global", result)
        return result
    except Exception:
        logger.warning("Fetch CoinGecko /global échoué", exc_info=True)
        return None


# --- Assemblage complet ------------------------------------------------------
async def collect_all(assets: list[AssetMarket], client: httpx.AsyncClient) -> dict:
    """Rassemble toutes les métriques pour /api/global-metrics.

    Si une source externe échoue, sa section vaut None (le frontend affiche N/A).
    """
    hl = compute_hl_aggregates(assets)
    fng = await fetch_fear_greed(client)
    cg = await fetch_coingecko_global(client)

    now_ms = int(time.time() * 1000)
    return {
        "ts": now_ms,
        "fear_greed": fng,
        "coingecko": cg,
        **hl,
    }


# --- Persistance historique (pour sparklines) --------------------------------
def persist_history(metrics: dict) -> None:
    """Insère un point d'historique par métrique scalaire.

    On persiste les métriques qui changent dans le temps pour les sparklines.
    Évite de stocker les dicts complexes (FNG history déjà fourni par l'API).
    """
    ts = metrics["ts"]
    rows: list[tuple] = []
    # Fear & Greed : on persiste la valeur courante (l'historique long vient de l'API)
    if metrics.get("fear_greed"):
        rows.append((ts, "fear_greed", float(metrics["fear_greed"]["value"])))
    # CoinGecko
    if metrics.get("coingecko"):
        cg = metrics["coingecko"]
        rows.append((ts, "total_marketcap_usd", cg["total_marketcap_usd"]))
        rows.append((ts, "btc_dominance", cg["btc_dominance"]))
    # Agrégats HL
    rows.append((ts, "hl_open_interest_usd", metrics["hl_open_interest_usd"]))
    rows.append((ts, "hl_volume_24h_usd", metrics["hl_volume_24h_usd"]))
    rows.append((ts, "hl_avg_funding", metrics["hl_avg_funding"]))
    total = metrics["hl_advance_count"] + metrics["hl_decline_count"]
    if total > 0:
        rows.append((ts, "hl_advance_ratio", metrics["hl_advance_count"] / total))

    try:
        db.insert_global_metrics_history(rows)
    except Exception:
        logger.exception("Erreur persistance global_metrics_history")
