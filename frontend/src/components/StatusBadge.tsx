import type { WsStatus } from "../hl/ws";
import { classifyFreshness, fmtAge } from "../freshness";

interface Props {
  /** État du websocket qui alimente les prix. */
  ws: WsStatus;
  /** Horodatage du dernier cycle de collecte serveur (alertes, régimes). */
  signalsTs: number | undefined;
  signalsError: string | null;
}

/**
 * Deux pastilles, parce qu'il y a deux chemins de données qui tombent
 * indépendamment :
 * - les PRIX arrivent en direct de Hyperliquid par websocket, sans passer par
 *   notre serveur ;
 * - les SIGNAUX (alertes, régimes) dépendent du cycle de collecte serveur,
 *   lui-même déclenché par un cron externe.
 * Une seule pastille « Live » masquerait le cas le plus probable : prix vivants,
 * signaux figés.
 */
export function StatusBadge({ ws, signalsTs, signalsError }: Props) {
  const wsLive = ws === "open";
  const sig = classifyFreshness(signalsTs, signalsError);

  const sigView =
    sig === "live"
      ? { dot: "bg-green-500", text: "text-gray-400", label: "à jour" }
      : sig === "pending"
        ? { dot: "bg-gray-500", text: "text-gray-500", label: "…" }
        : sig === "error"
          ? { dot: "bg-red-500", text: "text-red-400", label: "erreur" }
          : { dot: "bg-amber-500", text: "text-amber-400", label: `figés ${fmtAge(Date.now() - (signalsTs as number))}` };

  return (
    <span className="flex items-center gap-3 text-xs">
      <span className="flex items-center gap-1.5" title="Prix en direct par websocket Hyperliquid">
        <span className={`h-2 w-2 rounded-full ${wsLive ? "animate-pulse bg-green-500" : "bg-amber-500"}`} />
        <span className={wsLive ? "text-gray-400" : "text-amber-400"}>
          Prix {wsLive ? "live" : ws === "idle" ? "…" : "reconnexion…"}
        </span>
      </span>
      <span
        className="flex items-center gap-1.5"
        title={signalsError ?? "Alertes et régimes, recalculés à chaque cycle de collecte serveur (~30 s)"}
      >
        <span className={`h-2 w-2 rounded-full ${sigView.dot}`} />
        <span className={sigView.text}>Signaux {sigView.label}</span>
      </span>
    </span>
  );
}
