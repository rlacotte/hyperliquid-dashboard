import { describe, expect, it } from "vitest";
import { alertSign, binomialZ, MIN_SAMPLE, signalLabel, verdict } from "./signals";

describe("sens d'une alerte (miroir du backend)", () => {
  it("prix et OI : signe de la variation", () => {
    expect(alertSign({ criterion: "price_change", details: { delta_pct: -0.05 }, direction: null })).toBe(-1);
    expect(alertSign({ criterion: "open_interest", details: { delta_pct: 0.13 }, direction: null })).toBe(1);
  });
  it("funding : signe du taux", () => {
    expect(alertSign({ criterion: "funding_rate", details: { funding: -0.0013 }, direction: null })).toBe(-1);
  });
  it("confluence : direction du régime", () => {
    expect(alertSign({ criterion: "confluence", details: {}, direction: "bearish" })).toBe(-1);
  });
  it("volume : sans sens", () => {
    expect(alertSign({ criterion: "volume", details: { multiple: 4 }, direction: null })).toBe(0);
  });
  it("détail manquant : sans sens plutôt qu'un faux signe", () => {
    expect(alertSign({ criterion: "price_change", details: {}, direction: null })).toBe(0);
  });
});

describe("verdict", () => {
  it("rien à dire sous l'effectif minimal, même avec un écart énorme", () => {
    const v = verdict({ n: 10, n_vs_btc: MIN_SAMPLE - 1, p_beat_btc: 0.95, mean_vs_btc: 0.05 });
    expect(v.tone).toBe("unknown");
    expect(v.significant).toBe(false);
  });

  it("55 % sur 100 cas n'est PAS significatif (z = 1)", () => {
    expect(binomialZ(0.55, 100)).toBeCloseTo(1, 9);
    expect(verdict({ n: 100, n_vs_btc: 100, p_beat_btc: 0.55, mean_vs_btc: 0.002 }).tone).toBe("neutral");
  });

  it("60 % sur 400 cas est significatif (z = 4)", () => {
    const v = verdict({ n: 400, n_vs_btc: 400, p_beat_btc: 0.6, mean_vs_btc: 0.004 });
    expect(v.significant).toBe(true);
    expect(v.tone).toBe("positive");
    expect(v.text).toContain("+0.40 %");
  });

  it("sous-performance significative", () => {
    const v = verdict({ n: 400, n_vs_btc: 400, p_beat_btc: 0.38, mean_vs_btc: -0.006 });
    expect(v.tone).toBe("negative");
    expect(v.text).toContain("-0.60 %");
  });

  it("pas de comparaison possible (alertes BTC uniquement)", () => {
    expect(verdict({ n: 50, n_vs_btc: 0, p_beat_btc: null, mean_vs_btc: null }).tone).toBe("unknown");
  });
});

describe("libellés", () => {
  it("un libellé lisible par type et sens", () => {
    expect(signalLabel("funding_rate", 1)).toContain("longs paient");
    expect(signalLabel("volume", 0)).toBe("Pic de volume anormal");
  });
});
