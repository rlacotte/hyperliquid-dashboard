"""Notifications sortantes : pousse les nouvelles alertes vers Telegram/Discord.

Positionnement dans le cycle : le moteur d'alertes garantit déjà « au plus une
alerte active par (coin, criterion) » — on ne notifie donc que les alertes
*créées* pendant le cycle courant, jamais celles qui restent actives. L'anti-spam
des notifications est ainsi hérité de celui des alertes, sans état supplémentaire.

Un seul message par cycle (liste groupée), pas un par alerte : un cycle agité
peut créer une dizaine d'alertes d'un coup, et dix pings valent moins qu'un
résumé lisible.

Chaque canal échoue indépendamment et en silence (log warning) : une API tierce
en panne ne doit jamais faire échouer la collecte.
"""
from __future__ import annotations

import logging

import httpx

from . import config

logger = logging.getLogger(__name__)

_SEVERITY_RANK = {"info": 0, "warning": 1, "critical": 2}
_SEVERITY_EMOJI = {"info": "ℹ️", "warning": "⚠️", "critical": "🚨"}

# Index des champs dans les tuples d'insertion du _CycleWriter :
# (coin, ts, criterion, severity, message, details, score, direction)
_F_SEVERITY = 3
_F_MESSAGE = 4


def is_configured() -> bool:
    return bool(
        (config.TELEGRAM_BOT_TOKEN and config.TELEGRAM_CHAT_ID) or config.DISCORD_WEBHOOK_URL
    )


def select_notable(created_rows: list[tuple]) -> list[tuple]:
    """Filtre les alertes créées selon NOTIFY_MIN_SEVERITY."""
    floor = _SEVERITY_RANK.get(config.NOTIFY_MIN_SEVERITY, 2)
    return [r for r in created_rows if _SEVERITY_RANK.get(r[_F_SEVERITY], 0) >= floor]


def format_message(rows: list[tuple]) -> str:
    """Un résumé par cycle, alertes les plus sévères en premier."""
    ordered = sorted(rows, key=lambda r: -_SEVERITY_RANK.get(r[_F_SEVERITY], 0))
    lines = [f"⚡ {len(ordered)} nouvelle(s) alerte(s) Hyperliquid"]
    for r in ordered:
        emoji = _SEVERITY_EMOJI.get(r[_F_SEVERITY], "•")
        lines.append(f"{emoji} {r[_F_MESSAGE]}")
    return "\n".join(lines)


async def _send_telegram(client: httpx.AsyncClient, text: str) -> bool:
    resp = await client.post(
        f"https://api.telegram.org/bot{config.TELEGRAM_BOT_TOKEN}/sendMessage",
        json={"chat_id": config.TELEGRAM_CHAT_ID, "text": text},
        timeout=5.0,
    )
    resp.raise_for_status()
    return True


async def _send_discord(client: httpx.AsyncClient, text: str) -> bool:
    # Discord limite le contenu à 2000 caractères.
    resp = await client.post(
        config.DISCORD_WEBHOOK_URL,
        json={"content": text[:2000]},
        timeout=5.0,
    )
    resp.raise_for_status()
    return True


async def notify_new_alerts(created_rows: list[tuple]) -> dict:
    """Envoie le résumé du cycle sur chaque canal configuré.

    Retourne un compte-rendu {canal: bool} inclus dans la réponse du cron —
    c'est le seul endroit où un échec d'envoi est visible de l'extérieur.
    """
    if not created_rows or not is_configured():
        return {}

    notable = select_notable(created_rows)
    if not notable:
        return {}

    text = format_message(notable)
    report: dict[str, bool] = {}

    async with httpx.AsyncClient() as client:
        if config.TELEGRAM_BOT_TOKEN and config.TELEGRAM_CHAT_ID:
            try:
                report["telegram"] = await _send_telegram(client, text)
            except Exception:
                logger.warning("Envoi Telegram échoué", exc_info=True)
                report["telegram"] = False
        if config.DISCORD_WEBHOOK_URL:
            try:
                report["discord"] = await _send_discord(client, text)
            except Exception:
                logger.warning("Envoi Discord échoué", exc_info=True)
                report["discord"] = False

    return report
