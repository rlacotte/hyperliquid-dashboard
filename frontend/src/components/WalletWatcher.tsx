import { useEffect, useRef, useState } from "react";
import { wsManager } from "../hl/ws";
import type { Fill } from "../hl/client";
import { href, navigate } from "../router";
import { pushActivity, useNotifySettings, useWatchlist } from "../stores";
import { shortAddr } from "../wallet";
import { ActivityBuilder, describe, type WalletAction } from "../walletActivity";
import { fmtUsd } from "../format";

const TOAST_MS = 8_000;
const MAX_TOASTS = 4;

/**
 * Surveille en temps réel les wallets suivis (flux websocket `userFills`,
 * public sur Hyperliquid) et signale leurs actions :
 * - dans le fil d'activité de la page Wallet ;
 * - par un toast dans l'onglet ;
 * - par une notification système si l'utilisateur l'a activée.
 *
 * Monté au niveau de l'application : la surveillance continue quelle que soit
 * la page ouverte. Limite assumée : il faut un onglet ouvert — pas de compte,
 * donc pas de serveur qui pousserait hors ligne.
 */
export function WalletWatcher() {
  const watch = useWatchlist();
  const settings = useNotifySettings();
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const labelsRef = useRef(new Map<string, string>());
  labelsRef.current = new Map(watch.map((w) => [w.address, w.label]));
  const [toasts, setToasts] = useState<WalletAction[]>([]);

  const key = watch
    .map((w) => w.address)
    .sort()
    .join(",");

  useEffect(() => {
    if (!key) return;
    const builder = new ActivityBuilder();
    const unsubs = key.split(",").map((user) =>
      wsManager.subscribe({ type: "userFills", user }, (data: { isSnapshot?: boolean; user?: string; fills?: Fill[] }) => {
        // Le premier message est l'instantané des fills RÉCENTS : le notifier
        // ferait croire à 30 nouvelles actions à chaque ouverture de page.
        if (!data || data.isSnapshot) return;
        builder.add(data.user ?? user, data.fills ?? [], Date.now());
      })
    );

    const timer = setInterval(() => {
      const actions = builder.flush(Date.now());
      if (actions.length === 0) return;
      pushActivity(actions);

      const s = settingsRef.current;
      const notable = actions.filter((a) => a.kind === "liquidation" || a.notional >= s.minNotional);
      if (notable.length === 0) return;

      setToasts((t) => [...notable, ...t].slice(0, MAX_TOASTS));
      for (const a of notable) setTimeout(() => setToasts((t) => t.filter((x) => x.key !== a.key)), TOAST_MS);

      if (s.enabled && typeof Notification !== "undefined" && Notification.permission === "granted") {
        for (const a of notable) {
          const { title, body } = describe(a, labelsRef.current.get(a.user) ?? shortAddr(a.user), fmtUsd);
          // `tag` : plusieurs onglets ouverts produisent la même notification,
          // le système la remplace au lieu de l'empiler.
          const n = new Notification(title, { body, tag: a.key });
          n.onclick = () => {
            window.focus();
            navigate("wallet", a.user);
            n.close();
          };
        }
      }
    }, 1_000);

    return () => {
      unsubs.forEach((u) => u());
      clearInterval(timer);
    };
  }, [key]);

  if (toasts.length === 0) return null;
  return (
    // Téléphone : un seul toast à la fois, sinon la pile recouvre la moitié de
    // l'écran ; les suivants restent dans le fil d'activité de la page Wallet.
    <div
      className="pointer-events-none fixed inset-x-3 bottom-3 z-[60] flex flex-col gap-2 sm:inset-x-auto sm:bottom-4 sm:right-4 sm:w-80 [&>*:nth-child(n+2)]:hidden sm:[&>*:nth-child(n+2)]:block"
      aria-live="polite"
    >
      {toasts.map((a) => {
        const { title, body } = describe(a, labelsRef.current.get(a.user) ?? shortAddr(a.user), fmtUsd);
        const tone =
          a.kind === "liquidation"
            ? "border-red-500/50 bg-red-950/90"
            : a.side === "long"
              ? "border-green-500/40 bg-bg-panel/95"
              : "border-red-500/40 bg-bg-panel/95";
        return (
          <a key={a.key} href={href("wallet", a.user)} className={`pointer-events-auto rounded-lg border px-3 py-2 text-sm shadow-xl backdrop-blur ${tone}`}>
            <div className="font-medium text-gray-100">{title}</div>
            <div className="text-xs text-gray-400">{body}</div>
          </a>
        );
      })}
    </div>
  );
}
