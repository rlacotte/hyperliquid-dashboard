import { useEffect } from "react";
import { api, ApiError } from "../api";
import { resetTelegram, telegramStore, useNotifySettings, useTelegram, useWatchlist } from "../stores";

/** Plafond serveur (TG_MAX_WALLETS_PER_SUB) : au-delà, les premiers seulement. */
export const TELEGRAM_MAX_WALLETS = 25;

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
    if (!code) return;
    api.telegram.status(code).then(
      (s) => telegramStore.set({ ...telegramStore.get(), linked: s.linked }),
      (e) => {
        if (e instanceof ApiError && (e.status === 404 || e.status === 401)) resetTelegram();
      }
    );
  }, []);

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
