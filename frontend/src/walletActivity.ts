/**
 * Activité des wallets suivis : des fills bruts aux actions lisibles.
 *
 * Le flux `userFills` livre un message par lot de fills. Un seul ordre qui
 * balaie le carnet, ou une série d'ordres d'un teneur de marché, produit des
 * dizaines de fills : notifier chacun serait inutilisable. On regroupe donc
 * par (wallet, marché) les fills arrivés à quelques secondes d'intervalle, puis
 * on qualifie l'action à partir de la position AVANT et APRÈS le groupe.
 */
import { num, type Fill } from "./hl/client";

export type ActionKind = "open" | "add" | "reduce" | "close" | "flip" | "liquidation";

export interface WalletAction {
  key: string;
  user: string;
  coin: string;
  kind: ActionKind;
  /** Côté de la position concernée : après l'action (ouverture, renfort,
   *  bascule) ou avant (réduction, clôture, liquidation). */
  side: "long" | "short";
  notional: number;
  /** Prix moyen pondéré des fills du groupe. */
  px: number;
  /** PnL réalisé par le groupe (clôtures et réductions). */
  pnl: number;
  fills: number;
  /** Heure du premier fill. */
  time: number;
}

/** Un groupe est clos après ce délai sans nouveau fill (heure de réception). */
export const QUIET_MS = 4_000;
/** Un groupe ne s'étend pas au-delà de cette durée, même si les fills continuent. */
export const MAX_SPAN_MS = 30_000;

const EPS = 1e-9;
const sign = (x: number) => (x > EPS ? 1 : x < -EPS ? -1 : 0);

/** Qualifie un groupe de fills d'un même wallet sur un même marché. */
export function summarize(user: string, coin: string, fills: Fill[]): WalletAction | null {
  if (fills.length === 0) return null;
  const sorted = [...fills].sort((a, b) => a.time - b.time);
  const start = num(sorted[0].startPosition);
  let delta = 0;
  let notional = 0;
  let size = 0;
  let pnl = 0;
  let liquidated = false;
  for (const f of sorted) {
    const sz = num(f.sz);
    // Achat (B) : la position augmente ; vente (A) : elle diminue.
    delta += f.side === "B" ? sz : -sz;
    notional += sz * num(f.px);
    size += sz;
    pnl += num(f.closedPnl);
    if (f.liquidation) liquidated = true;
  }
  const end = start + delta;
  // Tolérance relative : un résidu d'arrondi ne doit pas transformer une
  // clôture en « réduction ».
  const closed = Math.abs(end) <= Math.max(EPS, Math.abs(start) * 1e-6);

  let kind: ActionKind;
  if (liquidated) kind = "liquidation";
  else if (sign(start) === 0) kind = "open";
  else if (!closed && sign(end) !== sign(start)) kind = "flip";
  else if (closed) kind = "close";
  else if (Math.abs(end) > Math.abs(start)) kind = "add";
  else kind = "reduce";

  const ref = kind === "open" || kind === "add" || kind === "flip" ? end : start;
  return {
    key: `${user}|${coin}|${sorted[0].time}|${sorted[0].hash}`,
    user,
    coin,
    kind,
    side: ref >= 0 ? "long" : "short",
    notional,
    px: size > 0 ? notional / size : 0,
    pnl,
    fills: sorted.length,
    time: sorted[0].time,
  };
}

interface Group {
  user: string;
  coin: string;
  fills: Fill[];
  firstSeen: number;
  lastSeen: number;
}

/** Accumule les fills reçus et rend les actions une fois leur groupe clos. */
export class ActivityBuilder {
  private groups = new Map<string, Group>();

  add(user: string, fills: Fill[], now: number): void {
    const u = user.toLowerCase();
    for (const f of fills) {
      const key = `${u}|${f.coin}`;
      let g = this.groups.get(key);
      if (!g) this.groups.set(key, (g = { user: u, coin: f.coin, fills: [], firstSeen: now, lastSeen: now }));
      g.fills.push(f);
      g.lastSeen = now;
    }
  }

  flush(now: number): WalletAction[] {
    const out: WalletAction[] = [];
    for (const [key, g] of this.groups) {
      if (now - g.lastSeen >= QUIET_MS || now - g.firstSeen >= MAX_SPAN_MS) {
        const a = summarize(g.user, g.coin, g.fills);
        if (a) out.push(a);
        this.groups.delete(key);
      }
    }
    return out.sort((a, b) => a.time - b.time);
  }
}

const KIND_VERB: Record<ActionKind, string> = {
  open: "ouvre un",
  add: "renforce son",
  reduce: "réduit son",
  close: "clôture son",
  flip: "bascule en",
  liquidation: "est LIQUIDÉ sur son",
};

/** Texte court, réutilisé par la notification système et le fil d'activité. */
export function describe(a: WalletAction, label: string, fmtUsd: (v: number) => string): { title: string; body: string } {
  const market = a.coin.includes(":") ? a.coin.split(":")[1] : a.coin;
  const side = a.side === "long" ? "LONG" : "SHORT";
  const title = `${label} ${KIND_VERB[a.kind]} ${side} ${market}`;
  const parts = [`${fmtUsd(a.notional)}`];
  if (a.kind === "reduce" || a.kind === "close" || a.kind === "liquidation") {
    parts.push(`PnL réalisé ${a.pnl >= 0 ? "+" : "-"}${fmtUsd(Math.abs(a.pnl))}`);
  }
  return { title, body: parts.join(" · ") };
}
