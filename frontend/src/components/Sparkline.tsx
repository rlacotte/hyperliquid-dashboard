interface Props {
  values: number[];
  width?: number;
  height?: number;
  color?: string;
  className?: string;
}

/**
 * Mini-graphique SVG sans axes, pour donner une tendance visuelle rapide.
 * Utilisé dans les cartes du bandeau de métriques globales.
 */
export function Sparkline({
  values,
  width = 80,
  height = 24,
  color = "#6b7280",
  className,
}: Props) {
  if (!values || values.length < 2) {
    return <div style={{ width, height }} className={className} />;
  }

  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1; // évite division par 0

  const points = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * width;
      const y = height - ((v - min) / range) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  // Aire sous la courbe
  const areaPoints = `0,${height} ${points} ${width},${height}`;

  return (
    <svg width={width} height={height} className={className} preserveAspectRatio="none">
      <polygon points={areaPoints} fill={color} fillOpacity={0.15} />
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
