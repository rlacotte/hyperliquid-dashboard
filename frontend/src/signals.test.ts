import { describe, expect, it } from "vitest";
import { alertSign, binomialZ, MIN_CLUSTERS, signalLabel, twoProportionZ, verdict } from "./signals";

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
  const h = (over: Record<string, number | null>) => ({ n: 500, n_vs_btc: 500, p_beat_btc: 0.5, mean_vs_btc: 0, ...over });

  it("le piège corrigé : beaucoup d'alertes d'un seul coin ne donnent AUCUN verdict", () => {
    // Cas constaté : 85 alertes, 1 coin, « z = 2,9 » si on les croit indépendantes.
    const v = verdict(h({ n_vs_btc: 85, n_clusters: 40, p_beat_btc_clusters: 0.8, mean_vs_btc_clusters: 0.05 }), 1);
    expect(v.tone).toBe("unknown");
    expect(v.text).toContain("non généralisable");
  });

  it("trop peu d'épisodes indépendants, même avec beaucoup d'alertes", () => {
    const v = verdict(h({ n_clusters: MIN_CLUSTERS - 1, p_beat_btc_clusters: 0.9, mean_vs_btc_clusters: 0.03 }), 10);
    expect(v.tone).toBe("unknown");
    expect(v.text).toContain("épisodes");
  });

  it("le test porte sur les grappes, pas sur les alertes brutes", () => {
    // 60 % sur 400 ALERTES serait significatif (z = 4) ; sur 25 grappes, non (z = 1).
    expect(binomialZ(0.6, 25)).toBeCloseTo(1, 9);
    const v = verdict(h({ n_vs_btc: 400, p_beat_btc: 0.6, n_clusters: 25, p_beat_btc_clusters: 0.6, mean_vs_btc_clusters: 0.01 }), 8);
    expect(v.tone).toBe("neutral");
  });

  it("surperformance significative sur assez d'épisodes et de coins", () => {
    const v = verdict(h({ n_clusters: 100, p_beat_btc_clusters: 0.65, mean_vs_btc_clusters: 0.004 }), 12);
    expect(v.significant).toBe(true);
    expect(v.tone).toBe("positive");
    expect(v.text).toContain("+0.40 %");
    expect(v.text).toContain("sans témoin");
  });

  it("sous-performance significative", () => {
    const v = verdict(h({ n_clusters: 100, p_beat_btc_clusters: 0.35, mean_vs_btc_clusters: -0.006 }), 12);
    expect(v.tone).toBe("negative");
    expect(v.text).toContain("-0.60 %");
  });

  it("pas de comparaison possible (alertes BTC uniquement)", () => {
    expect(verdict({ n: 50, n_vs_btc: 0, p_beat_btc: null, mean_vs_btc: null }, 1).tone).toBe("unknown");
  });
});

describe("verdict contre témoin", () => {
  const base = { n: 500, n_vs_btc: 500, p_beat_btc: 0.37, mean_vs_btc: -0.01, n_clusters: 174, p_beat_btc_clusters: 0.37, mean_vs_btc_clusters: -0.01 };

  it("le cas réel : sous-performe le BTC, mais COMME D'HABITUDE pour ces coins", () => {
    // 37 % des épisodes battent le BTC… contre 38 % des jours ordinaires.
    const v = verdict({ ...base, baseline_n: 4000, baseline_p_beat: 0.38, baseline_mean: -0.008 }, 55);
    expect(v.tone).toBe("neutral");
    expect(v.text).toContain("Comme d'habitude");
  });

  it("moins bien que d'habitude quand l'écart au témoin est significatif", () => {
    const v = verdict({ ...base, baseline_n: 4000, baseline_p_beat: 0.5 }, 55);
    expect(v.tone).toBe("negative");
    expect(v.text).toContain("Moins bien que d'habitude");
    expect(v.text).toContain("37 %");
    expect(v.text).toContain("50 %");
  });

  it("sans témoin, le verdict le dit", () => {
    const v = verdict({ ...base }, 55);
    expect(v.text).toContain("sans témoin");
  });

  it("test de deux proportions", () => {
    expect(twoProportionZ(0.5, 100, 0.5, 100)).toBe(0);
    expect(twoProportionZ(0.6, 400, 0.5, 400)).toBeGreaterThan(2);
  });
});

describe("libellés", () => {
  it("un libellé lisible par type et sens", () => {
    expect(signalLabel("funding_rate", 1)).toContain("longs paient");
    expect(signalLabel("volume", 0)).toBe("Pic de volume anormal");
  });
});
