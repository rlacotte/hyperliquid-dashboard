import { describe, expect, it } from "vitest";
import { annualize, breakEvenDays, buildArbRows, nextFundingAfter, roundTripFee } from "./funding";

const venue = (rate: string, intervalH: number) => ({ fundingRate: rate, nextFundingTime: 0, fundingIntervalHours: intervalH });

describe("annualisation", () => {
  it("met sur la même échelle un taux horaire et un taux 8 h", () => {
    // 0,01 %/h sur Hyperliquid == 0,08 %/8 h sur Binance : même APR.
    expect(annualize(0.0001, 1)).toBeCloseTo(annualize(0.0008, 8), 12);
    expect(annualize(0.0001, 1)).toBeCloseTo(0.876, 6);
  });

  it("piège évité : à taux brut égal, un funding horaire rapporte 8× plus qu'un 8 h", () => {
    expect(annualize(0.0001, 1) / annualize(0.0001, 8)).toBeCloseTo(8, 9);
  });
});

describe("meilleure paire", () => {
  it("shorte la plateforme au funding le plus haut, achète la plus basse", () => {
    const [row] = buildArbRows([
      ["BTC", [["HlPerp", venue("0.0001", 1)], ["BinPerp", venue("0.0001", 8)]]],
    ]);
    // HL : 87,6 %/an ; Binance : 10,95 %/an → short HL, long Binance.
    expect(row.short?.venue).toBe("HlPerp");
    expect(row.long?.venue).toBe("BinPerp");
    expect(row.spreadApr).toBeCloseTo(0.876 - 0.1095, 4);
  });

  it("gère un funding négatif : le short est la jambe la moins négative", () => {
    const [row] = buildArbRows([
      ["X", [["HlPerp", venue("-0.0005", 1)], ["BybitPerp", venue("0.0001", 4)]]],
    ]);
    expect(row.short?.venue).toBe("BybitPerp");
    expect(row.long?.venue).toBe("HlPerp");
    expect(row.spreadApr).toBeGreaterThan(0);
  });

  it("par défaut, ignore un arbitrage qui n'inclut pas Hyperliquid", () => {
    const raw: Parameters<typeof buildArbRows>[0] = [
      ["X", [["HlPerp", venue("0.0000125", 1)], ["BinPerp", venue("0.01", 8)], ["BybitPerp", venue("-0.01", 8)]]],
    ];
    const [withHl] = buildArbRows(raw, true);
    const [any] = buildArbRows(raw, false);
    expect([withHl.short?.venue, withHl.long?.venue]).toContain("HlPerp");
    // Sans contrainte, le gros écart Binance ↔ Bybit l'emporte.
    expect([any.short?.venue, any.long?.venue].sort()).toEqual(["BinPerp", "BybitPerp"]);
    expect(any.spreadApr).toBeGreaterThan(withHl.spreadApr);
  });

  it("une seule plateforme disponible : pas d'arbitrage", () => {
    const [row] = buildArbRows([["SOLO", [["HlPerp", venue("0.001", 1)], ["BinPerp", null]]]]);
    expect(row.short).toBeNull();
    expect(row.spreadApr).toBe(0);
  });
});

describe("prochaine échéance", () => {
  const H = 3600_000;
  it("projette en avant une échéance passée (cas Hyperliquid constaté en direct)", () => {
    // API : 09:00, il est 09:31 → prochaine échéance 10:00.
    expect(nextFundingAfter(9 * H, 1, 9 * H + 31 * 60_000)).toBe(10 * H);
  });
  it("saute plusieurs périodes si nécessaire", () => {
    expect(nextFundingAfter(9 * H, 1, 12 * H + 5 * 60_000)).toBe(13 * H);
  });
  it("à l'instant exact d'une échéance, renvoie la suivante", () => {
    expect(nextFundingAfter(9 * H, 1, 9 * H)).toBe(10 * H);
  });
  it("laisse intacte une échéance déjà future (Binance, Bybit)", () => {
    expect(nextFundingAfter(13 * H, 4, 9 * H)).toBe(13 * H);
  });
});

describe("frais et rentabilité", () => {
  it("compte ouverture + fermeture sur les deux jambes", () => {
    // taker : 2 × (0,045 % + 0,05 %) = 0,19 %
    expect(roundTripFee("HlPerp", "BinPerp", "taker")).toBeCloseTo(0.0019, 10);
  });

  it("calcule le seuil de rentabilité en jours", () => {
    // 0,19 % de frais, 19 %/an d'écart → 3,65 jours.
    expect(breakEvenDays(0.19, 0.0019)).toBeCloseTo(3.65, 6);
  });

  it("aucun écart : jamais rentable", () => {
    expect(breakEvenDays(0, 0.0019)).toBeNull();
  });
});
