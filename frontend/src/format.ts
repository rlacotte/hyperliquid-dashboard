/** Helpers de formatage pour le dashboard. */

export function fmtPrice(px: number): string {
  if (px >= 1000) return px.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (px >= 1) return px.toFixed(2);
  if (px >= 0.01) return px.toFixed(4);
  return px.toPrecision(4);
}

export function fmtUsd(v: number): string {
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${v.toFixed(2)}`;
}

export function fmtPct(v: number): string {
  const sign = v >= 0 ? "+" : "";
  return `${sign}${(v * 100).toFixed(2)}%`;
}

export function fmtFunding(v: number): string {
  // funding est une fraction décimale (0.0005 = 0.05%)
  const sign = v >= 0 ? "+" : "";
  return `${sign}${(v * 100).toFixed(4)}%`;
}

export function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function colorPct(v: number): string {
  if (v > 0) return "text-green-400";
  if (v < 0) return "text-red-400";
  return "text-gray-400";
}

export function fmtScore(v: number): string {
  return `${v >= 0 ? "+" : ""}${v.toFixed(1)}`;
}

export function colorScore(v: number): string {
  if (v >= 4) return "text-green-400"; // signal haussier fort
  if (v > 0) return "text-green-600";
  if (v <= -4) return "text-red-400"; // signal baissier fort
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
