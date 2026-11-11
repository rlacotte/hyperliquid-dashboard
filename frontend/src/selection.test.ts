import { describe, expect, it } from "vitest";
import { pick, reasons, scoreAll, WEIGHTS } from "./selection";
import type { RevenueRow } from "./revenue";

const row = (symbol: string, over: Partial<RevenueRow> = {}): RevenueRow => ({
  symbol,
  name: symbol,
  gecko_id: symbol.toLowerCase(),
  tab: "dex",
  category: "Dexs",
  listed: "perp",
  rev_24h: 0,
  rev_30d: 10e6,
  rev_prev_30d: 10e6,
  rev_1y: 120e6,
  hold_30d: 5e6,
  mcap: 1.2e9, // MC/rev. annuel ≈ 9,9×
  fdv: 1.2e9,
  price: 1,
  px_chg_30d: 0,
  sources: [],
  ...over,
});

const ctx = { livePx: {}, fundingApr: {} };

describe("éligibilité", () => {
  it("L1/L2, spot, petites capitalisations et revenus anecdotiques sont exclus", () => {
    const scored = scoreAll(
      [
        row("OK"),
        row("ETH", { tab: "l1" }),
        row("ARB", { tab: "l2" }),
        row("SPOT", { listed: "spot" }),
        row("TINY", { mcap: 10e6 }),
        row("NOREV", { rev_30d: 50e3 }),
        row("NOMC", { mcap: null }),
      ],
      ctx
    );
    expect(scored.map((s) => s.row.symbol)).toEqual(["OK"]);
  });
});

describe("notes", () => {
  it("un token 4× moins cher que ses pairs obtient la note maximale de valorisation", () => {
    const scored = scoreAll([row("A"), row("B"), row("C"), row("CHEAP", { mcap: 0.3e9 })], ctx);
    const cheap = scored.find((s) => s.row.symbol === "CHEAP")!;
    expect(cheap.factors.find((f) => f.key === "value")!.value).toBeCloseTo(1, 6);
    expect(cheap.peerLabel).toBe("DEX");
  });

  it("sans assez de pairs, comparaison à tous secteurs", () => {
    const scored = scoreAll([row("A"), row("L", { tab: "lending" })], ctx);
    expect(scored.find((s) => s.row.symbol === "L")!.peerLabel).toBe("tous secteurs");
  });

  it("dilution : FDV = 3 × MC donne −1", () => {
    const s = scoreAll([row("D", { fdv: 3.6e9 })], ctx)[0];
    expect(s.factors.find((f) => f.key === "dilution")!.value).toBeCloseTo(-1, 6);
  });

  it("funding très positif pénalise, très négatif favorise", () => {
    const s = scoreAll([row("F"), row("G")], { livePx: {}, fundingApr: { F: 0.5, G: -0.5 } });
    expect(s.find((x) => x.row.symbol === "F")!.factors.find((f) => f.key === "funding")!.value).toBe(-1);
    expect(s.find((x) => x.row.symbol === "G")!.factors.find((f) => f.key === "funding")!.value).toBe(1);
  });

  it("données inconnues : neutres, pas pénalisantes", () => {
    const s = scoreAll([row("U", { hold_30d: null, px_chg_30d: null, rev_prev_30d: 0 })], ctx)[0];
    for (const k of ["accrual", "priceTrend", "revenueTrend"] as const) expect(s.factors.find((f) => f.key === k)!.value).toBe(0);
  });

  it("le score est la somme pondérée et reste entre −1 et +1", () => {
    expect(Object.values(WEIGHTS).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
    const s = scoreAll([row("A", { mcap: 0.3e9, rev_prev_30d: 5e6, px_chg_30d: 0.6, hold_30d: 10e6 })], { livePx: {}, fundingApr: { A: -1 } })[0];
    expect(s.score).toBeLessThanOrEqual(1);
    expect(s.score).toBeCloseTo(s.factors.reduce((t, f) => t + f.contribution, 0), 9);
  });
});

describe("sélection", () => {
  const universe = [
    row("BEST", { mcap: 0.3e9, rev_prev_30d: 6e6, px_chg_30d: 0.3, hold_30d: 10e6 }),
    row("GOOD", { mcap: 0.6e9, rev_prev_30d: 8e6 }),
    row("OKAY", { mcap: 0.9e9 }),
    row("MEH", { mcap: 1.5e9, hold_30d: 2e6 }),
    row("BAD", { mcap: 3e9, rev_prev_30d: 15e6, hold_30d: 0 }),
    row("WORST", { mcap: 5e9, rev_prev_30d: 20e6, px_chg_30d: -0.4, hold_30d: 0, fdv: 15e9 }),
  ];

  it("3 à l'achat (scores positifs) et 3 à la vente (négatifs), sans recouvrement", () => {
    const { buy, sell } = pick(scoreAll(universe, ctx));
    expect(buy[0].row.symbol).toBe("BEST");
    expect(sell[0].row.symbol).toBe("WORST");
    expect(buy.every((b) => b.score > 0)).toBe(true);
    expect(sell.every((s) => s.score < 0)).toBe(true);
    expect(buy.some((b) => sell.includes(b))).toBe(false);
  });

  it("les raisons vont dans le sens du classement", () => {
    const scored = scoreAll(universe, ctx);
    const { buy, sell } = pick(scored);
    expect(reasons(buy[0], "buy").every((f) => f.contribution > 0)).toBe(true);
    expect(reasons(sell[0], "sell").every((f) => f.contribution < 0)).toBe(true);
    expect(reasons(sell[0], "sell")[0].key).toBe("value");
  });
});
