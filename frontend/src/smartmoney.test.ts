import { describe, expect, it } from "vitest";
import type { ClearinghouseState } from "./hl/client";
import { aggregateBias, edgeBp, extractPositions, liquidationLadder, mapLimit, type LeaderRow, type TrackedPosition } from "./smartmoney";

const state = (positions: { coin: string; szi: string; value: string; liq: string | null }[]): ClearinghouseState => ({
  marginSummary: { accountValue: "0", totalNtlPos: "0", totalRawUsd: "0", totalMarginUsed: "0" },
  crossMaintenanceMarginUsed: "0",
  withdrawable: "0",
  time: 0,
  assetPositions: positions.map((p) => ({
    type: "oneWay",
    position: {
      coin: p.coin,
      szi: p.szi,
      entryPx: "100",
      positionValue: p.value,
      unrealizedPnl: "0",
      returnOnEquity: "0",
      liquidationPx: p.liq,
      marginUsed: "0",
      leverage: { type: "cross", value: 5 },
    },
  })),
});

describe("positionnement agrégé", () => {
  it("additionne longs et shorts par coin, et compte les traders", () => {
    const pos = extractPositions([
      { address: "0x1", state: state([{ coin: "BTC", szi: "1", value: "300", liq: null }]) },
      { address: "0x2", state: state([{ coin: "BTC", szi: "-2", value: "100", liq: null }, { coin: "ETH", szi: "1", value: "50", liq: null }]) },
    ]);
    const [btc, eth] = aggregateBias(pos);
    expect(btc.coin).toBe("BTC");
    expect(btc.longUsd).toBe(300);
    expect(btc.shortUsd).toBe(100);
    expect(btc.longTraders).toBe(1);
    expect(btc.shortTraders).toBe(1);
    expect(btc.bias).toBeCloseTo(0.5, 9);
    expect(eth.bias).toBe(1);
  });

  it("une position de valeur négative (short) compte en valeur absolue", () => {
    const [p] = extractPositions([{ address: "0x1", state: state([{ coin: "SOL", szi: "-3", value: "-90", liq: null }]) }]);
    expect(p.notional).toBe(90);
    expect(p.side).toBe("short");
  });

  it("ignore les positions de taille nulle", () => {
    expect(extractPositions([{ address: "0x1", state: state([{ coin: "X", szi: "0", value: "0", liq: null }]) }])).toHaveLength(0);
  });
});

describe("échelle de liquidations", () => {
  const p = (side: "long" | "short", liqPx: number | null, notional = 100): TrackedPosition => ({
    address: "0x",
    coin: "BTC",
    side,
    notional,
    entryPx: 100,
    liqPx,
    leverage: 5,
  });

  it("place un long liquidable à −5 % dans le bon palier", () => {
    const ladder = liquidationLadder([p("long", 95)], 100, 0.3, 0.02);
    const hit = ladder.filter((b) => b.longUsd > 0);
    expect(hit).toHaveLength(1);
    expect(hit[0].fromPct).toBeCloseTo(-0.06, 9);
    expect(hit[0].toPct).toBeCloseTo(-0.04, 9);
  });

  it("sépare longs (sous le prix) et shorts (au-dessus)", () => {
    const ladder = liquidationLadder([p("long", 90, 10), p("short", 112, 20)], 100);
    expect(ladder.reduce((s, b) => s + b.longUsd, 0)).toBe(10);
    expect(ladder.reduce((s, b) => s + b.shortUsd, 0)).toBe(20);
    expect(ladder.find((b) => b.shortUsd > 0)!.fromPct).toBeGreaterThan(0);
  });

  it("ignore les positions sans prix de liquidation ou hors plage", () => {
    const ladder = liquidationLadder([p("long", null), p("long", 10), p("short", 500)], 100);
    expect(ladder.every((b) => b.count === 0)).toBe(true);
  });

  it("couvre exactement la plage demandée", () => {
    const ladder = liquidationLadder([], 100, 0.3, 0.02);
    expect(ladder).toHaveLength(30);
    expect(ladder[0].fromPct).toBeCloseTo(-0.3, 9);
    expect(ladder[29].toPct).toBeCloseTo(0.3, 9);
  });
});

describe("divers", () => {
  it("edge en points de base", () => {
    expect(edgeBp({ pm: 1000, vm: 1_000_000 } as LeaderRow)).toBeCloseTo(10, 9);
    expect(edgeBp({ pm: 1000, vm: 0 } as LeaderRow)).toBeNull();
  });

  it("mapLimit respecte la concurrence et garde l'ordre, échecs compris", async () => {
    let active = 0;
    let peak = 0;
    const out = await mapLimit([1, 2, 3, 4, 5, 6], 2, async (x) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      if (x === 3) throw new Error("boom");
      return x * 10;
    });
    expect(peak).toBeLessThanOrEqual(2);
    expect(out.map((r) => (r.status === "fulfilled" ? r.value : "err"))).toEqual([10, 20, "err", 40, 50, 60]);
  });
});
