import { useEffect, useRef } from "react";
import {
  createChart,
  ColorType,
  type IChartApi,
  type UTCTimestamp,
} from "lightweight-charts";
import type { FundingPoint } from "../types";

interface Props {
  data: FundingPoint[];
}

export function FundingChart({ data }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: "#111722" },
        textColor: "#9ca3af",
      },
      grid: {
        vertLines: { color: "#1a2230" },
        horzLines: { color: "#1a2230" },
      },
      rightPriceScale: { borderColor: "#1f2937" },
      timeScale: { borderColor: "#1f2937", timeVisible: true, secondsVisible: false },
      width: containerRef.current.clientWidth,
      height: 200,
    });

    const series = chart.addAreaSeries({
      lineColor: "#8b5cf6",
      topColor: "rgba(139, 92, 246, 0.4)",
      bottomColor: "rgba(139, 92, 246, 0.0)",
      lineWidth: 2,
    });

    const mapped = data.map((p) => ({
      time: (p.time / 1000) as UTCTimestamp,
      value: p.funding * 100, // en %
    }));
    series.setData(mapped);
    chart.timeScale().fitContent();

    const handleResize = () => {
      if (containerRef.current) {
        chart.applyOptions({ width: containerRef.current.clientWidth });
      }
    };
    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
      chart.remove();
    };
  }, [data]);

  return <div ref={containerRef} className="w-full" />;
}
