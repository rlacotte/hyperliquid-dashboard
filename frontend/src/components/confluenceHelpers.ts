import type { Criterion } from "../types";

// Libellés des critères partagés entre ConfluenceGauge et AlertsPanel
export const CRITERION_LABELS_MAP: Record<Criterion, string> = {
  price_change: "Prix",
  volume: "Volume",
  open_interest: "Open Interest",
  funding_rate: "Funding",
  confluence: "Confluence",
  funding_arb: "Arbitrage funding",
};

export function fmtScore(v: number): string {
  return `${v >= 0 ? "+" : ""}${v.toFixed(2)}`;
}

export function colorScore(v: number): string {
  if (v >= 1) return "text-green-400";
  if (v > 0) return "text-green-600";
  if (v <= -1) return "text-red-400";
  if (v < 0) return "text-red-600";
  return "text-gray-500";
}

export function directionArrow(dir: string | null | undefined): string {
  if (dir === "bullish") return "▲";
  if (dir === "bearish") return "▼";
  return "●";
}

export function directionLabel(dir: string | null | undefined): string {
  if (dir === "bullish") return "Haussier";
  if (dir === "bearish") return "Baissier";
  return "Neutre";
}
