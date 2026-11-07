import { useEffect, useState } from "react";
import { api, ApiError } from "../api";
import { resetTelegram, telegramStore, useNotifySettings, useTelegram, useWatchlist } from "../stores";
import { TELEGRAM_MAX_WALLETS } from "../hooks/useTelegramSync";

/** Attente de l'appui sur « Démarrer » dans Telegram. */
const POLL_MS = 3_000;
const WAIT_MAX_MS = 5 * 60_000;

/**
 * Relie ce navigateur à une conversation Telegram, sans compte : le serveur
 * crée un code, Telegram nous le renvoie quand l'utilisateur appuie sur
 * « Démarrer » dans la conversation avec le bot.
 */
export function TelegramLink() {
  const tg = useTelegram();
  const settings = useNotifySettings();
  const watch = useWatchlist();
  const [bot, setBot] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.telegram.info().then(
      (i) => setBot(i.enabled ? i.bot : null),
      () => setBot(null)
    );
  }, []);

  useEffect(() => {
    if (!tg.code || tg.linked) return;
    const code = tg.code;
    const started = Date.now();
    const id = setInterval(async () => {
      if (Date.now() - started > WAIT_MAX_MS) return clearInterval(id);
      try {
        const s = await api.telegram.status(code);
        if (s.linked) telegramStore.set({ ...telegramStore.get(), linked: true });
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) resetTelegram();
      }
    }, POLL_MS);
    return () => clearInterval(id);
  }, [tg.code, tg.linked]);

  if (!bot) return null;

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.telegram.create(settings.minNotional);
      telegramStore.set({ ...telegramStore.get(), code: r.code, linked: false });
      // Souvent bloqué après un appel réseau : le lien reste affiché de toute façon.
      window.open(r.link, "_blank", "noopener");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const unlink = async () => {
    const code = tg.code;
    resetTelegram();
    if (code) await api.telegram.remove(code).catch(() => undefined);
  };

  if (!tg.code) {
    return (
      <span className="inline-flex items-center gap-2">
        <button
          onClick={start}
          disabled={busy}
          title="Les mouvements des wallets suivis arrivent dans Telegram même onglet fermé, vérifiés chaque minute."
          className="rounded bg-sky-600 px-2 py-0.5 text-white hover:bg-sky-500 disabled:opacity-60"
        >
          {busy ? "…" : "✈︎ Recevoir sur Telegram"}
        </button>
        {error && <span className="text-red-400">{error}</span>}
      </span>
    );
  }

  if (!tg.linked) {
    return (
      <span className="inline-flex flex-wrap items-center gap-2">
        <a
          href={`https://t.me/${bot}?start=${tg.code}`}
          target="_blank"
          rel="noopener noreferrer"
          className="rounded bg-sky-600 px-2 py-0.5 text-white hover:bg-sky-500"
        >
          Ouvrir @{bot} et appuyer sur Démarrer
        </a>
        <span className="text-gray-500">en attente…</span>
        <button onClick={unlink} className="text-gray-500 hover:text-gray-300">
          annuler
        </button>
      </span>
    );
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <span
        className="rounded border border-sky-500/40 bg-sky-500/10 px-2 py-0.5 text-sky-300"
        title={`Relié à @${bot}. Même seuil que ci-contre ; les liquidations passent toujours.`}
      >
        ✈︎ Telegram relié
      </span>
      <label className="flex cursor-pointer items-center gap-1 text-gray-400" title="Alertes critiques de tout le marché, en plus des wallets suivis.">
        <input
          type="checkbox"
          checked={tg.critical}
          onChange={(e) => telegramStore.set({ ...telegramStore.get(), critical: e.target.checked })}
          className="accent-sky-500"
        />
        + alertes critiques
      </label>
      <button onClick={unlink} className="text-gray-500 hover:text-gray-300">
        délier
      </button>
      {watch.length > TELEGRAM_MAX_WALLETS && (
        <span className="text-amber-400/80">seuls les {TELEGRAM_MAX_WALLETS} premiers wallets sont relayés</span>
      )}
    </span>
  );
}
