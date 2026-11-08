import { useEffect } from "react";
import { api, ApiError } from "../api";
import { resetTelegram, telegramStore, useNotifySettings, useTelegram, useWatchlist } from "../stores";

/** Plafond serveur (TG_MAX_WALLETS_PER_SUB) : au-delà, les premiers seulement. */
export const TELEGRAM_MAX_WALLETS = 25;

/** Attente de « Démarrer » : vérification serrée au début, puis espacée, sans fin. */
const FAST_POLL_MS = 3_000;
const FAST_FOR_MS = 5 * 60_000;
const SLOW_POLL_MS = 20_000;

async function refreshLink(code: string) {
  try {
    const s = await api.telegram.status(code);
    if (telegramStore.get().code === code) telegramStore.set({ ...telegramStore.get(), linked: s.linked });
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.status === 401)) resetTelegram();
  }
}

/**
 * Tient le serveur à jour de ce que ce navigateur suit, pour que le bot
 * Telegram surveille les mêmes wallets avec le même seuil.
 *
 * Monté au niveau de l'application : une modification de la liste depuis
 * n'importe quelle page est répercutée. Le serveur répond 404 quand la
 * conversation a fait /stop (abonnement supprimé) : on oublie alors le code.
 */
export function useTelegramSync() {
  const tg = useTelegram();
  const watch = useWatchlist();
  const settings = useNotifySettings();

  // Au chargement : l'état a pu changer côté Telegram (/stop, bot bloqué).
  useEffect(() => {
    const { code } = telegramStore.get();
    if (code) refreshLink(code);
  }, []);

  // En attente de « Démarrer ». Constaté : l'appui peut venir bien après
  // (6 min et demie au premier essai réel) — une attente bornée laissait la
  // conversation reliée côté serveur mais sans aucun wallet transmis. On
  // vérifie donc sans limite de durée, et aussitôt qu'on revient sur l'onglet
  // (retour depuis l'application Telegram).
  useEffect(() => {
    if (!tg.code || tg.linked) return;
    const code = tg.code;
    const started = Date.now();
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      refreshLink(code);
      timer = setTimeout(tick, Date.now() - started < FAST_FOR_MS ? FAST_POLL_MS : SLOW_POLL_MS);
    };
    timer = setTimeout(tick, FAST_POLL_MS);
    const onReturn = () => {
      if (document.visibilityState === "visible") refreshLink(code);
    };
    window.addEventListener("focus", onReturn);
    document.addEventListener("visibilitychange", onReturn);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("focus", onReturn);
      document.removeEventListener("visibilitychange", onReturn);
    };
  }, [tg.code, tg.linked]);

  const payload = JSON.stringify({
    wallets: watch.slice(0, TELEGRAM_MAX_WALLETS).map((w) => ({ address: w.address, label: w.label })),
    min_notional: settings.minNotional,
    critical_alerts: tg.critical,
  });

  useEffect(() => {
    if (!tg.code || !tg.linked) return;
    const code = tg.code;
    // Regroupe les modifications rapprochées (renommage frappe par frappe).
    const t = setTimeout(() => {
      api.telegram.update(code, JSON.parse(payload)).catch((e) => {
        if (e instanceof ApiError && e.status === 404) resetTelegram();
        else console.warn("Synchronisation Telegram :", e);
      });
    }, 1000);
    return () => clearTimeout(t);
  }, [tg.code, tg.linked, payload]);
}
