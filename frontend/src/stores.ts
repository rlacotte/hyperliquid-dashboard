/**
 * Petits stores partagés entre pages, sans dépendance.
 *
 * La surveillance des wallets tourne au niveau de l'application (elle doit
 * notifier quelle que soit la page ouverte) tandis que la liste de suivi se
 * modifie depuis la page Wallet : un état local de page ne suffit plus.
 */
import { useSyncExternalStore } from "react";
import { loadWatchlist, saveWatchlist, type WatchedWallet } from "./wallet";
import type { WalletAction } from "./walletActivity";

interface Store<T> {
  get: () => T;
  set: (next: T) => void;
  subscribe: (listener: () => void) => () => void;
}

function createStore<T>(initial: T, persist?: (v: T) => void): Store<T> {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set: (next) => {
      state = next;
      persist?.(next);
      listeners.forEach((l) => l());
    },
    subscribe: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
}

const useStore = <T,>(s: Store<T>): T => useSyncExternalStore(s.subscribe, s.get);

// --- Liste de suivi ----------------------------------------------------------------
export const watchlistStore = createStore<WatchedWallet[]>(loadWatchlist(), saveWatchlist);
export const useWatchlist = () => useStore(watchlistStore);

// Un autre onglet modifie la liste : on la recharge, sinon cet onglet
// continuerait de surveiller (et de notifier) l'ancienne.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === "hl-dashboard:watchlist") watchlistStore.set(loadWatchlist());
    if (e.key === NOTIFY_KEY) notifySettingsStore.set(loadNotifySettings());
    if (e.key === TELEGRAM_KEY) telegramStore.set(loadTelegram());
  });
}

// --- Réglages de notification ---------------------------------------------------------
export interface NotifySettings {
  /** Notifications système du navigateur (permission accordée à part). */
  enabled: boolean;
  /** Montant minimal d'une action pour notifier. Les liquidations passent toujours. */
  minNotional: number;
}

const NOTIFY_KEY = "hl-dashboard:notify";
const NOTIFY_DEFAULT: NotifySettings = { enabled: false, minNotional: 25_000 };

function loadNotifySettings(): NotifySettings {
  try {
    const raw = localStorage.getItem(NOTIFY_KEY);
    return raw ? { ...NOTIFY_DEFAULT, ...JSON.parse(raw) } : NOTIFY_DEFAULT;
  } catch {
    return NOTIFY_DEFAULT;
  }
}

export const notifySettingsStore = createStore<NotifySettings>(loadNotifySettings(), (v) => {
  try {
    localStorage.setItem(NOTIFY_KEY, JSON.stringify(v));
  } catch {
    /* stockage indisponible : réglage gardé pour la session */
  }
});
export const useNotifySettings = () => useStore(notifySettingsStore);

// --- Abonnement Telegram ---------------------------------------------------------------
/**
 * Le code d'abonnement est la seule « identité » de ce navigateur auprès du
 * bot : il permet de modifier la liste suivie par la conversation reliée.
 * Gardé en local, envoyé en en-tête, jamais dans une URL du dashboard.
 */
export interface TelegramState {
  code: string | null;
  linked: boolean;
  /** Recevoir aussi les alertes critiques du marché. */
  critical: boolean;
}

const TELEGRAM_KEY = "hl-dashboard:telegram";
const TELEGRAM_DEFAULT: TelegramState = { code: null, linked: false, critical: false };

function loadTelegram(): TelegramState {
  try {
    const raw = localStorage.getItem(TELEGRAM_KEY);
    return raw ? { ...TELEGRAM_DEFAULT, ...JSON.parse(raw) } : TELEGRAM_DEFAULT;
  } catch {
    return TELEGRAM_DEFAULT;
  }
}

export const telegramStore = createStore<TelegramState>(loadTelegram(), (v) => {
  try {
    localStorage.setItem(TELEGRAM_KEY, JSON.stringify(v));
  } catch {
    /* stockage indisponible : abonnement perdu à la fermeture de l'onglet */
  }
});
export const useTelegram = () => useStore(telegramStore);
export const resetTelegram = () => telegramStore.set(TELEGRAM_DEFAULT);

// --- Fil d'activité (session) --------------------------------------------------------
const ACTIVITY_MAX = 200;
export const activityStore = createStore<WalletAction[]>([]);
export const useActivity = () => useStore(activityStore);

export function pushActivity(actions: WalletAction[]) {
  if (actions.length === 0) return;
  activityStore.set([...[...actions].reverse(), ...activityStore.get()].slice(0, ACTIVITY_MAX));
}
