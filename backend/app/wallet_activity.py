"""Activité d'un wallet : des fills bruts aux actions lisibles (côté serveur).

Portage de frontend/src/walletActivity.ts, dont il garde les règles pour que
le bot Telegram et le fil d'activité de la page Wallet racontent la même
chose. Différence : le navigateur regroupe les fills par heure de RÉCEPTION
(flux websocket) ; ici on les lit par lots via `userFillsByTime`, donc on
regroupe par heure d'EXÉCUTION.
"""
from __future__ import annotations

from dataclasses import dataclass

# Un groupe est clos après ce silence entre deux fills du même marché…
QUIET_MS = 4_000
# … et ne s'étend jamais au-delà de cette durée.
MAX_SPAN_MS = 30_000

_EPS = 1e-9


@dataclass(frozen=True)
class WalletAction:
    key: str
    user: str
    coin: str
    kind: str  # open | add | reduce | close | flip | liquidation
    side: str  # long | short
    notional: float
    px: float
    pnl: float
    fills: int
    time: int


def _num(v) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def _sign(x: float) -> int:
    return 1 if x > _EPS else -1 if x < -_EPS else 0


def summarize(user: str, coin: str, fills: list[dict]) -> WalletAction | None:
    """Qualifie un groupe de fills d'un même wallet sur un même marché, à partir
    de la position avant le premier fill et après le dernier."""
    if not fills:
        return None
    ordered = sorted(fills, key=lambda f: f.get("time", 0))
    start = _num(ordered[0].get("startPosition"))
    delta = notional = size = pnl = 0.0
    liquidated = False
    for f in ordered:
        sz = _num(f.get("sz"))
        delta += sz if f.get("side") == "B" else -sz
        notional += sz * _num(f.get("px"))
        size += sz
        pnl += _num(f.get("closedPnl"))
        if f.get("liquidation"):
            liquidated = True
    end = start + delta
    # Tolérance relative : un résidu d'arrondi ne transforme pas une clôture en réduction.
    closed = abs(end) <= max(_EPS, abs(start) * 1e-6)

    if liquidated:
        kind = "liquidation"
    elif _sign(start) == 0:
        kind = "open"
    elif not closed and _sign(end) != _sign(start):
        kind = "flip"
    elif closed:
        kind = "close"
    elif abs(end) > abs(start):
        kind = "add"
    else:
        kind = "reduce"

    ref = end if kind in ("open", "add", "flip") else start
    first = ordered[0]
    return WalletAction(
        key=f"{user}|{coin}|{first.get('time')}|{first.get('hash', '')}",
        user=user,
        coin=coin,
        kind=kind,
        side="long" if ref >= 0 else "short",
        notional=notional,
        px=notional / size if size > 0 else 0.0,
        pnl=pnl,
        fills=len(ordered),
        time=int(first.get("time", 0)),
    )


def group_actions(user: str, fills: list[dict]) -> list[WalletAction]:
    """Regroupe par marché les fills rapprochés dans le temps, puis qualifie
    chaque groupe. Rend les actions dans l'ordre chronologique."""
    by_coin: dict[str, list[dict]] = {}
    for f in sorted(fills, key=lambda f: f.get("time", 0)):
        by_coin.setdefault(f.get("coin", ""), []).append(f)

    actions: list[WalletAction] = []
    for coin, coin_fills in by_coin.items():
        group: list[dict] = []
        for f in coin_fills:
            t = f.get("time", 0)
            if group and (t - group[-1].get("time", 0) > QUIET_MS or t - group[0].get("time", 0) > MAX_SPAN_MS):
                a = summarize(user, coin, group)
                if a:
                    actions.append(a)
                group = []
            group.append(f)
        a = summarize(user, coin, group)
        if a:
            actions.append(a)
    return sorted(actions, key=lambda a: a.time)


_KIND_VERB = {
    "open": "ouvre un",
    "add": "renforce son",
    "reduce": "réduit son",
    "close": "clôture son",
    "flip": "bascule en",
    "liquidation": "est LIQUIDÉ sur son",
}


def fmt_usd(v: float) -> str:
    """Même rendu que fmtUsd côté front : $1.2M, $25.0K."""
    if v >= 1e9:
        return f"${v / 1e9:.2f}B"
    if v >= 1e6:
        return f"${v / 1e6:.1f}M"
    if v >= 1e3:
        return f"${v / 1e3:.1f}K"
    return f"${v:.2f}"


def fmt_price(px: float) -> str:
    if px >= 1000:
        return f"{px:,.2f}"
    if px >= 1:
        return f"{px:.2f}"
    if px >= 0.01:
        return f"{px:.4f}"
    return f"{px:.4g}"


def describe(a: WalletAction, label: str) -> tuple[str, str]:
    """(titre, détail) en texte brut — l'appelant échappe pour son format."""
    market = a.coin.split(":", 1)[1] if ":" in a.coin else a.coin
    side = "LONG" if a.side == "long" else "SHORT"
    title = f"{label} {_KIND_VERB[a.kind]} {side} {market}"
    parts = [f"{fmt_usd(a.notional)} à {fmt_price(a.px)}"]
    if a.kind in ("reduce", "close", "liquidation"):
        parts.append(f"PnL réalisé {'+' if a.pnl >= 0 else '-'}{fmt_usd(abs(a.pnl))}")
    return title, " · ".join(parts)
