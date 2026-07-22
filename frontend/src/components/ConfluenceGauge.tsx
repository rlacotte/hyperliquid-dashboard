import type { ConfluenceScore } from "../types";
import {
  CRITERION_LABELS_MAP,
  colorScore,
  directionArrow,
  directionLabel,
  fmtScore,
} from "./confluenceHelpers";

interface Props {
  confluence: ConfluenceScore;
}

const CRITERION_ICONS: Record<string, string> = {
  price_change: "📈",
  volume: "📊",
  open_interest: "💰",
  funding_rate: "💸",
};

// Style du badge de régime selon la fiabilité
function regimeBadgeStyle(regime: string, confidence: number): string {
  if (regime === "none") return "bg-gray-700 text-gray-400";
  if (confidence >= 0.8) return "bg-green-500/20 text-green-300 border border-green-500/40"; // solide
  if (confidence >= 0.4) return "bg-amber-500/20 text-amber-300 border border-amber-500/40"; // fragile
  return "bg-gray-500/20 text-gray-300 border border-gray-500/40"; // très faible
}

/**
 * Régime + jauge [-10, +10] + breakdown détaillé des critères.
 * Le régime (prix×OI) est l'info principale : il donne l'interprétation trading.
 */
export function ConfluenceGauge({ confluence }: Props) {
  const { score, direction, active_count, regime, regime_label, confidence, volume_confirmed, breakdown } = confluence;

  // Cas sans régime
  if (regime === "none") {
    return (
      <div className="rounded-lg border border-bg-border bg-bg-base p-4">
        <div className="text-sm text-gray-500">
          Aucun régime identifiable — le prix ou l'OI n'a pas de mouvement significatif
          sur la fenêtre de {breakdown.find((b) => b.criterion === "open_interest")?.label?.split("/")[1]?.replace("min", "") ?? 60}min.
        </div>
        <div className="mt-3 space-y-1.5">
          {breakdown.map((s) => (
            <div key={s.criterion} className={`flex items-center gap-2 rounded px-2 py-1.5 text-sm ${s.active ? "bg-bg-panel" : "opacity-40"}`}>
              <span className="w-5 text-center">{CRITERION_ICONS[s.criterion] ?? "•"}</span>
              <span className="w-28 text-gray-300">{CRITERION_LABELS_MAP[s.criterion]}</span>
              <span className="flex-1 truncate text-xs text-gray-500">{s.label}</span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // Position du curseur sur la jauge (0% = -10, 50% = 0, 100% = +10)
  const cursorPos = ((score + 10) / 20) * 100;
  const cursorColor = direction === "bullish" ? "bg-green-400" : direction === "bearish" ? "bg-red-400" : "bg-blue-400";

  return (
    <div className="rounded-lg border border-bg-border bg-bg-base p-4">
      {/* Régime en évidence (info principale) */}
      <div className="mb-4 flex items-center gap-3">
        <span className={`rounded-md px-3 py-1 text-sm font-semibold ${regimeBadgeStyle(regime, confidence)}`}>
          {directionArrow(direction)} {regime_label}
        </span>
        {volume_confirmed && (
          <span className="rounded bg-blue-500/20 px-2 py-0.5 text-xs text-blue-300">
            📊 Volume confirmé
          </span>
        )}
        <span className="ml-auto text-xs text-gray-500">
          Fiabilité: <span className="font-mono text-gray-300">{Math.round(confidence * 100)}%</span>
        </span>
      </div>

      {/* Score + jauge */}
      <div className="mb-4 flex items-center gap-4">
        <div className={`font-mono text-2xl font-bold ${colorScore(score)}`}>
          {fmtScore(score)}
          <span className="ml-1 text-sm text-gray-500">/ 10</span>
        </div>
        <div className="flex-1">
          {/* Jauge horizontale */}
          <div className="relative h-2 rounded-full bg-gradient-to-r from-red-500/40 via-gray-700 to-green-500/40">
            <div
              className={`absolute top-1/2 h-4 w-1 -translate-x-1/2 -translate-y-1/2 rounded ${cursorColor}`}
              style={{ left: `${cursorPos}%` }}
            />
          </div>
          <div className="mt-1 flex justify-between text-[10px] text-gray-600">
            <span>−10 baissier</span>
            <span>0</span>
            <span>+10 haussier</span>
          </div>
        </div>
      </div>

      {/* Breakdown par critère */}
      <div className="space-y-1.5">
        {breakdown.map((s) => {
          const isActive = Math.abs(s.score) > 0;
          return (
            <div
              key={s.criterion}
              className={`flex items-center gap-2 rounded px-2 py-1.5 text-sm ${
                isActive ? "bg-bg-panel" : "opacity-40"
              }`}
            >
              <span className="w-5 text-center">{CRITERION_ICONS[s.criterion] ?? "•"}</span>
              <span className="w-28 text-gray-300">{CRITERION_LABELS_MAP[s.criterion]}</span>
              <span className="flex-1 truncate text-xs text-gray-500">{s.label}</span>
              <span className={`w-8 text-right font-mono ${colorScore(s.score)}`}>
                {directionArrow(s.direction)}
              </span>
              <span className={`w-14 text-right font-mono ${colorScore(s.score)}`}>
                {fmtScore(s.score)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
