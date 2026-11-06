import { useEffect, useState } from "react";
import type { WsStatus } from "../hl/ws";
import { classifyFreshness, fmtAge } from "../freshness";

interface Props {
  ws: WsStatus;
  /** Horodatage du dernier cycle de collecte serveur. */
  signalsTs: number | undefined;
  signalsError: string | null;
}

/** Délai avant de signaler une coupure websocket : une reconnexion normale prend 1-3 s. */
const WS_DOWN_AFTER_MS = 15_000;

/**
 * Bandeau pleine largeur, affiché uniquement quand une partie de l'écran ment.
 *
 * Deux pannes distinctes, deux messages :
 * - websocket coupé durablement → les PRIX sont figés (rouge : c'est la donnée
 *   principale) ;
 * - collecte serveur arrêtée → les prix restent en direct, mais ALERTES et
 *   RÉGIMES ne sont plus recalculés (ambre). C'est la panne qui est passée
 *   inaperçue six semaines : le cron externe désactivé par GitHub.
 *
 * Les retards courts (un cycle manqué, une reconnexion rapide) ne déclenchent
 * rien : seul le badge de l'en-tête bouge. Cf. freshness.ts pour les seuils.
 */
export function StaleBanner({ ws, signalsTs, signalsError }: Props) {
  const wsDown = useSustained(ws !== "open" && ws !== "idle", WS_DOWN_AFTER_MS);
  const sig = classifyFreshness(signalsTs, signalsError);
  const signalsDown = sig === "down" || (sig === "error" && !!signalsTs);

  if (!wsDown && !signalsDown) return null;

  return (
    <div role="alert">
      {wsDown && (
        <Bar
          tone="red"
          title="Flux de prix interrompu"
          detail="La connexion temps réel à Hyperliquid est coupée ; reconnexion automatique en cours. Les prix affichés sont figés."
        />
      )}
      {signalsDown && (
        <Bar
          tone="amber"
          title="Collecte des signaux arrêtée"
          age={signalsTs ? fmtAge(Date.now() - signalsTs) : undefined}
          detail="Les prix restent en direct, mais les alertes et les scores de régime ne sont plus recalculés : le cron de collecte (pinger) est probablement arrêté."
        />
      )}
    </div>
  );
}

function Bar({ tone, title, detail, age }: { tone: "red" | "amber"; title: string; detail: string; age?: string }) {
  const palette =
    tone === "red" ? "border-red-500/40 bg-red-500/15 text-red-200" : "border-amber-500/40 bg-amber-500/15 text-amber-200";
  const dot = tone === "red" ? "bg-red-500" : "bg-amber-500";
  return (
    <div className={`flex items-start gap-3 border-b px-6 py-2.5 text-sm ${palette}`}>
      <span className={`mt-1.5 h-2 w-2 shrink-0 animate-pulse rounded-full ${dot}`} />
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="font-semibold">{title}</span>
        {age && (
          <span className="opacity-80">
            Dernier cycle il y a <span className="font-semibold">{age}</span>.
          </span>
        )}
        <span className="opacity-80">{detail}</span>
      </div>
    </div>
  );
}

/** Vrai seulement si `active` l'est resté sans interruption pendant `ms`. */
function useSustained(active: boolean, ms: number): boolean {
  const [sustained, setSustained] = useState(false);
  useEffect(() => {
    if (!active) {
      setSustained(false);
      return;
    }
    const t = setTimeout(() => setSustained(true), ms);
    return () => clearTimeout(t);
  }, [active, ms]);
  return sustained;
}
