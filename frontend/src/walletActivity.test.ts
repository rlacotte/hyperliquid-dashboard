import { describe as suite, expect, it } from "vitest";
import type { Fill } from "./hl/client";
import { ActivityBuilder, describe as describeAction, MAX_SPAN_MS, QUIET_MS, summarize } from "./walletActivity";

const U = "0xabc";

const fill = (over: Partial<Fill>): Fill => ({
  coin: "BTC",
  px: "100",
  sz: "1",
  side: "B",
  time: 1000,
  startPosition: "0",
  dir: "Open Long",
  closedPnl: "0",
  hash: "0xh",
  fee: "0",
  crossed: true,
  ...over,
});

suite("qualification d'une action", () => {
  it("ouverture depuis zéro", () => {
    const a = summarize(U, "BTC", [fill({ sz: "2" }), fill({ sz: "1", startPosition: "2", px: "103" })])!;
    expect(a.kind).toBe("open");
    expect(a.side).toBe("long");
    expect(a.notional).toBe(303);
    expect(a.px).toBeCloseTo(101, 9);
    expect(a.fills).toBe(2);
  });

  it("renforcement d'un short", () => {
    const a = summarize(U, "ETH", [fill({ side: "A", startPosition: "-5", dir: "Open Short" })])!;
    expect(a.kind).toBe("add");
    expect(a.side).toBe("short");
  });

  it("réduction avec PnL réalisé", () => {
    const a = summarize(U, "BTC", [fill({ side: "A", startPosition: "3", dir: "Close Long", closedPnl: "42.5" })])!;
    expect(a.kind).toBe("reduce");
    expect(a.side).toBe("long");
    expect(a.pnl).toBe(42.5);
  });

  it("clôture complète en plusieurs fills", () => {
    const a = summarize(U, "BTC", [
      fill({ side: "A", sz: "1.5", startPosition: "2", dir: "Close Long" }),
      fill({ side: "A", sz: "0.5", startPosition: "0.5", dir: "Close Long", time: 1001 }),
    ])!;
    expect(a.kind).toBe("close");
    expect(a.side).toBe("long");
  });

  it("bascule long → short : le côté retenu est le nouveau", () => {
    const a = summarize(U, "BTC", [fill({ side: "A", sz: "3", startPosition: "1", dir: "Long > Short" })])!;
    expect(a.kind).toBe("flip");
    expect(a.side).toBe("short");
  });

  it("une liquidation prime sur tout le reste", () => {
    const a = summarize(U, "BTC", [
      fill({ side: "A", startPosition: "1", dir: "Close Long", liquidation: { markPx: "90", method: "market" } }),
    ])!;
    expect(a.kind).toBe("liquidation");
    expect(a.side).toBe("long");
  });

  it("l'ordre d'arrivée des fills ne change pas la position de départ", () => {
    const a = summarize(U, "BTC", [fill({ startPosition: "1", time: 2000 }), fill({ startPosition: "0", time: 1000 })])!;
    expect(a.kind).toBe("open");
  });
});

suite("regroupement", () => {
  it("rassemble les fills d'un même marché tant qu'ils se suivent", () => {
    const b = new ActivityBuilder();
    b.add(U, [fill({})], 0);
    b.add(U, [fill({ startPosition: "1" })], 2_000);
    expect(b.flush(2_500)).toEqual([]); // encore actif
    const [a] = b.flush(2_000 + QUIET_MS);
    expect(a.fills).toBe(2);
  });

  it("deux marchés donnent deux actions", () => {
    const b = new ActivityBuilder();
    b.add(U, [fill({ coin: "BTC" }), fill({ coin: "ETH" })], 0);
    expect(b.flush(QUIET_MS)).toHaveLength(2);
  });

  it("un flux continu est coupé au bout de MAX_SPAN_MS", () => {
    const b = new ActivityBuilder();
    for (let t = 0; t <= MAX_SPAN_MS; t += 1_000) b.add(U, [fill({ time: t })], t);
    expect(b.flush(MAX_SPAN_MS)).toHaveLength(1);
  });

  it("l'adresse est normalisée en minuscules", () => {
    const b = new ActivityBuilder();
    b.add("0xABC", [fill({})], 0);
    expect(b.flush(QUIET_MS)[0].user).toBe("0xabc");
  });
});

suite("texte", () => {
  const usd = (v: number) => `$${v}`;
  it("libellé du marché HIP-3 sans préfixe de DEX", () => {
    const a = summarize(U, "xyz:TSLA", [fill({ coin: "xyz:TSLA" })])!;
    expect(describeAction(a, "Baleine", usd).title).toBe("Baleine ouvre un LONG TSLA");
  });
  it("le PnL réalisé n'apparaît que lorsqu'il a un sens", () => {
    const close = summarize(U, "BTC", [fill({ side: "A", startPosition: "1", closedPnl: "-7" })])!;
    expect(describeAction(close, "x", usd).body).toContain("PnL réalisé -$7");
    const open = summarize(U, "BTC", [fill({})])!;
    expect(describeAction(open, "x", usd).body).not.toContain("PnL");
  });
});
