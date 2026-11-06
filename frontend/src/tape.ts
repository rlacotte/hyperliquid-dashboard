/**
 * Reconstitution des ordres à partir du flux de trades, et flux net agressif.
 *
 * Hyperliquid publie un trade PAR FILL : un ordre taker de 2 M$ qui balaie
 * 30 niveaux du carnet arrive en 30 lignes. Afficher les fragments noierait les
 * vrais gros ordres sous des lignes de 60 k$ ; on les regroupe donc.
 *
 * Clé de regroupement (constaté en direct sur 20 s de flux BTC/ETH/SOL/HYPE) :
 * - les fills d'une même transaction partagent un `hash` — 49 groupes sur 50
 *   avaient bien le même taker, le même sens et le même coin ;
 * - MAIS ~20 % des trades ont un hash NUL (0x000…0). Les regrouper par hash
 *   fusionnait 79 fills sans rapport en un faux « méga-ordre ». Pour eux, la clé
 *   devient (coin, sens, taker, milliseconde) : seul le même taker au même
 *   instant est fusionné.
 */
import type { Trade } from "./hl/client";

const NULL_HASH = /^0x0+$/;

/** Sur Hyperliquid, `users` vaut [acheteur, vendeur] ; le taker est l'initiateur. */
export const takerOf = (t: Trade): string => (t.side === "B" ? t.users[0] : t.users[1]);
export const makerOf = (t: Trade): string => (t.side === "B" ? t.users[1] : t.users[0]);

export function groupKey(t: Trade): string {
  return NULL_HASH.test(t.hash) ? `${t.coin}|${t.side}|${takerOf(t)}|${t.time}` : `${t.coin}|${t.hash}`;
}

export interface Order {
  key: string;
  coin: string;
  /** "B" : l'initiateur achète (agresse l'offre). "A" : il vend. */
  side: "A" | "B";
  taker: string;
  makers: Set<string>;
  size: number;
  notional: number;
  /** Prix moyen pondéré par la taille. */
  vwap: number;
  fills: number;
  /** Heure du premier fill. */
  time: number;
}

/**
 * Accumule des trades en ordres. Mutable par conception : appelé à chaque
 * message websocket, recréer la structure serait du travail jeté.
 */
export class OrderBuilder {
  private orders = new Map<string, Order>();

  add(trades: Trade[]): Order[] {
    const touched = new Set<Order>();
    for (const t of trades) {
      const px = parseFloat(t.px);
      const sz = parseFloat(t.sz);
      if (!Number.isFinite(px) || !Number.isFinite(sz)) continue;
      const key = groupKey(t);
      let o = this.orders.get(key);
      if (!o) {
        o = { key, coin: t.coin, side: t.side, taker: takerOf(t), makers: new Set(), size: 0, notional: 0, vwap: 0, fills: 0, time: t.time };
        this.orders.set(key, o);
      }
      o.size += sz;
      o.notional += px * sz;
      o.vwap = o.notional / o.size;
      o.fills += 1;
      o.makers.add(makerOf(t));
      o.time = Math.min(o.time, t.time);
      touched.add(o);
    }
    return [...touched];
  }

  /** Oublie les ordres plus vieux que `maxAgeMs` : un ordre est complet en quelques ms. */
  prune(now: number, maxAgeMs = 60_000) {
    for (const [k, o] of this.orders) if (now - o.time > maxAgeMs) this.orders.delete(k);
  }
}

/**
 * Flux net agressif par coin sur une fenêtre glissante : volume initié à
 * l'achat moins volume initié à la vente. Un flux net très positif signifie que
 * les acheteurs paient le spread pour entrer — une pression que le prix seul ne
 * montre pas encore.
 */
export class NetFlow {
  private buckets = new Map<string, { t: number; v: number }[]>();

  constructor(private windowMs: number) {}

  add(trades: Trade[]) {
    for (const t of trades) {
      const v = parseFloat(t.px) * parseFloat(t.sz) * (t.side === "B" ? 1 : -1);
      if (!Number.isFinite(v)) continue;
      let list = this.buckets.get(t.coin);
      if (!list) this.buckets.set(t.coin, (list = []));
      list.push({ t: t.time, v });
    }
  }

  snapshot(now: number): { coin: string; net: number; gross: number }[] {
    const out: { coin: string; net: number; gross: number }[] = [];
    for (const [coin, list] of this.buckets) {
      // Les trades arrivent dans l'ordre : on purge par la tête.
      let i = 0;
      while (i < list.length && now - list[i].t > this.windowMs) i++;
      if (i > 0) list.splice(0, i);
      if (list.length === 0) {
        this.buckets.delete(coin);
        continue;
      }
      let net = 0;
      let gross = 0;
      for (const p of list) {
        net += p.v;
        gross += Math.abs(p.v);
      }
      out.push({ coin, net, gross });
    }
    return out;
  }
}
