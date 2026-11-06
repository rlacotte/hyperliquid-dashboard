import { useEffect, useRef } from "react";
import { ColorType, createChart, type UTCTimestamp } from "lightweight-charts";

interface Props {
  points: { t: number; v: number }[];
  height?: number;
  /** Couleur selon le signe de la dernière valeur (PnL) ou fixe. */
  tone?: "auto" | "blue";
}

export function AreaChart({ points, height = 220, tone = "blue" }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || points.length === 0) return;
    const last = points[points.length - 1].v;
    const color = tone === "auto" ? (last >= 0 ? "#22c55e" : "#ef4444") : "#3b82f6";

    const chart = createChart(el, {
      layout: { background: { type: ColorType.Solid, color: "#111722" }, textColor: "#9ca3af" },
      grid: { vertLines: { color: "#1a2230" }, horzLines: { color: "#1a2230" } },
      rightPriceScale: { borderColor: "#1f2937" },
      timeScale: { borderColor: "#1f2937", timeVisible: true, secondsVisible: false },
      width: el.clientWidth,
      height,
    });
    const series = chart.addAreaSeries({
      lineColor: color,
      topColor: `${color}55`,
      bottomColor: `${color}05`,
      lineWidth: 2,
      priceFormat: { type: "custom", formatter: (v: number) => compact(v) },
    });
    // lightweight-charts exige des temps strictement croissants et uniques.
    const seen = new Set<number>();
    const data = points
      .map((p) => ({ time: Math.floor(p.t / 1000) as UTCTimestamp, value: p.v }))
      .filter((p) => (seen.has(p.time) ? false : (seen.add(p.time), true)))
      .sort((a, b) => a.time - b.time);
    series.setData(data);
    chart.timeScale().fitContent();

    const ro = new ResizeObserver(() => chart.applyOptions({ width: el.clientWidth }));
    ro.observe(el);
    return () => {
      ro.disconnect();
      chart.remove();
    };
  }, [points, height, tone]);

  if (points.length === 0) {
    return (
      <div style={{ height }} className="flex items-center justify-center text-sm text-gray-500">
        Pas d'historique sur cette période.
      </div>
    );
  }
  return <div ref={ref} className="w-full" />;
}

function compact(v: number): string {
  const a = Math.abs(v);
  const s = v < 0 ? "-" : "";
  if (a >= 1e9) return `${s}$${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${s}$${(a / 1e3).toFixed(1)}K`;
  return `${s}$${a.toFixed(0)}`;
}
