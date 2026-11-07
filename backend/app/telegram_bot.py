"""Bot Telegram : mouvements des wallets suivis et alertes critiques, onglet fermé.

Pourquoi : les notifications du navigateur exigent un onglet ouvert. Le bot
lit côté serveur, à chaque cycle de collecte, l'activité des wallets que les
visiteurs ont reliés à leur conversation Telegram.

Sans compte utilisateur :
1. le navigateur crée un abonnement et reçoit un code aléatoire (le serveur
   n'en garde que l'empreinte SHA-256) ;
2. il ouvre t.me/<bot>?start=<code> ; l'appui sur « Démarrer » nous renvoie le
   code avec l'identifiant de conversation, ce qui relie les deux ;
3. le navigateur synchronise ensuite sa liste de suivi sous ce code.

Coût : une requête userFillsByTime par wallet et par cycle, plafonnée
(TG_MAX_WALLETS_PER_CYCLE) ; au-delà, la lecture tourne entre les cycles.
Le bot n'écrit qu'aux conversations qui ont appuyé sur « Démarrer ».
"""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import html
import logging
import re
import secrets
import time

import httpx

from . import config, db
from .wallet_activity import WalletAction, describe, group_actions

logger = logging.getLogger(__name__)

API = "https://api.telegram.org"

# Un groupe de fills encore en cours au moment du cycle serait coupé en deux
# notifications : on ne traite que les fills plus vieux que ce délai, les plus
# récents attendent le cycle suivant (une minute plus tard).
SETTLE_MS = 10_000
# Au-delà, un message devient illisible sur téléphone : on résume le reste.
MAX_ITEMS_PER_MESSAGE = 10
_GC_KEY = "tg_gc"
_BOT_KEY = "tg_bot"
_CODE_RE = re.compile(r"^[A-Za-z0-9_-]{20,64}$")
_ADDRESS_RE = re.compile(r"^0x[0-9a-fA-F]{40}$")


class TelegramError(Exception):
    def __init__(self, code: int | None, description: str) -> None:
        super().__init__(f"{code}: {description}")
        self.code = code
        self.description = description


# --- Identité ----------------------------------------------------------------------
def enabled() -> bool:
    return bool(config.TELEGRAM_BOT_TOKEN)


def new_code() -> str:
    return secrets.token_urlsafe(24)


def hash_code(code: str) -> str:
    return hashlib.sha256(code.encode()).hexdigest()


def valid_code(code: str | None) -> bool:
    return bool(code) and bool(_CODE_RE.match(code))


def valid_address(address: str) -> bool:
    return bool(_ADDRESS_RE.match(address))


def webhook_secret() -> str:
    """Secret attendu dans l'en-tête X-Telegram-Bot-Api-Secret-Token.

    Dérivé du token : aucune variable de plus à configurer, et il change avec
    lui. Sans ce contrôle, n'importe qui pourrait relier un code à sa propre
    conversation en imitant Telegram."""
    return hmac.new(config.TELEGRAM_BOT_TOKEN.encode(), b"hl-dashboard-webhook", hashlib.sha256).hexdigest()


def client() -> httpx.AsyncClient:
    from .hyperliquid_client import _ssl_context  # contexte SSL partagé (coût CPU)

    return httpx.AsyncClient(timeout=httpx.Timeout(8.0, connect=5.0), verify=_ssl_context())


# --- API Telegram -----------------------------------------------------------------
async def call(c: httpx.AsyncClient, method: str, payload: dict | None = None):
    # L'URL contient le token : elle ne doit jamais finir dans un log.
    resp = await c.post(f"{API}/bot{config.TELEGRAM_BOT_TOKEN}/{method}", json=payload or {})
    try:
        data = resp.json()
    except ValueError:
        raise TelegramError(resp.status_code, "réponse illisible") from None
    if not data.get("ok"):
        raise TelegramError(data.get("error_code"), str(data.get("description", "")))
    return data.get("result")


async def send(c: httpx.AsyncClient, chat_id: int, text: str) -> bool:
    try:
        await call(
            c,
            "sendMessage",
            {"chat_id": chat_id, "text": text, "parse_mode": "HTML", "disable_web_page_preview": True},
        )
        return True
    except TelegramError as e:
        if e.code == 403:
            # L'utilisateur a bloqué le bot : inutile d'insister à chaque cycle.
            db.tg_unlink_chat(chat_id)
            logger.info("Telegram : conversation %s a bloqué le bot, abonnements retirés", chat_id)
        else:
            logger.warning("Telegram sendMessage refusé : %s", e)
        return False
    except httpx.HTTPError as e:
        logger.warning("Telegram injoignable (%s)", type(e).__name__)
        return False


async def bot_username(c: httpx.AsyncClient, refresh: bool = False) -> str | None:
    if not refresh:
        cached = db.kv_get(_BOT_KEY)
        if cached and cached[1].get("username"):
            return cached[1]["username"]
    me = await call(c, "getMe")
    username = me.get("username") if isinstance(me, dict) else None
    if username:
        db.kv_set(_BOT_KEY, int(time.time() * 1000), {"username": username})
    return username


# --- Messages ---------------------------------------------------------------------
def wallet_url(address: str) -> str:
    return f"{config.PUBLIC_URL}/#/wallet/{address}"


def format_action(a: WalletAction, label: str) -> str:
    title, body = describe(a, label)
    if a.kind == "liquidation":
        icon = "💥"
    elif a.kind in ("reduce", "close"):
        icon = "⚪"
    else:
        icon = "🟢" if a.side == "long" else "🔴"
    # Le libellé est saisi par l'utilisateur : échappé, comme tout le texte.
    return f'{icon} <b>{html.escape(title)}</b>\n{html.escape(body)} · <a href="{wallet_url(a.user)}">wallet</a>'


def join_items(items: list[str]) -> str:
    shown = items[:MAX_ITEMS_PER_MESSAGE]
    text = "\n\n".join(shown)
    rest = len(items) - len(shown)
    if rest > 0:
        text += f"\n\n… et {rest} autre{'s' if rest > 1 else ''} mouvement{'s' if rest > 1 else ''}."
    return text


def format_alerts(rows: list[tuple]) -> str:
    """rows : tuples d'insertion du moteur (coin, ts, criterion, severity, message, …)."""
    items = [f"🚨 {html.escape(r[4])}" for r in rows]
    text = join_items(items)
    return f"{text}\n\n<a href=\"{config.PUBLIC_URL}/#/markets\">Voir les alertes</a>"


HELP = (
    "Ce bot relaie les mouvements des wallets que vous suivez sur le dashboard Hyperliquid, "
    "même onglet fermé.\n\n"
    "Pour le relier : page <b>Wallet</b> du dashboard, bouton <b>Recevoir sur Telegram</b>.\n\n"
    "/status — ce qui est suivi\n/stop — ne plus rien recevoir"
)


async def handle_update(c: httpx.AsyncClient, update: dict, now_ms: int) -> str:
    """Traite un message reçu par le webhook. Rend l'action effectuée (tests, logs)."""
    msg = update.get("message") or {}
    chat_id = (msg.get("chat") or {}).get("id")
    text = (msg.get("text") or "").strip()
    if chat_id is None or not text:
        return "ignored"

    cmd, _, arg = text.partition(" ")
    cmd = cmd.split("@", 1)[0].lower()
    arg = arg.strip()

    if cmd == "/start" and valid_code(arg):
        if db.tg_link(hash_code(arg), chat_id, now_ms):
            n = db.tg_chat_wallet_count(chat_id)
            await send(
                c,
                chat_id,
                "✅ <b>Relié.</b> Vous recevrez ici les mouvements des wallets suivis"
                + (f" ({n} pour l'instant)" if n else " — ajoutez-en depuis la page Wallet")
                + ", vérifiés chaque minute.\n\n/stop pour arrêter.",
            )
            return "linked"
        await send(c, chat_id, "Ce lien a expiré. Recommencez depuis la page Wallet du dashboard.\n\n" + HELP)
        return "unknown_code"
    if cmd == "/stop":
        n = db.tg_unlink_chat(chat_id)
        await send(c, chat_id, "🔕 Vous ne recevrez plus rien." if n else "Rien n'était relié à cette conversation.")
        return "stopped"
    if cmd == "/status":
        n = db.tg_chat_wallet_count(chat_id)
        await send(
            c,
            chat_id,
            f"{n} wallet{'s' if n > 1 else ''} suivi{'s' if n > 1 else ''} depuis cette conversation."
            if n
            else "Aucun wallet suivi depuis cette conversation.\n\n" + HELP,
        )
        return "status"
    await send(c, chat_id, HELP)
    return "help"


# --- Cycle de collecte ------------------------------------------------------------
async def _send_many(c: httpx.AsyncClient, messages: dict[int, str]) -> int:
    # Telegram accepte ~30 messages/s au total : 8 envois simultanés suffisent.
    sem = asyncio.Semaphore(8)

    async def one(chat_id: int, text: str) -> bool:
        async with sem:
            return await send(c, chat_id, text)

    results = await asyncio.gather(*(one(k, v) for k, v in messages.items()))
    return sum(results)


def build_wallet_messages(actions: list[WalletAction], watchers: list[dict]) -> dict[int, str]:
    """Un message par conversation, actions dans l'ordre chronologique.

    Une même conversation peut avoir relié plusieurs navigateurs suivant le
    même wallet : chaque action n'y figure qu'une fois."""
    per_chat: dict[int, dict[str, tuple[int, str]]] = {}
    by_user: dict[str, list[WalletAction]] = {}
    for a in actions:
        by_user.setdefault(a.user, []).append(a)
    for w in watchers:
        for a in by_user.get(w["address"], []):
            if a.kind != "liquidation" and a.notional < w["min_notional"]:
                continue
            per_chat.setdefault(w["chat_id"], {}).setdefault(a.key, (a.time, format_action(a, w["label"])))
    return {chat: join_items([line for _, line in sorted(items.values())]) for chat, items in per_chat.items()}


async def watch_wallets(hl_client, c_factory, now_ms: int) -> dict | None:
    batch = db.tg_watch_batch(config.TG_MAX_WALLETS_PER_CYCLE)
    if not batch:
        return None
    cutoff = now_ms - SETTLE_MS
    sem = asyncio.Semaphore(5)

    async def fetch(row: dict):
        async with sem:
            return await hl_client.get_user_fills_since(row["address"], row["cursor_ms"] + 1)

    results = await asyncio.gather(*(fetch(r) for r in batch), return_exceptions=True)
    actions: list[WalletAction] = []
    cursors: list[tuple[str, int, int]] = []
    failed = 0
    for row, res in zip(batch, results):
        if isinstance(res, BaseException):
            failed += 1
            continue
        settled = [f for f in res if int(f.get("time", 0)) <= cutoff]
        cursor = max((int(f["time"]) for f in settled), default=row["cursor_ms"])
        cursors.append((row["address"], cursor, now_ms))
        actions.extend(group_actions(row["address"], settled))

    sent = 0
    if actions:
        messages = build_wallet_messages(actions, db.tg_watchers(sorted({a.user for a in actions})))
        if messages:
            async with c_factory() as c:
                sent = await _send_many(c, messages)
    # Curseurs avancés même si un envoi échoue : renvoyer une heure de
    # mouvements après une panne de Telegram serait pire que d'en manquer.
    db.tg_update_cursors(cursors)
    return {"wallets": len(batch), "failed": failed, "actions": len(actions), "messages": sent}


async def notify_alerts(c_factory, created_rows: list[tuple]) -> int:
    critical = [r for r in created_rows if r[3] == "critical"]
    if not critical:
        return 0
    chats = db.tg_alert_chats()
    if not chats:
        return 0
    text = format_alerts(critical)
    async with c_factory() as c:
        return await _send_many(c, {chat: text for chat in chats})


async def run_cycle(hl_client, created_rows: list[tuple], now_ms: int) -> dict | None:
    """Appelé à chaque cycle de collecte, après les alertes. Ne lève jamais."""
    if not enabled():
        return None
    report: dict = {}
    try:
        report["alerts"] = await notify_alerts(client, created_rows)
    except Exception:
        logger.exception("Telegram : envoi des alertes en échec")
    try:
        report["wallets"] = await watch_wallets(hl_client, client, now_ms)
    except Exception:
        logger.exception("Telegram : surveillance des wallets en échec")
    try:
        if db.try_claim(_GC_KEY, now_ms, 3600_000):
            report["gc"] = db.tg_gc(now_ms)
    except Exception:
        logger.exception("Telegram : nettoyage en échec")
    return report
