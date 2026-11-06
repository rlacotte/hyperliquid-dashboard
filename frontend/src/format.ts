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

/** Montant signé compact : +$1.20M, -$88.0K. fmtUsd ne gère pas les négatifs. */
export function fmtUsdSigned(v: number): string {
  const sign = v > 0 ? "+" : v < 0 ? "-" : "";
  return `${sign}${fmtUsd(Math.abs(v))}`;
}

/** Âge relatif court : « 12 s », « 4 min », « 3 h », « 2 j ». */
export function fmtAgo(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h`;
  return `${Math.floor(s / 86400)} j`;
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

/**
 * Annualise un taux de funding.
 * Hyperliquid paie toutes les heures, Binance et Bybit toutes les 4 ou 8 h :
 * comparer des taux bruts mélange des périodes différentes. L'APR remet tout
 * sur la même échelle.
 */
export function fundingApr(rate: number, intervalHours = 1): number {
  return (rate / intervalHours) * 24 * 365;
}

export function fmtApr(apr: number): string {
  const sign = apr >= 0 ? "+" : "";
  const pct = apr * 100;
  return `${sign}${Math.abs(pct) >= 100 ? pct.toFixed(0) : pct.toFixed(1)}%`;
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

export function fmtUsdLarge(v: number): string {
  // Marketcap, OI : formatage T/B/M
  if (v >= 1e12) return `$${(v / 1e12).toFixed(2)}T`;
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${v.toFixed(2)}`;
}

// Couleur de la valeur Fear & Greed (0-100)
export function fearGreedColor(value: number): string {
  if (value <= 25) return "text-red-400"; // Extreme Fear
  if (value <= 45) return "text-orange-400"; // Fear
  if (value <= 55) return "text-yellow-400"; // Neutral
  if (value <= 75) return "text-lime-400"; // Greed
  return "text-green-400"; // Extreme Greed
}

// Couleur de fond pour la jauge F&G (dégradé rouge→vert)
export function fearGreedBgColor(value: number): string {
  if (value <= 25) return "bg-red-500";
  if (value <= 45) return "bg-orange-500";
  if (value <= 55) return "bg-yellow-500";
  if (value <= 75) return "bg-lime-500";
  return "bg-green-500";
}
