import { memo, useEffect, useRef, useState } from "react";
import { fmtPrice } from "../format";

interface Props {
  value: number;
  className?: string;
}

/**
 * Prix qui flashe vert/rouge quand il change.
 *
 * L'animation est rejouée en changeant la clé de l'élément (remontage), plus
 * fiable que basculer une classe : deux hausses successives produiraient sinon
 * une seule animation, la classe n'ayant pas changé entre-temps.
 */
export const LivePrice = memo(function LivePrice({ value, className = "" }: Props) {
  const prev = useRef(value);
  const [flash, setFlash] = useState<{ dir: "up" | "down"; n: number } | null>(null);

  useEffect(() => {
    if (value !== prev.current && prev.current !== 0) {
      setFlash((f) => ({ dir: value > prev.current ? "up" : "down", n: (f?.n ?? 0) + 1 }));
    }
    prev.current = value;
  }, [value]);

  const cls = flash ? (flash.dir === "up" ? "flash-up" : "flash-down") : "";
  return (
    <span key={flash?.n ?? 0} className={`tabular-nums ${cls} ${className}`}>
      {fmtPrice(value)}
    </span>
  );
});
