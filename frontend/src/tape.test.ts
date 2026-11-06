import { describe, expect, it } from "vitest";
import type { Trade } from "./hl/client";
import { groupKey, makerOf, NetFlow, OrderBuilder, takerOf } from "./tape";

const NULL = "0x" + "0".repeat(64);
const BUYER = "0xb000000000000000000000000000000000000000";
const SELLER = "0xc000000000000000000000000000000000000000";

const trade = (over: Partial<Trade>): Trade => ({
  coin: "BTC",
  side: "B",
  px: "100",
  sz: "1",
  time: 1000,
  hash: "0xabc",
  tid: Math.random(),
  users: [BUYER, SELLER],
  ...over,
});

describe("taker / maker", () => {
  it("side B : l'acheteur est l'initiateur", () => {
    const t = trade({ side: "B" });
    expect(takerOf(t)).toBe(BUYER);
    expect(makerOf(t)).toBe(SELLER);
  });
  it("side A : le vendeur est l'initiateur", () => {
    const t = trade({ side: "A" });
    expect(takerOf(t)).toBe(SELLER);
    expect(makerOf(t)).toBe(BUYER);
  });
});

describe("regroupement en ordres", () => {
  it("fusionne les fills d'une même transaction, avec un VWAP juste", () => {
    const b = new OrderBuilder();
    const [o] = b.add([
      trade({ px: "100", sz: "1", users: [BUYER, "0x1"] }),
      trade({ px: "101", sz: "3", users: [BUYER, "0x2"] }),
    ]);
    expect(o.fills).toBe(2);
    expect(o.size).toBe(4);
    expect(o.notional).toBe(403);
    expect(o.vwap).toBeCloseTo(100.75, 9);
    expect(o.makers.size).toBe(2);
  });

  it("le piège du hash nul : ne fusionne PAS des takers différents", () => {
    // 79 fills à hash nul fusionnés à tort en un faux méga-ordre : bug évité.
    const b = new OrderBuilder();
    const touched = b.add([
      trade({ hash: NULL, users: ["0xaaa", SELLER] }),
      trade({ hash: NULL, users: ["0xbbb", SELLER] }),
      trade({ hash: NULL, users: ["0xaaa", SELLER], time: 2000 }),
    ]);
    expect(touched).toHaveLength(3);
  });

  it("hash nul, même taker, même instant : un seul ordre", () => {
    const b = new OrderBuilder();
    expect(b.add([trade({ hash: NULL }), trade({ hash: NULL })])).toHaveLength(1);
  });

  it("deux messages successifs complètent le même ordre", () => {
    const b = new OrderBuilder();
    b.add([trade({ sz: "1" })]);
    const [o] = b.add([trade({ sz: "2" })]);
    expect(o.size).toBe(3);
    expect(o.fills).toBe(2);
  });

  it("le même hash sur deux coins reste deux ordres", () => {
    expect(groupKey(trade({ coin: "BTC" }))).not.toBe(groupKey(trade({ coin: "ETH" })));
  });

  it("purge les ordres anciens", () => {
    const b = new OrderBuilder();
    b.add([trade({ time: 0 })]);
    b.prune(120_000);
    // Purgé : le même hash recrée un ordre neuf.
    const [o] = b.add([trade({ time: 120_000 })]);
    expect(o.fills).toBe(1);
  });
});

describe("flux net", () => {
  it("achats moins ventes, sur la fenêtre", () => {
    const f = new NetFlow(60_000);
    f.add([trade({ side: "B", px: "100", sz: "5", time: 0 }), trade({ side: "A", px: "100", sz: "2", time: 1000 })]);
    const [s] = f.snapshot(2000);
    expect(s.net).toBe(300);
    expect(s.gross).toBe(700);
  });

  it("oublie ce qui sort de la fenêtre", () => {
    const f = new NetFlow(60_000);
    f.add([trade({ side: "B", time: 0 }), trade({ side: "B", time: 50_000 })]);
    expect(f.snapshot(70_000)[0].net).toBe(100);
    expect(f.snapshot(200_000)).toHaveLength(0);
  });
});
