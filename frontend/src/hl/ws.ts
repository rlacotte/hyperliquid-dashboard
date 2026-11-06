/**
 * Connexion websocket unique vers Hyperliquid, partagée par toute l'app.
 *
 * Pourquoi un gestionnaire plutôt qu'un `new WebSocket` par composant :
 * - Hyperliquid limite le nombre de connexions par IP ; dix composants qui
 *   ouvrent chacun la leur atteindraient vite le plafond ;
 * - deux composants qui veulent les trades BTC doivent partager UN abonnement :
 *   compteur de références, le canal n'est libéré qu'au départ du dernier ;
 * - la reconnexion (réseau, onglet en veille, coupure serveur) doit
 *   ré-abonner tout ce qui est encore actif, sans que chaque composant gère
 *   ce cas.
 *
 * Protocole (vérifié en direct) :
 *   → {"method":"subscribe","subscription":{...}}   ← {"channel":"subscriptionResponse"}
 *   ← {"channel":"trades","data":[{coin,...}]}       ← {"channel":"allMids","data":{dex?,mids}}
 *   ← {"channel":"l2Book"|"bbo"|"activeAssetCtx","data":{coin,...}}
 *   → {"method":"ping"}                              ← {"channel":"pong"}  (sans data)
 */

const WS_URL = "wss://api.hyperliquid.xyz/ws";
const PING_EVERY_MS = 20_000;
// Sans aucun message (pong compris) pendant ce délai, la connexion est
// considérée morte même si le navigateur ne l'a pas signalée — cas typique
// d'un onglet réveillé après une mise en veille.
const SILENCE_TIMEOUT_MS = 60_000;
const MAX_BACKOFF_MS = 30_000;

export type Subscription =
  | { type: "allMids"; dex?: string }
  | { type: "trades"; coin: string }
  | { type: "l2Book"; coin: string }
  | { type: "bbo"; coin: string }
  | { type: "activeAssetCtx"; coin: string }
  | { type: "candle"; coin: string; interval: string };

export type WsStatus = "idle" | "connecting" | "open" | "reconnecting";

type Handler = (data: any) => void; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Clé de routage d'un abonnement — doit correspondre à celle d'un message. */
export function subscriptionKey(sub: Subscription): string {
  switch (sub.type) {
    case "allMids":
      return `allMids|${sub.dex ?? ""}`;
    case "candle":
      return `candle|${sub.coin}|${sub.interval}`;
    default:
      return `${sub.type}|${sub.coin}`;
  }
}

/** Clé de routage d'un message entrant, ou null s'il n'est destiné à personne. */
export function messageKey(channel: string, data: any): string | null { // eslint-disable-line @typescript-eslint/no-explicit-any
  switch (channel) {
    case "allMids":
      return `allMids|${data?.dex ?? ""}`;
    case "trades":
      return Array.isArray(data) && data.length > 0 ? `trades|${data[0].coin}` : null;
    case "candle":
      return data?.s ? `candle|${data.s}|${data.i}` : null;
    case "l2Book":
    case "bbo":
    case "activeAssetCtx":
      return data?.coin ? `${channel}|${data.coin}` : null;
    default:
      return null; // subscriptionResponse, pong, error...
  }
}

class WsManager {
  private ws: WebSocket | null = null;
  private subs = new Map<string, { sub: Subscription; handlers: Set<Handler> }>();
  private status: WsStatus = "idle";
  private statusListeners = new Set<(s: WsStatus) => void>();
  private attempt = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private lastMessageAt = 0;

  subscribe(sub: Subscription, handler: Handler): () => void {
    const key = subscriptionKey(sub);
    let entry = this.subs.get(key);
    if (!entry) {
      entry = { sub, handlers: new Set() };
      this.subs.set(key, entry);
      // Si la socket n'est pas encore ouverte, l'envoi est ignoré : onopen
      // ré-abonne tout ce qui est dans `subs`.
      this.send({ method: "subscribe", subscription: sub });
    }
    entry.handlers.add(handler);
    this.ensureConnected();

    return () => {
      const current = this.subs.get(key);
      if (!current) return;
      current.handlers.delete(handler);
      if (current.handlers.size === 0) {
        this.subs.delete(key);
        this.send({ method: "unsubscribe", subscription: current.sub });
      }
    };
  }

  getStatus(): WsStatus {
    return this.status;
  }

  onStatus(listener: (s: WsStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  private setStatus(s: WsStatus) {
    if (s === this.status) return;
    this.status = s;
    this.statusListeners.forEach((l) => l(s));
  }

  private send(msg: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private ensureConnected() {
    if (this.ws || this.reconnectTimer) return;
    this.connect();
  }

  private connect() {
    this.reconnectTimer = null;
    this.setStatus(this.attempt === 0 ? "connecting" : "reconnecting");
    const ws = new WebSocket(WS_URL);
    this.ws = ws;

    ws.onopen = () => {
      this.attempt = 0;
      this.lastMessageAt = Date.now();
      this.setStatus("open");
      for (const { sub } of this.subs.values()) {
        ws.send(JSON.stringify({ method: "subscribe", subscription: sub }));
      }
      this.startPing();
    };

    ws.onmessage = (event) => {
      this.lastMessageAt = Date.now();
      let msg: { channel: string; data?: unknown };
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      const key = messageKey(msg.channel, msg.data);
      if (!key) return;
      const entry = this.subs.get(key);
      if (!entry) return;
      for (const h of entry.handlers) {
        try {
          h(msg.data);
        } catch (err) {
          // Un composant défaillant ne doit pas priver les autres du message.
          console.error("[ws] handler en erreur", key, err);
        }
      }
    };

    ws.onclose = () => {
      this.stopPing();
      if (this.ws === ws) this.ws = null;
      if (this.subs.size > 0) this.scheduleReconnect();
      else this.setStatus("idle");
    };

    ws.onerror = () => ws.close();
  }

  private scheduleReconnect() {
    this.setStatus("reconnecting");
    // Backoff exponentiel plafonné + gigue : après une coupure serveur, tous
    // les clients ne doivent pas revenir à la même milliseconde.
    const base = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** this.attempt);
    const delay = base / 2 + Math.random() * (base / 2);
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private startPing() {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (Date.now() - this.lastMessageAt > SILENCE_TIMEOUT_MS) {
        this.ws?.close(); // déclenche onclose → reconnexion
        return;
      }
      this.send({ method: "ping" });
    }, PING_EVERY_MS);
  }

  private stopPing() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }
}

export const wsManager = new WsManager();
