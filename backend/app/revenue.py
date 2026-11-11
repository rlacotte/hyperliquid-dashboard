"""Revenus des protocoles cotés sur Hyperliquid et multiples de valorisation.

Sources :
- DefiLlama, vue « revenus » (dataType=dailyRevenue) : la part des frais que
  garde le protocole (trésorerie + détenteurs), par protocole et par chaîne ;
- DefiLlama, vue « revenus aux détenteurs » (dataType=dailyHoldersRevenue) :
  la part qui revient aux détenteurs du token (rachats, burns, distributions) ;
- DefiLlama /config : rattache chaque protocole à son token (symbole, id
  CoinGecko, protocole parent) et dit quelles chaînes sont des L2 ;
- CoinGecko /coins/markets : capitalisation (MC) et valorisation totalement
  diluée (FDV).

Rattachement à Hyperliquid : un token est retenu s'il est coté en perp sur le
DEX principal, ou en spot quand le protocole tourne sur Hyperliquid (sinon un
symbole spot générique risquerait de désigner un autre token). Deux protocoles
partageant un symbole : on garde le token de plus grosse capitalisation.

Coût : ~17 Mo de JSON toutes les 3 h, dans le cycle de collecte. Le résultat
(~120 lignes) est gardé en kv et servi par /api/revenue.
"""
from __future__ import annotations

import asyncio
import logging
import re
from collections import Counter, defaultdict
from dataclasses import dataclass, field

import httpx

from . import config, db

logger = logging.getLogger(__name__)

_KV_KEY = "revenue"
_ATTEMPT_KEY = "revenue_attempt"
REFRESH_MS = 3 * 3600_000
# Un échec (DefiLlama lent, CoinGecko limité) se retente au bout de 10 min.
RETRY_MS = 10 * 60_000

LLAMA_REVENUE_URL = (
    "https://api.llama.fi/overview/fees"
    "?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true&dataType=dailyRevenue"
)
LLAMA_HOLDERS_URL = (
    "https://api.llama.fi/overview/fees"
    "?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true&dataType=dailyHoldersRevenue"
)
LLAMA_CONFIG_URL = "https://api.llama.fi/config"

# Sous-onglets : catégorie DefiLlama → onglet.
TABS: dict[str, tuple[str, ...]] = {
    "dex": ("Dexs", "DEX Aggregator", "Interface", "Liquidity Manager", "Liquidity Automation"),
    "derivatives": ("Derivatives", "Options", "Prediction Market", "Options Vault"),
    "lending": ("Lending", "CDP", "NFT Lending", "Risk Curators", "Onchain Capital Allocator", "Leveraged Farming"),
    "staking": ("Liquid Staking", "Liquid Restaking", "Restaking", "Staking Pool", "Staking"),
    "stable": ("Stablecoin Issuer", "Basis Trading", "RWA", "Yield", "Yield Aggregator", "Reserve Currency", "CeDeFi", "Farm", "Indexes"),
    "launchpad": ("Launchpad", "Trading App", "Telegram Bot", "SoFi", "Gaming", "Gamified Mining", "NFT Marketplace", "AI Agents", "Luck Games"),
    "infra": (
        "Oracle", "Bridge", "Cross Chain Bridge", "Canonical Bridge", "DePIN", "Services", "Developer Tools", "MEV",
        "Privacy", "Domains", "Payments", "Wallets", "DAO Service Provider", "Decentralized AI", "Block Builders",
        "Crypto Card Issuer", "Onchain Voting",
    ),
}
_TAB_OF = {cat: tab for tab, cats in TABS.items() for cat in cats}
# Une activité « produit » peut l'emporter sur la chaîne du même token (HYPE :
# le DEX de perps rapporte bien plus que les frais de la L1). Un pont ou une
# fondation, jamais : NEAR et SUI restent des L1.
_PRODUCT_TABS = {"dex", "derivatives", "lending", "staking", "stable", "launchpad"}


def tab_of(category: str | None) -> str:
    return _TAB_OF.get(category or "", "other")


@dataclass
class Group:
    """Une entité DefiLlama à revenus : chaîne, protocole parent ou protocole seul."""

    key: str
    name: str
    kind: str  # chain | protocol
    symbol: str
    gecko_id: str | None
    tab: str = "other"
    category: str | None = None
    on_hyperliquid: bool = False
    r24: float = 0.0
    r30: float = 0.0
    r60: float = 0.0  # 30 jours précédents
    r1y: float = 0.0
    _cats: Counter = field(default_factory=Counter)


def _num(v) -> float:
    try:
        return float(v or 0)
    except (TypeError, ValueError):
        return 0.0


def build_groups(revenue_protocols: list[dict], cfg: dict, keep_all: bool = False) -> list[Group]:
    """Agrège les entrées de revenus par chaîne, par parent ou par protocole.

    keep_all : garde aussi les groupes à zéro ou sans token — pour les revenus
    aux détenteurs, « publié à 0 » et « non publié » ne disent pas la même chose."""
    protos = {str(p.get("id")): p for p in cfg.get("protocols", [])}
    parents = {p.get("id"): p for p in cfg.get("parentProtocols", [])}
    chains = cfg.get("chainCoingeckoIds", {})
    groups: dict[str, Group] = {}

    for e in revenue_protocols:
        chains_of_entry = e.get("chains") or []
        if e.get("protocolType") == "chain":
            meta = chains.get(e.get("name")) or {}
            parent_types = (meta.get("parent") or {}).get("types") or []
            key = f"chain:{e.get('name')}"
            g = groups.get(key) or Group(
                key=key,
                name=e.get("displayName") or e.get("name") or "",
                kind="chain",
                symbol=(meta.get("symbol") or "").upper(),
                gecko_id=meta.get("geckoId"),
                tab="l2" if "L2" in parent_types else "l1",
                category="L2" if "L2" in parent_types else "L1",
            )
            g.on_hyperliquid = g.on_hyperliquid or e.get("name") == "Hyperliquid L1"
        else:
            parent_id = e.get("parentProtocol")
            if parent_id and parent_id in parents:
                meta = parents[parent_id]
                key, name, gid = f"parent:{parent_id}", meta.get("name") or "", meta.get("gecko_id")
            else:
                meta = protos.get(str(e.get("defillamaId"))) or {}
                key, name, gid = f"protocol:{e.get('defillamaId')}", e.get("displayName") or e.get("name") or "", meta.get("gecko_id")
            g = groups.get(key) or Group(key=key, name=name, kind="protocol", symbol=(meta.get("symbol") or "").upper(), gecko_id=gid)
            g._cats[e.get("category")] += _num(e.get("total30d"))
            if any(c in ("Hyperliquid L1", "Hyperliquid") for c in chains_of_entry):
                g.on_hyperliquid = True
        g.r24 += _num(e.get("total24h"))
        g.r30 += _num(e.get("total30d"))
        g.r60 += _num(e.get("total60dto30d"))
        g.r1y += _num(e.get("total1y"))
        groups[key] = g

    for g in groups.values():
        if g.kind == "protocol" and g._cats:
            g.category = g._cats.most_common(1)[0][0]
            g.tab = tab_of(g.category)
    if keep_all:
        return list(groups.values())
    return [g for g in groups.values() if g.symbol and g.symbol != "-" and g.gecko_id and g.r30 > 0]


_K_PREFIX = re.compile(r"^k[A-Z0-9]")


def hl_symbol(name: str) -> str:
    """kPEPE (perp coté par 1 000 unités) → PEPE."""
    return name[1:].upper() if _K_PREFIX.match(name) else name.upper()


def candidates(groups: list[Group], perp_symbols: set[str], spot_symbols: set[str]) -> dict[str, list[Group]]:
    """Groupes rattachables à un symbole coté sur Hyperliquid, par symbole."""
    out: dict[str, list[Group]] = defaultdict(list)
    for g in groups:
        if g.symbol in perp_symbols or (g.symbol in spot_symbols and g.on_hyperliquid):
            out[g.symbol].append(g)
    return out


def _token_tab(groups: list[Group]) -> tuple[str, str | None]:
    chains = [g for g in groups if g.kind == "chain"]
    protocols = sorted((g for g in groups if g.kind == "protocol"), key=lambda g: -g.r30)
    if chains:
        chain = max(chains, key=lambda g: g.r30)
        top = protocols[0] if protocols else None
        if top and top.tab in _PRODUCT_TABS and top.r30 > chain.r30:
            return top.tab, top.category
        return chain.tab, chain.category
    return (protocols[0].tab, protocols[0].category) if protocols else ("other", None)


def _pct(v) -> float | None:
    """CoinGecko donne des pourcentages (12.5) ; on stocke des fractions (0.125)."""
    try:
        return float(v) / 100 if v is not None else None
    except (TypeError, ValueError):
        return None


def _holders(same: list[Group], holders: dict[str, Group]) -> dict:
    """Revenus aux détenteurs des mêmes entités ; None si DefiLlama n'en publie
    pour aucune (inconnu, à ne pas confondre avec zéro)."""
    found = [holders[g.key] for g in same if g.key in holders]
    if not found:
        return {"hold_30d": None, "hold_prev_30d": None, "hold_1y": None}
    return {
        "hold_30d": sum(h.r30 for h in found),
        "hold_prev_30d": sum(h.r60 for h in found),
        "hold_1y": sum(h.r1y for h in found),
    }


def assemble(
    by_symbol: dict[str, list[Group]],
    markets: dict[str, dict],
    perp_symbols: set[str],
    holders: dict[str, Group] | None = None,
) -> list[dict]:
    rows: list[dict] = []
    for symbol, groups in by_symbol.items():
        priced = [g for g in groups if g.gecko_id in markets]
        if not priced:
            continue
        # Symbole partagé : le token de plus grosse capitalisation l'emporte.
        best = max(priced, key=lambda g: _num(markets[g.gecko_id].get("market_cap")))
        same = [g for g in priced if g.gecko_id == best.gecko_id]
        m = markets[best.gecko_id]
        tab, category = _token_tab(same)
        r30 = sum(g.r30 for g in same)
        r60 = sum(g.r60 for g in same)
        rows.append(
            {
                "symbol": symbol,
                "name": max(same, key=lambda g: g.r30).name,
                "gecko_id": best.gecko_id,
                "tab": tab,
                "category": category,
                "listed": "perp" if symbol in perp_symbols else "spot",
                "rev_24h": sum(g.r24 for g in same),
                "rev_30d": r30,
                "rev_prev_30d": r60,
                "rev_1y": sum(g.r1y for g in same),
                **_holders(same, holders or {}),
                "mcap": _num(m.get("market_cap")) or None,
                "fdv": _num(m.get("fully_diluted_valuation")) or None,
                "price": _num(m.get("current_price")) or None,
                "px_chg_7d": _pct(m.get("price_change_percentage_7d_in_currency")),
                "px_chg_30d": _pct(m.get("price_change_percentage_30d_in_currency")),
                "sources": [
                    {"name": g.name, "kind": g.kind, "category": g.category, "rev_30d": g.r30}
                    for g in sorted(same, key=lambda g: -g.r30)
                ],
            }
        )
    return sorted(rows, key=lambda r: -r["rev_30d"])


# --- Collecte -----------------------------------------------------------------------
async def _get_json(client: httpx.AsyncClient, url: str, **kw):
    resp = await client.get(url, timeout=httpx.Timeout(45.0, connect=10.0), **kw)
    resp.raise_for_status()
    return resp.json()


async def _coingecko_markets(client: httpx.AsyncClient, ids: list[str]) -> dict[str, dict]:
    headers = {"Accept": "application/json"}
    if config.COINGECKO_API_KEY:
        headers["x-cg-demo-api-key"] = config.COINGECKO_API_KEY
    out: dict[str, dict] = {}
    for i in range(0, len(ids), 250):
        chunk = ids[i : i + 250]
        data = await _get_json(
            client,
            f"{config.COINGECKO_BASE_URL}/coins/markets",
            # Variations 7 j et 30 j : la « dynamique du prix » du modèle de sélection.
            params={"vs_currency": "usd", "ids": ",".join(chunk), "per_page": 250, "price_change_percentage": "7d,30d"},
            headers=headers,
        )
        out.update({m["id"]: m for m in data if isinstance(m, dict) and m.get("id")})
    return out


async def refresh(http: httpx.AsyncClient, hl_client, perp_names: list[str], now_ms: int) -> dict:
    revenue_raw, holders_raw, cfg, spot = await asyncio.gather(
        _get_json(http, LLAMA_REVENUE_URL),
        _get_json(http, LLAMA_HOLDERS_URL),
        _get_json(http, LLAMA_CONFIG_URL),
        hl_client._post_info({"type": "spotMeta"}),
    )
    groups = build_groups(revenue_raw.get("protocols", []), cfg)
    holders = {g.key: g for g in build_groups(holders_raw.get("protocols", []), cfg, keep_all=True)}
    perp_symbols = {hl_symbol(n) for n in perp_names}
    spot_symbols = {str(t.get("name", "")).upper() for t in spot.get("tokens", [])}
    by_symbol = candidates(groups, perp_symbols, spot_symbols)
    ids = sorted({g.gecko_id for gs in by_symbol.values() for g in gs if g.gecko_id})
    markets = await _coingecko_markets(http, ids)
    rows = assemble(by_symbol, markets, perp_symbols, holders)
    payload = {"ts": now_ms, "rows": rows}
    db.kv_set(_KV_KEY, now_ms, payload)
    return {"tokens": len(rows), "candidates": len(ids)}


async def maybe_refresh(http: httpx.AsyncClient, hl_client, perp_names: list[str], now_ms: int) -> dict | None:
    stored = db.kv_get(_KV_KEY)
    if stored and now_ms - stored[0] < REFRESH_MS:
        return None
    if not db.try_claim(_ATTEMPT_KEY, now_ms, RETRY_MS):
        return None
    return await refresh(http, hl_client, perp_names, now_ms)


def current() -> dict | None:
    stored = db.kv_get(_KV_KEY)
    return stored[1] if stored else None
