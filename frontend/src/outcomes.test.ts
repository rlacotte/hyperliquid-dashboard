import { describe, expect, it } from "vitest";
import {
  buildLadders,
  distribution,
  impliedMedian,
  isLiquid,
  isotonicDecreasing,
  parseDescription,
  parseExpiry,
  probAbove,
  type Ladder,
} from "./outcomes";

const NOW = Date.UTC(2026, 10, 7);

describe("lecture des marchés", () => {
  it("analyse la description", () => {
    const d = parseDescription("perp:xyz:GOLD|priceDescription:1-minute candle|seconds:300|threshold:4400|time:20261130-2100");
    // Le préfixe de DEX contient lui-même « : » : seul le premier sépare clé et valeur.
    expect(d.perp).toBe("xyz:GOLD");
    expect(d.threshold).toBe("4400");
  });

  it("échéance en UTC", () => {
    expect(parseExpiry("20261130-2100")).toBe(Date.UTC(2026, 10, 30, 21, 0));
    expect(parseExpiry("n'importe quoi")).toBeNull();
  });

  it("regroupe par sous-jacent et échéance, trie les seuils, écarte les échues et les échelles trop courtes", () => {
    const o = (id: number, perp: string, k: number, time = "20261130-2100") => ({
      outcome: id,
      name: "template:binaryPrice",
      description: `perp:${perp}|threshold:${k}|time:${time}`,
    });
    const ladders = buildLadders(
      [
        o(1, "xyz:GOLD", 4400), o(2, "xyz:GOLD", 3600), o(3, "xyz:GOLD", 4000),
        o(4, "BTC", 75000), o(5, "BTC", 76000),                       // 2 seuils : écartée
        o(6, "ETH", 2000, "20260101-0000"), o(7, "ETH", 2100, "20260101-0000"), o(8, "ETH", 2200, "20260101-0000"), // échue
        { outcome: 9, name: "template:sportsContestWinner", description: "x" },
      ],
      { "#10": "0.94", "#30": "0.5", "#20": "0.08" },
      NOW
    );
    expect(ladders).toHaveLength(1);
    expect(ladders[0].underlying).toBe("xyz:GOLD");
    expect(ladders[0].points.map((p) => p.threshold)).toEqual([3600, 4000, 4400]);
  });
});

describe("liquidité", () => {
  it("exige un carnet des deux côtés et un écart serré", () => {
    expect(isLiquid({ threshold: 1, coin: "#1", mid: 0.08, bid: 0.0757, ask: 0.0826 })).toBe(true);
    // Cas réel sur l'argent : 0,69 / 0,93 — trop large pour être une probabilité.
    expect(isLiquid({ threshold: 1, coin: "#1", mid: 0.81, bid: 0.689, ask: 0.928 })).toBe(false);
    expect(isLiquid({ threshold: 1, coin: "#1", mid: 0.5, bid: null, ask: 0.6 })).toBe(false);
  });
});

describe("monotonie (régression isotone)", () => {
  it("laisse intacte une suite déjà décroissante", () => {
    expect(isotonicDecreasing([0.9, 0.6, 0.2])).toEqual([0.9, 0.6, 0.2]);
  });
  it("corrige une remontée par la moyenne des points en conflit", () => {
    // 0,5 puis 0,6 : impossible (P(>K) ne peut pas augmenter avec K).
    const out = isotonicDecreasing([0.9, 0.5, 0.6, 0.1]);
    expect(out[1]).toBeCloseTo(0.55, 9);
    expect(out[2]).toBeCloseTo(0.55, 9);
    for (let i = 1; i < out.length; i++) expect(out[i]).toBeLessThanOrEqual(out[i - 1]);
  });
});

const ladder = (pts: [number, number][]): Ladder => ({
  underlying: "xyz:GOLD",
  expiry: NOW + 86400_000,
  priceDescription: "",
  points: pts.map(([k, p], i) => ({ threshold: k, coin: `#${i}0`, mid: p, bid: p - 0.01, ask: p + 0.01 })),
});

describe("distribution", () => {
  it("les tranches somment à 1", () => {
    const d = distribution(ladder([[3600, 0.94], [4000, 0.6], [4400, 0.08]]))!;
    expect(d.buckets.reduce((s, b) => s + b.p, 0)).toBeCloseTo(1, 9);
    expect(d.buckets[0]).toMatchObject({ from: null, to: 3600 });
    expect(d.buckets[0].p).toBeCloseTo(0.06, 9);
    expect(d.buckets[1].p).toBeCloseTo(0.34, 9);
    expect(d.buckets[3]).toMatchObject({ from: 4400, to: null });
  });

  it("les cotations illiquides sont écartées, et sous deux points il n'y a rien", () => {
    const l = ladder([[3600, 0.94], [4000, 0.6], [4400, 0.08]]);
    l.points[1].bid = null;
    expect(distribution(l)!.used).toBe(2);
    l.points[0].bid = null;
    expect(distribution(l)).toBeNull();
  });

  it("médiane implicite par interpolation", () => {
    const d = distribution(ladder([[3600, 0.94], [4000, 0.6], [4400, 0.08]]))!;
    // S passe de 0,6 à 0,08 entre 4000 et 4400 : 0,5 est atteint à 4000 + 0,1/0,52 × 400.
    expect(impliedMedian(d)).toBeCloseTo(4000 + (0.1 / 0.52) * 400, 6);
  });

  it("pas de médiane si la plage ne l'encadre pas", () => {
    expect(impliedMedian(distribution(ladder([[1, 0.9], [2, 0.8], [3, 0.7]]))!)).toBeNull();
  });

  it("probabilité au-dessus d'un prix, sans extrapolation", () => {
    const d = distribution(ladder([[3600, 0.94], [4000, 0.6], [4400, 0.08]]))!;
    expect(probAbove(d, 4000)).toBeCloseTo(0.6, 9);
    expect(probAbove(d, 3800)).toBeCloseTo(0.77, 9);
    expect(probAbove(d, 5000)).toBeNull();
  });
});
