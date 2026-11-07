"""Routes du bot Telegram : abonnement sans compte, webhook, installation.

Le code d'abonnement voyage dans l'en-tête X-Subscription-Code et non dans
l'URL : les chemins finissent dans les journaux d'accès, et ce code suffit à
modifier la liste suivie d'une conversation.
"""
from __future__ import annotations

import hmac
import time

from fastapi import APIRouter, Header, HTTPException, Request
from pydantic import BaseModel, Field

from .. import config, db, telegram_bot as tg
from .cron import _authorized

router = APIRouter(prefix="/api/telegram", tags=["telegram"])


class WalletIn(BaseModel):
    address: str
    label: str = ""


class SubscriptionIn(BaseModel):
    wallets: list[WalletIn] = Field(default_factory=list)
    min_notional: float = 25_000
    critical_alerts: bool = False


def _now() -> int:
    return int(time.time() * 1000)


def _require_enabled() -> None:
    if not tg.enabled():
        raise HTTPException(status_code=503, detail="Bot Telegram non configuré")


def _code_hash(code: str | None) -> str:
    if not tg.valid_code(code):
        raise HTTPException(status_code=401, detail="Code d'abonnement manquant ou invalide")
    return tg.hash_code(code)  # type: ignore[arg-type]


def _view(sub: dict) -> dict:
    return {
        "linked": sub["chat_id"] is not None,
        "wallets": sub["wallets"],
        "min_notional": sub["min_notional"],
        "critical_alerts": sub["critical_alerts"],
    }


def clean_wallets(wallets: list[WalletIn]) -> list[tuple[str, str]]:
    """Adresses validées, en minuscules, sans doublon ; libellés bornés."""
    out: dict[str, str] = {}
    for w in wallets:
        address = w.address.strip().lower()
        if not tg.valid_address(address):
            raise HTTPException(status_code=422, detail=f"Adresse invalide : {w.address[:60]}")
        label = " ".join(w.label.split())[:40] or f"{address[:6]}…{address[-4:]}"
        out.setdefault(address, label)
    if len(out) > config.TG_MAX_WALLETS_PER_SUB:
        raise HTTPException(status_code=422, detail=f"{config.TG_MAX_WALLETS_PER_SUB} wallets au plus")
    return list(out.items())


@router.get("/info")
async def info():
    if not tg.enabled():
        return {"enabled": False, "bot": None}
    async with tg.client() as c:
        try:
            username = await tg.bot_username(c)
        except Exception:
            username = None
    return {"enabled": username is not None, "bot": username}


@router.post("/subscription")
async def create_subscription(body: SubscriptionIn | None = None):
    _require_enabled()
    now = _now()
    if db.tg_count_pending(now - 86400_000) >= config.TG_MAX_PENDING_SUBS:
        raise HTTPException(status_code=429, detail="Trop d'abonnements en attente, réessayez plus tard")
    async with tg.client() as c:
        username = await tg.bot_username(c)
    if not username:
        raise HTTPException(status_code=503, detail="Bot Telegram injoignable")
    code = tg.new_code()
    min_notional = max(0.0, min(body.min_notional if body else 25_000, 1e9))
    db.tg_create_sub(tg.hash_code(code), now, min_notional)
    return {"code": code, "link": f"https://t.me/{username}?start={code}", "bot": username}


@router.get("/subscription")
async def get_subscription(x_subscription_code: str | None = Header(default=None)):
    sub = db.tg_get_sub(_code_hash(x_subscription_code))
    if sub is None:
        raise HTTPException(status_code=404, detail="Abonnement inconnu ou expiré")
    return _view(sub)


@router.put("/subscription")
async def update_subscription(body: SubscriptionIn, x_subscription_code: str | None = Header(default=None)):
    code_hash = _code_hash(x_subscription_code)
    wallets = clean_wallets(body.wallets)
    min_notional = max(0.0, min(body.min_notional, 1e9))
    if not db.tg_update_sub(code_hash, min_notional, body.critical_alerts, wallets, _now()):
        raise HTTPException(status_code=404, detail="Abonnement inconnu ou expiré")
    return _view(db.tg_get_sub(code_hash))


@router.delete("/subscription")
async def delete_subscription(x_subscription_code: str | None = Header(default=None)):
    chat_id = db.tg_delete_sub(_code_hash(x_subscription_code))
    if chat_id is not None and tg.enabled():
        async with tg.client() as c:
            await tg.send(c, chat_id, "🔕 Ce navigateur a été délié : il ne vous enverra plus rien.")
    return {"deleted": True}


@router.post("/webhook")
async def webhook(request: Request, x_telegram_bot_api_secret_token: str | None = Header(default=None)):
    if not tg.enabled() or not hmac.compare_digest(x_telegram_bot_api_secret_token or "", tg.webhook_secret()):
        raise HTTPException(status_code=401, detail="Non autorisé")
    try:
        update = await request.json()
    except ValueError:
        return {"ok": True}
    async with tg.client() as c:
        await tg.handle_update(c, update if isinstance(update, dict) else {}, _now())
    # Toujours 200 : sinon Telegram renvoie la même mise à jour en boucle.
    return {"ok": True}


@router.post("/setup")
async def setup(authorization: str | None = Header(default=None)):
    """Branche le webhook et les commandes du bot. À appeler une fois, après
    avoir posé TELEGRAM_BOT_TOKEN (protégé par CRON_SECRET)."""
    if not _authorized(authorization):
        raise HTTPException(status_code=401, detail="Non autorisé")
    _require_enabled()
    async with tg.client() as c:
        username = await tg.bot_username(c, refresh=True)
        await tg.call(
            c,
            "setWebhook",
            {
                "url": f"{config.PUBLIC_URL}/api/telegram/webhook",
                "secret_token": tg.webhook_secret(),
                "allowed_updates": ["message"],
                "drop_pending_updates": True,
            },
        )
        await tg.call(
            c,
            "setMyCommands",
            {
                "commands": [
                    {"command": "status", "description": "Wallets suivis depuis cette conversation"},
                    {"command": "stop", "description": "Ne plus rien recevoir"},
                ]
            },
        )
        await tg.call(
            c,
            "setMyDescription",
            {"description": "Mouvements des wallets Hyperliquid que vous suivez sur le dashboard, même onglet fermé."},
        )
        hook = await tg.call(c, "getWebhookInfo")
    return {
        "bot": username,
        "webhook_url": hook.get("url"),
        "pending_updates": hook.get("pending_update_count"),
        "last_error": hook.get("last_error_message"),
    }
