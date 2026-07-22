import { useState } from "react";
import type { Alert, Criterion, Severity } from "../types";
import { directionArrow, directionLabel, fmtScore, fmtTime } from "../format";

interface Props {
  alerts: Alert[];
  onAck: (id: number) => void;
  onAckAll: () => void;
  onSelectCoin: (coin: string) => void;
}

const SEVERITY_STYLES: Record<Severity, { bg: string; border: string; text: string; label: string }> = {
  critical: { bg: "bg-red-500/10", border: "border-red-500/40", text: "text-red-400", label: "CRITIQUE" },
  warning: { bg: "bg-amber-500/10", border: "border-amber-500/40", text: "text-amber-400", label: "ALERTE" },
  info: { bg: "bg-blue-500/10", border: "border-blue-500/40", text: "text-blue-400", label: "INFO" },
};

const CRITERION_LABELS: Record<Criterion, string> = {
  funding_rate: "Funding",
  open_interest: "Open Interest",
  volume: "Volume",
  price_change: "Prix",
  confluence: "Confluence",
};

const CRITERION_FILTERS: { value: Criterion | "all"; label: string }[] = [
  { value: "all", label: "Tous" },
  { value: "confluence", label: "⚡ Confluence" },
  { value: "funding_rate", label: "Funding" },
  { value: "open_interest", label: "OI" },
  { value: "volume", label: "Volume" },
  { value: "price_change", label: "Prix" },
];

// Style directionnel pour les alertes confluence (surcharge la sévérité)
function confluenceStyle(alert: Alert) {
  if (alert.criterion !== "confluence" || !alert.direction) return null;
  if (alert.direction === "bullish") {
    return { bg: "bg-green-500/10", border: "border-green-500/40", text: "text-green-400" };
  }
  if (alert.direction === "bearish") {
    return { bg: "bg-red-500/10", border: "border-red-500/40", text: "text-red-400" };
  }
  return null;
}

export function AlertsPanel({ alerts, onAck, onAckAll, onSelectCoin }: Props) {
  const [filter, setFilter] = useState<Criterion | "all">("all");

  const filtered = filter === "all" ? alerts : alerts.filter((a) => a.criterion === filter);

  // Les alertes confluence en haut (signaux les plus importants)
  const sorted = [...filtered].sort((a, b) => {
    if (a.criterion === "confluence" && b.criterion !== "confluence") return -1;
    if (a.criterion !== "confluence" && b.criterion === "confluence") return 1;
    return b.ts - a.ts;
  });

  return (
    <div className="flex h-full flex-col">
      {/* Header + compteur + acquitter tout */}
      <div className="mb-2 flex items-center gap-2">
        <h2 className="text-lg font-semibold text-white">Alertes</h2>
        {alerts.length > 0 && (
          <span className="rounded-full bg-red-500/20 px-2 py-0.5 text-xs font-medium text-red-400">
            {alerts.length}
          </span>
        )}
        {alerts.length > 0 && (
          <button
            onClick={onAckAll}
            title="Acquitter toutes les alertes"
            className="ml-auto rounded-md border border-bg-border bg-bg-panel px-2 py-1 text-xs text-gray-400 hover:bg-bg-hover hover:text-white"
          >
            Tout acquitter
          </button>
        )}
      </div>

      {/* Filtres par critère */}
      {alerts.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-1">
          {CRITERION_FILTERS.map((f) => {
            const count = f.value === "all" ? alerts.length : alerts.filter((a) => a.criterion === f.value).length;
            return (
              <button
                key={f.value}
                onClick={() => setFilter(f.value)}
                className={`rounded px-2 py-0.5 text-xs ${
                  filter === f.value ? "bg-blue-600 text-white" : "bg-bg-panel text-gray-400 hover:text-white"
                }`}
              >
                {f.label} {count > 0 && <span className="opacity-60">{count}</span>}
              </button>
            );
          })}
        </div>
      )}

      {/* Liste */}
      <div className="flex-1 space-y-2 overflow-auto">
        {alerts.length === 0 && (
          <div className="flex h-32 items-center justify-center text-sm text-gray-600">
            Aucune alerte active
          </div>
        )}
        {sorted.length === 0 && alerts.length > 0 && (
          <div className="flex h-32 items-center justify-center text-sm text-gray-600">
            Aucune alerte pour ce filtre
          </div>
        )}
        {sorted.map((alert) => {
          const base = SEVERITY_STYLES[alert.severity];
          const confStyle = confluenceStyle(alert);
          const bg = confStyle?.bg ?? base.bg;
          const border = confStyle?.border ?? base.border;
          const text = confStyle?.text ?? base.text;
          const isConfluence = alert.criterion === "confluence";

          return (
            <div key={alert.id} className={`rounded-lg border ${border} ${bg} p-3`}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="mb-1 flex flex-wrap items-center gap-2">
                    {/* Badge directionnel pour confluence, sévérité sinon */}
                    {isConfluence && alert.direction ? (
                      <span className={`text-[10px] font-bold ${text}`}>
                        {directionArrow(alert.direction)} {directionLabel(alert.direction).toUpperCase()}
                      </span>
                    ) : (
                      <span className={`text-[10px] font-bold ${text}`}>{base.label}</span>
                    )}
                    {isConfluence && alert.score !== null && (
                      <span className={`font-mono text-sm font-bold ${text}`}>
                        {fmtScore(alert.score)}
                      </span>
                    )}
                    <button
                      onClick={() => onSelectCoin(alert.coin)}
                      className="font-semibold text-white hover:underline"
                    >
                      {alert.coin}
                    </button>
                    <span className="rounded bg-bg-base px-1.5 py-0.5 text-[10px] text-gray-400">
                      {CRITERION_LABELS[alert.criterion]}
                    </span>
                    <span className="text-xs text-gray-500">{fmtTime(alert.ts)}</span>
                  </div>
                  <p className="text-sm text-gray-300">{alert.message}</p>
                </div>
                <button
                  onClick={() => onAck(alert.id)}
                  title="Acquitter"
                  className="shrink-0 rounded px-2 py-1 text-xs text-gray-500 hover:bg-bg-hover hover:text-gray-300"
                >
                  ✓
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
