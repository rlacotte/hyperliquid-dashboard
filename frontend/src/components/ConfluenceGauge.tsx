import type { ConfluenceScore } from "../types";
import { CRITERION_LABELS_MAP, colorScore, directionArrow, directionLabel, fmtScore } from "./confluenceHelpers";

interface Props {
  confluence: ConfluenceScore;
}

const CRITERION_ICONS: Record<string, string> = {
  price_change: "📈",
  volume: "📊",
  open_interest: "💰",
  funding_rate: "💸",
};

/**
 * Jauge horizontale [-10, +10] + breakdown détaillé des critères contributeurs.
 */
export function ConfluenceGauge({ confluence }: Props) {
  const { score, direction, active_count, breakdown } = confluence;

  // Position du curseur sur la jauge (0% = -10, 50% = 0, 100% = +10)
  const cursorPos = ((score + 10) / 20) * 100;
  const cursorColor =
    direction === "bullish" ? "bg-green-400" : direction === "bearish" ? "bg-red-400" : "bg-gray-400";

  return (
    <div className="rounded-lg border border-bg-border bg-bg-base p-4">
      {/* Score global + direction */}
      <div className="mb-3 flex items-center gap-3">
        <div>
          <div className="text-xs uppercase tracking-wide text-gray-500">Score de confluence</div>
          <div className={`flex items-baseline gap-2 font-mono text-2xl font-bold ${colorScore(score)}`}>
            <span>{directionArrow(direction)}</span>
            <span>{fmtScore(score)}</span>
            <span className="text-sm text-gray-500">/ 10</span>
          </div>
        </div>
        <div className="ml-auto text-right">
          <div className="text-xs uppercase tracking-wide text-gray-500">Direction</div>
          <div className={`font-semibold ${colorScore(score)}`}>{directionLabel(direction)}</div>
        </div>
        <div className="text-right">
          <div className="text-xs uppercase tracking-wide text-gray-500">Critères actifs</div>
          <div className="font-semibold text-gray-200">{active_count}/4</div>
        </div>
      </div>

      {/* Jauge horizontale */}
      <div className="relative mb-1 h-2 rounded-full bg-gradient-to-r from-red-500/40 via-gray-700 to-green-500/40">
        <div
          className={`absolute top-1/2 h-4 w-1 -translate-x-1/2 -translate-y-1/2 rounded ${cursorColor}`}
          style={{ left: `${cursorPos}%` }}
        />
      </div>
      <div className="mb-4 flex justify-between text-[10px] text-gray-600">
        <span>−10 baissier</span>
        <span>0</span>
        <span>+10 haussier</span>
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
