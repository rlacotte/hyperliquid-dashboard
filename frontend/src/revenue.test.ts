import { describe, expect, it } from "vitest";
import { annualHolders, annualRevenue, fmtMultiple, holdersShare, liveValuation, median, multiple, revenueTrend, type RevenueRow } from "./revenue";

const row = (over: Partial<RevenueRow> = {}): RevenueRow => ({
  symbol: "UNI",
  name: "Uniswap",
  gecko_id: "uniswap",
  tab: "dex",
  category: "Dexs",
  listed: "perp",
  rev_24h: 0.3e6,
  rev_30d: 9e6,
  rev_prev_30d: 6e6,
  rev_1y: 100e6,
  mcap: 4e9,
  fdv: 6e9,
  price: 8,
  sources: [],
  ...over,
});

describe("revenus annuels", () => {
  it("30 jours annualisés ou 12 mois", () => {
    expect(annualRevenue(row(), "30d")).toBeCloseTo(9e6 * 365 / 30, 6);
    expect(annualRevenue(row(), "1y")).toBe(100e6);
  });

  it("tendance sur 30 jours", () => {
    expect(revenueTrend(row())).toBeCloseTo(0.5, 9);
    expect(revenueTrend(row({ rev_prev_30d: 0 }))).toBeNull();
  });
});

describe("revenus aux détenteurs", () => {
  it("annualisés comme les revenus", () => {
    const r = row({ hold_30d: 3e6, hold_1y: 30e6 });
    expect(annualHolders(r, "30d")).toBeCloseTo(3e6 * 365 / 30, 6);
    expect(annualHolders(r, "1y")).toBe(30e6);
  });

  it("non publié n'est pas zéro", () => {
    expect(annualHolders(row({ hold_30d: null }), "30d")).toBeNull();
    expect(annualHolders(row(), "30d")).toBeNull(); // relevé antérieur à la donnée
    expect(annualHolders(row({ hold_30d: 0, hold_1y: 0 }), "30d")).toBe(0);
  });

  it("part reversée", () => {
    expect(holdersShare(row({ hold_30d: 4.5e6 }))).toBeCloseTo(0.5, 9);
    expect(holdersShare(row({ hold_30d: 12e6 }))).toBe(1); // entités différentes : bornée
    expect(holdersShare(row({ hold_30d: null }))).toBeNull();
  });

  it("un multiple sur des revenus aux détenteurs nuls n'existe pas", () => {
    expect(multiple(4e9, annualHolders(row({ hold_30d: 0, hold_1y: 0 }), "30d") ?? 0)).toBeNull();
  });
});

describe("valorisation en direct", () => {
  it("MC et FDV suivent le prix, l'offre restant fixe", () => {
    const v = liveValuation(row(), 8.8);
    expect(v.mcap).toBeCloseTo(4.4e9, 3);
    expect(v.fdv).toBeCloseTo(6.6e9, 3);
  });

  it("sans prix en direct, les valeurs du relevé", () => {
    expect(liveValuation(row(), undefined)).toEqual({ mcap: 4e9, fdv: 6e9 });
  });

  it("un prix d'une autre unité est ignoré", () => {
    // Perp coté par 1 000 unités, ou token re-dénominé : ×1000 n'est pas un mouvement de marché.
    expect(liveValuation(row(), 8000)).toEqual({ mcap: 4e9, fdv: 6e9 });
  });

  it("FDV absente : reste absente", () => {
    expect(liveValuation(row({ fdv: null }), 8).fdv).toBeNull();
  });
});

describe("multiples", () => {
  it("valorisation / revenus annuels", () => {
    expect(multiple(4e9, 100e6)).toBe(40);
    expect(multiple(null, 100e6)).toBeNull();
    expect(multiple(4e9, 0)).toBeNull();
  });

  it("affichage", () => {
    expect(fmtMultiple(4.23)).toBe("4.2×");
    expect(fmtMultiple(154.1)).toBe("154×");
    expect(fmtMultiple(null)).toBe("—");
    // MOVE : 1,52 $ de revenus sur 30 jours pour 27 M$ de capitalisation.
    expect(fmtMultiple(1_463_971)).toBe("> 10 000×");
  });

  it("médiane", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNull();
  });
});
