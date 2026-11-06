import { describe, expect, it } from "vitest";
import type { Position } from "./hl/client";
import { isAddress, liqRisk, pnlBreakdown, positionView } from "./wallet";

const pos = (over: Partial<Position>): Position => ({
  coin: "BTC",
  szi: "1",
  entryPx: "100",
  positionValue: "110",
  unrealizedPnl: "10",
  returnOnEquity: "0.1",
  liquidationPx: "80",
  marginUsed: "20",
  leverage: { type: "cross", value: 5 },
  cumFunding: { allTime: "0", sinceOpen: "0" },
  ...over,
});

describe("adresse", () => {
  it("valide une adresse EVM", () => {
    expect(isAddress("0xf5d81a135f756ca16544e53c20fc20643ec3ad53")).toBe(true);
    expect(isAddress("  0xF5D81A135F756CA16544E53C20FC20643EC3AD53 ")).toBe(true);
  });
  it("rejette le reste", () => {
    expect(isAddress("0x123")).toBe(false);
    expect(isAddress("f5d81a135f756ca16544e53c20fc20643ec3ad53")).toBe(false);
    expect(isAddress("0xg5d81a135f756ca16544e53c20fc20643ec3ad53")).toBe(false);
  });
});

describe("position", () => {
  it("long : PnL et distance à la liquidation au prix courant", () => {
    const v = positionView(pos({}), "", 110);
    expect(v.side).toBe("long");
    expect(v.upnl).toBeCloseTo(10, 9);
    // Liquidé à 80 depuis 110 : le prix peut baisser de 27,3 %.
    expect(v.liqDistance).toBeCloseTo(30 / 110, 9);
  });

  it("short : la liquidation est AU-DESSUS du prix", () => {
    const v = positionView(pos({ szi: "-2", entryPx: "100", liquidationPx: "125" }), "", 90);
    expect(v.side).toBe("short");
    expect(v.size).toBe(2);
    expect(v.upnl).toBeCloseTo(20, 9); // -2 × (90 - 100)
    expect(v.liqDistance).toBeCloseTo(35 / 90, 9);
  });

  it("sans prix en direct, retombe sur le prix implicite de l'API", () => {
    const v = positionView(pos({ szi: "2", positionValue: "240" }), "", undefined);
    expect(v.markPx).toBe(120);
  });

  it("cumFunding positif = payé : affiché en négatif", () => {
    // Convention vérifiée en direct : les shorts qui encaissent ont un
    // cumFunding.sinceOpen négatif.
    expect(positionView(pos({ cumFunding: { allTime: "0", sinceOpen: "-4.85" } }), "", 110).fundingSinceOpen).toBeCloseTo(4.85, 9);
    expect(positionView(pos({ cumFunding: { allTime: "0", sinceOpen: "12" } }), "", 110).fundingSinceOpen).toBeCloseTo(-12, 9);
  });

  it("pas de prix de liquidation : distance inconnue, pas de faux risque", () => {
    const v = positionView(pos({ liquidationPx: null }), "", 110);
    expect(v.liqDistance).toBeNull();
    expect(liqRisk(v.liqDistance)).toBe("none");
  });

  it("classe le risque", () => {
    expect(liqRisk(0.03)).toBe("high");
    expect(liqRisk(0.1)).toBe("medium");
    expect(liqRisk(0.4)).toBe("low");
  });
});

describe("décomposition du PnL", () => {
  const f = (time: number, usdc: string) => ({ time, delta: { coin: "BTC", usdc } });

  it("sépare funding et trading", () => {
    const b = pnlBreakdown(1000, [f(1, "300"), f(2, "-50")], 0, 10, true);
    expect(b.funding).toBe(250);
    expect(b.trading).toBe(750);
    expect(b.fundingCoverage).toBe(1);
  });

  it("un trader qui perd sur le prix mais encaisse le funding", () => {
    // Le cas que les leaderboards masquent : PnL positif, directionnel négatif.
    const b = pnlBreakdown(200, [f(1, "500")], 0, 10, true);
    expect(b.trading).toBe(-300);
  });

  it("pagination incomplète : couverture partielle mesurée", () => {
    const b = pnlBreakdown(0, [f(2, "1"), f(4, "1")], 0, 10, false);
    expect(b.fundingCoverage).toBeCloseTo(0.4, 9);
  });
});
