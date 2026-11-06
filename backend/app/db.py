"""Base Postgres : snapshots marché historiques + alertes + état partagé.

On stocke des snapshots périodiques pour calculer les variations dans le temps
(pic d'OI, volume anormal) que l'API Hyperliquid ne donne pas directement.

Contexte serverless (Vercel) : chaque requête HTTP peut tomber sur une instance
fraîche. La base est donc la SEULE mémoire partagée entre le cron de collecte et
les requêtes API — d'où la table `kv` (dernier snapshot marché, scores de
confluence, horodatage de maintenance) qui remplace les caches en mémoire.

Contrainte de perf : chaque requête part sur le réseau (~10-40 ms). Les lectures
d'historique sont donc groupées en quelques requêtes globales (cf. HistoryContext)
plutôt qu'une poignée de requêtes par coin.
"""
from __future__ import annotations

import threading
import time
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Any, Generator, Iterable

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from . import config

_local = threading.local()


def _get_conn() -> psycopg.Connection:
    conn = getattr(_local, "conn", None)
    if conn is not None and not conn.closed:
        return conn
    conn = psycopg.connect(
        config.DATABASE_URL,
        row_factory=dict_row,
        autocommit=False,
        connect_timeout=10,
    )
    _local.conn = conn
    return conn


@contextmanager
def get_conn() -> Generator[psycopg.Connection, None, None]:
    conn = _get_conn()
    try:
        yield conn
        conn.commit()
    except Exception:
        try:
            conn.rollback()
        except Exception:
            # Connexion morte (cold start / pooler qui a coupé) : on la jette
            # pour que la prochaine tentative en rouvre une propre.
            try:
                conn.close()
            finally:
                _local.conn = None
        raise


def init_db() -> None:
    """Crée le schéma si absent. Idempotent — appelé au démarrage et par le cron."""
    with get_conn() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS snapshots (
                id BIGSERIAL PRIMARY KEY,
                coin TEXT NOT NULL,
                ts BIGINT NOT NULL,
                mark_px DOUBLE PRECISION NOT NULL,
                funding DOUBLE PRECISION NOT NULL,
                open_interest DOUBLE PRECISION NOT NULL,
                day_ntl_vlm DOUBLE PRECISION NOT NULL
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_snap_coin_ts ON snapshots(coin, ts)")
        # Le downsampling et les purges balayent par ts sans filtre de coin.
        conn.execute("CREATE INDEX IF NOT EXISTS idx_snap_ts ON snapshots(ts)")

        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS alerts (
                id BIGSERIAL PRIMARY KEY,
                coin TEXT NOT NULL,
                ts BIGINT NOT NULL,
                criterion TEXT NOT NULL,
                severity TEXT NOT NULL,
                message TEXT NOT NULL,
                details JSONB NOT NULL DEFAULT '{}'::jsonb,
                acknowledged INTEGER NOT NULL DEFAULT 0,
                resolved_ts BIGINT,
                active INTEGER NOT NULL DEFAULT 1,
                score DOUBLE PRECISION,
                direction TEXT
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_alerts_ts ON alerts(ts)")
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_alerts_coin_crit ON alerts(coin, criterion, active, ts)"
        )
        # Au plus UNE alerte active par (coin, criterion) — la contrainte
        # anti-spam du moteur d'alertes, imposée en base plutôt qu'en Python :
        # deux invocations cron concurrentes ne peuvent plus doubler l'alerte.
        conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_alerts_active_uniq "
            "ON alerts(coin, criterion) WHERE active = 1"
        )

        # Bases créées avant l'ajout de ces colonnes
        for ddl in (
            "ALTER TABLE alerts ADD COLUMN IF NOT EXISTS resolved_ts BIGINT",
            "ALTER TABLE alerts ADD COLUMN IF NOT EXISTS active INTEGER NOT NULL DEFAULT 1",
            "ALTER TABLE alerts ADD COLUMN IF NOT EXISTS score DOUBLE PRECISION",
            "ALTER TABLE alerts ADD COLUMN IF NOT EXISTS direction TEXT",
        ):
            conn.execute(ddl)

        # État partagé entre invocations serverless (ex-caches mémoire)
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS kv (
                key TEXT PRIMARY KEY,
                ts BIGINT NOT NULL,
                value JSONB NOT NULL
            )
            """
        )

        # Historique des métriques globales pour sparklines
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS global_metrics_history (
                id BIGSERIAL PRIMARY KEY,
                ts BIGINT NOT NULL,
                metric TEXT NOT NULL,
                value DOUBLE PRECISION NOT NULL
            )
            """
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_gmh_metric_ts ON global_metrics_history(metric, ts)"
        )

        # Photo quotidienne du haut du leaderboard. Sert à mesurer la
        # persistance des performances (un top trader le reste-t-il ?), ce qui
        # exige un historique qu'aucune API ne fournit : on l'accumule.
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS leaderboard_snapshots (
                day DATE NOT NULL,
                address TEXT NOT NULL,
                account_value DOUBLE PRECISION NOT NULL,
                pnl_week DOUBLE PRECISION NOT NULL,
                pnl_month DOUBLE PRECISION NOT NULL,
                pnl_all DOUBLE PRECISION NOT NULL,
                roi_month DOUBLE PRECISION NOT NULL,
                vlm_month DOUBLE PRECISION NOT NULL,
                profile TEXT NOT NULL,
                PRIMARY KEY (day, address)
            )
            """
        )

    _apply_idle_session_timeout()


def _apply_idle_session_timeout() -> None:
    """Fait expirer côté serveur les sessions laissées ouvertes.

    Une fonction serverless est gelée entre deux invocations sans fermer sa
    connexion : sous une pointe de trafic, les connexions abandonnées
    s'accumulent. L'instance est partagée avec d'autres bases de production et
    plafonne à max_connections=100 — les laisser filer pénaliserait les
    voisines. Postgres les récupère donc lui-même après inactivité.

    Best-effort : un rôle sans droit de modifier ses propres options ne doit pas
    faire échouer l'initialisation.
    """
    try:
        with get_conn() as conn:
            conn.execute(
                "ALTER ROLE CURRENT_USER SET idle_session_timeout = '120s'"
            )
    except Exception:
        pass


# --- État partagé (remplace les caches mémoire) ------------------------------
def kv_set(key: str, ts: int, value: Any) -> None:
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO kv (key, ts, value) VALUES (%s, %s, %s) "
            "ON CONFLICT (key) DO UPDATE SET ts = EXCLUDED.ts, value = EXCLUDED.value",
            (key, ts, Jsonb(value)),
        )


def kv_get(key: str) -> tuple[int, Any] | None:
    """Retourne (ts, value) ou None si la clé n'existe pas."""
    with get_conn() as conn:
        row = conn.execute("SELECT ts, value FROM kv WHERE key = %s", (key,)).fetchone()
    if row is None:
        return None
    return row["ts"], row["value"]


# --- Snapshots ---------------------------------------------------------------
def insert_snapshots(rows: Iterable[tuple]) -> None:
    """rows: iterable de (coin, ts, mark_px, funding, open_interest, day_ntl_vlm)"""
    rows = list(rows)
    if not rows:
        return
    with get_conn() as conn:
        with conn.cursor() as cur:
            # COPY plutôt qu'executemany : ~200 lignes par cycle, un seul aller-retour.
            with cur.copy(
                "COPY snapshots (coin, ts, mark_px, funding, open_interest, day_ntl_vlm) FROM STDIN"
            ) as copy:
                for r in rows:
                    copy.write_row(r)


def purge_old_snapshots() -> int:
    cutoff = int(time.time() * 1000) - config.SNAPSHOT_RETENTION_SEC * 1000
    with get_conn() as conn:
        cur = conn.execute("DELETE FROM snapshots WHERE ts < %s", (cutoff,))
        return cur.rowcount


def downsample_snapshots() -> int:
    """Réduit la résolution des snapshots anciens.

    Pour chaque coin, les snapshots plus vieux que DOWNSAMPLE_FULL_RES_SEC sont
    regroupés en buckets de DOWNSAMPLE_BUCKET_SEC. Dans chaque bucket on garde
    un seul point représentatif (le plus proche du centre du bucket), les autres
    sont supprimés.

    Contrairement à la version SQLite (qui rapatriait toutes les lignes anciennes
    en Python pour choisir les représentants), le calcul se fait entièrement côté
    serveur : sur une base distante le transfert dominait le coût.

    Retourne le nombre de lignes supprimées. Sans effet sur les snapshots récents
    (pleine résolution conservée pour les alertes).
    """
    now_ms = int(time.time() * 1000)
    full_res_cutoff = now_ms - config.DOWNSAMPLE_FULL_RES_SEC * 1000
    bucket_ms = config.DOWNSAMPLE_BUCKET_SEC * 1000

    with get_conn() as conn:
        cur = conn.execute(
            """
            WITH ranked AS (
                SELECT
                    id,
                    ROW_NUMBER() OVER (
                        PARTITION BY coin, (ts / %(bucket)s)
                        ORDER BY ABS(ts - ((ts / %(bucket)s) * %(bucket)s + %(half)s)) ASC, id ASC
                    ) AS rn
                FROM snapshots
                WHERE ts < %(cutoff)s
            )
            DELETE FROM snapshots
            WHERE id IN (SELECT id FROM ranked WHERE rn > 1)
            """,
            {"bucket": bucket_ms, "half": bucket_ms // 2, "cutoff": full_res_cutoff},
        )
        return cur.rowcount


def get_db_stats() -> dict:
    """Stats pour monitoring (route /api/db/stats)."""
    now_ms = int(time.time() * 1000)
    full_res_cutoff = now_ms - config.DOWNSAMPLE_FULL_RES_SEC * 1000
    with get_conn() as conn:
        row = conn.execute(
            """
            SELECT
                COUNT(*)                         AS total,
                MIN(ts)                          AS min_ts,
                COUNT(*) FILTER (WHERE ts >= %s) AS full_res,
                COUNT(DISTINCT coin)             AS coins
            FROM snapshots
            """,
            (full_res_cutoff,),
        ).fetchone()
        alerts = conn.execute(
            "SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE active = 1) AS active FROM alerts"
        ).fetchone()
        size = conn.execute("SELECT pg_database_size(current_database()) AS bytes").fetchone()

    total = row["total"] or 0
    full_res = row["full_res"] or 0
    min_ts = row["min_ts"]
    span_h = ((now_ms - min_ts) / 3_600_000) if min_ts else 0
    return {
        "snapshots_total": total,
        "snapshots_full_res": full_res,
        "snapshots_downsampled": total - full_res,
        "oldest_snapshot_age_h": round(span_h, 1),
        "distinct_coins": row["coins"] or 0,
        "alerts_total": alerts["total"] or 0,
        "alerts_active": alerts["active"] or 0,
        "db_size_mb": round((size["bytes"] or 0) / 1024 / 1024, 1),
        "config": {
            "full_res_hours": config.DOWNSAMPLE_FULL_RES_SEC / 3600,
            "bucket_minutes": config.DOWNSAMPLE_BUCKET_SEC / 60,
            "retention_days": config.SNAPSHOT_RETENTION_SEC / 86400,
        },
    }


# --- Lectures d'historique groupées ------------------------------------------
# Le moteur d'alertes et le score de confluence ont besoin, pour CHAQUE coin :
#   - le snapshot le plus proche de (now - OI_LOOKBACK) et de (now - PRICE_LOOKBACK)
#   - le taux de volume sur la fenêtre courte et sur la baseline
# En SQLite locale, 4 requêtes x ~200 coins passaient inaperçues. Sur une base
# distante, ~800 allers-retours coûteraient plusieurs dizaines de secondes — au
# delà du budget d'une fonction serverless. On charge donc tout en 4 requêtes.


@dataclass
class HistoryContext:
    """Historique pré-chargé pour un cycle d'évaluation complet."""

    now_ms: int
    # coin -> snapshot le plus proche de la cible (mark_px, open_interest, ts...)
    oi_prev: dict[str, dict] = field(default_factory=dict)
    price_prev: dict[str, dict] = field(default_factory=dict)
    # coin -> taux de volume en USD/sec (None = historique insuffisant)
    vol_recent: dict[str, float | None] = field(default_factory=dict)
    vol_baseline: dict[str, float | None] = field(default_factory=dict)

    def snapshot_at_oi_lookback(self, coin: str) -> dict | None:
        return self.oi_prev.get(coin)

    def snapshot_at_price_lookback(self, coin: str) -> dict | None:
        return self.price_prev.get(coin)

    def volume_rate(self, coin: str) -> float | None:
        return self.vol_recent.get(coin)

    def avg_volume_rate(self, coin: str) -> float | None:
        return self.vol_baseline.get(coin)


def _nearest_snapshots(
    conn: psycopg.Connection, target_ms: int, tolerance_ms: int
) -> dict[str, dict]:
    """Pour chaque coin, le snapshot dont le ts est le plus proche de target_ms.

    Tolérance 10 min = 2x le bucket de downsampling (5 min), pour garantir de
    toujours trouver un représentant même en zone downsamplée.
    """
    rows = conn.execute(
        """
        SELECT DISTINCT ON (coin) coin, ts, mark_px, funding, open_interest, day_ntl_vlm
        FROM snapshots
        WHERE ts BETWEEN %(lo)s AND %(hi)s
        ORDER BY coin, ABS(ts - %(target)s) ASC
        """,
        {"lo": target_ms - tolerance_ms, "hi": target_ms + tolerance_ms, "target": target_ms},
    ).fetchall()
    return {r["coin"]: r for r in rows}


def _volume_rates(
    conn: psycopg.Connection, since_ms: int, now_ms: int
) -> dict[str, float | None]:
    """Taux d'arrivée du volume (USD/sec) par coin sur la fenêtre.

    On mesure l'évolution du volume cumulé 24h (dayNtlVlm) entre le début et la
    fin de la fenêtre. Ce volume *décroît* naturellement (vieilles transactions
    qui sortent de la fenêtre 24h) ; un *pic d'activité* le fait croître plus
    vite qu'il ne décroît. Le signal utilisable est donc la pente observée.

    None si la fenêtre ne contient qu'un seul point (pas assez d'historique) ;
    une valeur négative signale simplement l'absence de pic.
    """
    rows = conn.execute(
        """
        SELECT
            coin,
            MIN(ts) AS first_ts,
            MAX(ts) AS last_ts,
            (array_agg(day_ntl_vlm ORDER BY ts ASC))[1]  AS first_vlm,
            (array_agg(day_ntl_vlm ORDER BY ts DESC))[1] AS last_vlm
        FROM snapshots
        WHERE ts BETWEEN %s AND %s
        GROUP BY coin
        """,
        (since_ms, now_ms),
    ).fetchall()

    rates: dict[str, float | None] = {}
    for r in rows:
        delta_sec = (r["last_ts"] - r["first_ts"]) / 1000.0
        if delta_sec <= 0:
            rates[r["coin"]] = None
            continue
        rates[r["coin"]] = (r["last_vlm"] - r["first_vlm"]) / delta_sec
    return rates


def load_history_context(now_ms: int | None = None) -> HistoryContext:
    """Charge en 3-4 requêtes tout l'historique nécessaire à un cycle d'évaluation."""
    now_ms = now_ms if now_ms is not None else int(time.time() * 1000)
    tolerance_ms = 10 * 60 * 1000

    oi_target = now_ms - config.OI_LOOKBACK_MIN * 60 * 1000
    price_target = now_ms - config.PRICE_LOOKBACK_MIN * 60 * 1000

    with get_conn() as conn:
        oi_prev = _nearest_snapshots(conn, oi_target, tolerance_ms)
        # Les deux lookbacks sont identiques par défaut (60 min) : on évite
        # alors la seconde requête.
        price_prev = (
            oi_prev
            if price_target == oi_target
            else _nearest_snapshots(conn, price_target, tolerance_ms)
        )
        vol_recent = _volume_rates(conn, now_ms - config.VOLUME_RECENT_MIN * 60 * 1000, now_ms)
        vol_baseline = _volume_rates(
            conn, now_ms - config.VOLUME_BASELINE_MIN * 60 * 1000, now_ms
        )

    return HistoryContext(
        now_ms=now_ms,
        oi_prev=oi_prev,
        price_prev=price_prev,
        vol_recent=vol_recent,
        vol_baseline=vol_baseline,
    )


# --- Alerts ------------------------------------------------------------------
def get_active_alerts_map() -> dict[tuple[str, str], dict]:
    """Toutes les alertes actives, indexées par (coin, criterion).

    Une seule requête en début de cycle remplace un SELECT par couple évalué.
    """
    with get_conn() as conn:
        rows = conn.execute("SELECT * FROM alerts WHERE active = 1").fetchall()
    return {(r["coin"], r["criterion"]): r for r in rows}


def insert_alerts_bulk(rows: list[tuple]) -> int:
    """Insère plusieurs alertes actives en un aller-retour.

    rows: (coin, ts, criterion, severity, message, details_dict, score, direction)
    Un couple (coin, criterion) déjà actif est ignoré silencieusement — garanti
    par l'index unique partiel, donc sûr même si deux crons se chevauchent.
    """
    if not rows:
        return 0
    payload = [
        (coin, ts, crit, sev, msg, Jsonb(details), score, direction)
        for (coin, ts, crit, sev, msg, details, score, direction) in rows
    ]
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.executemany(
                "INSERT INTO alerts "
                "(coin, ts, criterion, severity, message, details, active, score, direction) "
                "VALUES (%s, %s, %s, %s, %s, %s, 1, %s, %s) ON CONFLICT DO NOTHING",
                payload,
            )
            return cur.rowcount


def update_confluence_alerts_bulk(rows: list[tuple]) -> int:
    """Rafraîchit en lot les alertes de confluence actives.

    Contrairement aux alertes classiques (un seuil fixe), le score de confluence
    évolue à chaque cycle — on rafraîchit donc l'alerte existante tant qu'elle
    reste active pour refléter l'amplitude courante.

    rows: (coin, criterion, score, direction, message, severity, details_dict)
    """
    if not rows:
        return 0
    payload = [
        (score, direction, message, severity, Jsonb(details), coin, criterion)
        for (coin, criterion, score, direction, message, severity, details) in rows
    ]
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.executemany(
                "UPDATE alerts SET score = %s, direction = %s, message = %s, "
                "severity = %s, details = %s "
                "WHERE coin = %s AND criterion = %s AND active = 1",
                payload,
            )
            return cur.rowcount


def resolve_alerts_bulk(pairs: list[tuple[str, str]], ts: int) -> int:
    """Résout en une requête toutes les alertes actives des couples donnés."""
    if not pairs:
        return 0
    with get_conn() as conn:
        cur = conn.execute(
            "UPDATE alerts SET active = 0, resolved_ts = %s "
            "WHERE active = 1 AND (coin, criterion) IN "
            "(SELECT unnest(%s::text[]), unnest(%s::text[]))",
            (ts, [p[0] for p in pairs], [p[1] for p in pairs]),
        )
        return cur.rowcount


def get_alerts(limit: int = 100, only_active: bool = True) -> list[dict]:
    with get_conn() as conn:
        q = "SELECT * FROM alerts"
        if only_active:
            q += " WHERE active = 1 AND acknowledged = 0"
        q += " ORDER BY ts DESC LIMIT %s"
        return conn.execute(q, (limit,)).fetchall()


def get_alert(alert_id: int) -> dict | None:
    with get_conn() as conn:
        return conn.execute("SELECT * FROM alerts WHERE id = %s", (alert_id,)).fetchone()


def acknowledge_alert(alert_id: int) -> bool:
    with get_conn() as conn:
        cur = conn.execute(
            "UPDATE alerts SET acknowledged = 1, active = 0 WHERE id = %s", (alert_id,)
        )
        return cur.rowcount > 0


def acknowledge_all() -> int:
    """Acquitte toutes les alertes actives. Retourne le nb affecté."""
    with get_conn() as conn:
        cur = conn.execute("UPDATE alerts SET acknowledged = 1, active = 0 WHERE active = 1")
        return cur.rowcount


def count_active_alerts() -> int:
    with get_conn() as conn:
        return conn.execute("SELECT COUNT(*) AS n FROM alerts WHERE active = 1").fetchone()["n"]


# --- Leaderboard : photos quotidiennes ----------------------------------------
def insert_leaderboard_snapshot(day: str, rows: list[dict]) -> int:
    """Insère la photo du jour (idempotent : une seule photo par jour et adresse).

    rows : lignes distillées (clés compactes, cf. leaderboard.distill).
    """
    if not rows:
        return 0
    payload = [
        (day, r["a"], r["av"], r["pw"], r["pm"], r["pa"], r["rm"], r["vm"], r["pr"])
        for r in rows
    ]
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.executemany(
                "INSERT INTO leaderboard_snapshots "
                "(day, address, account_value, pnl_week, pnl_month, pnl_all, roi_month, vlm_month, profile) "
                "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s) ON CONFLICT DO NOTHING",
                payload,
            )
            return cur.rowcount


def leaderboard_snapshot_days() -> list[str]:
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT DISTINCT day FROM leaderboard_snapshots ORDER BY day"
        ).fetchall()
    return [r["day"].isoformat() for r in rows]


# --- Métriques globales : historique -----------------------------------------
def insert_global_metrics_history(rows: list[tuple[int, str, float]]) -> None:
    """rows: liste de (ts, metric, value)."""
    if not rows:
        return
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.executemany(
                "INSERT INTO global_metrics_history (ts, metric, value) VALUES (%s, %s, %s)",
                rows,
            )


def get_global_metrics_history(metric: str, since_ms: int) -> list[dict]:
    """Retourne l'historique d'une métrique depuis since_ms, trié chronologique."""
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT ts, value FROM global_metrics_history "
            "WHERE metric = %s AND ts >= %s ORDER BY ts ASC",
            (metric, since_ms),
        ).fetchall()
    return [{"ts": r["ts"], "value": r["value"]} for r in rows]


def get_latest_global_metrics(metric: str) -> dict | None:
    """Dernier point d'une métrique (pour calcul du delta)."""
    with get_conn() as conn:
        r = conn.execute(
            "SELECT ts, value FROM global_metrics_history "
            "WHERE metric = %s ORDER BY ts DESC LIMIT 1",
            (metric,),
        ).fetchone()
    if r is None:
        return None
    return {"ts": r["ts"], "value": r["value"]}


def downsample_global_metrics() -> int:
    """Downsample l'historique des métriques globales (même logique que snapshots).

    Renvoie le nombre de lignes supprimées.
    """
    import time as _time

    now_ms = int(_time.time() * 1000)
    full_res_cutoff = now_ms - config.DOWNSAMPLE_FULL_RES_SEC * 1000
    bucket_ms = config.DOWNSAMPLE_BUCKET_SEC * 1000

    with get_conn() as conn:
        rows = conn.execute(
            "SELECT id, ts, metric, value FROM global_metrics_history WHERE ts < %s",
            (full_res_cutoff,),
        ).fetchall()
        if not rows:
            return 0

        # Garde 1 point par (metric, bucket)
        buckets: dict[tuple[str, int], list[tuple[int, int]]] = {}
        for r in rows:
            bucket_start = (r["ts"] // bucket_ms) * bucket_ms
            center = bucket_start + bucket_ms // 2
            key = (r["metric"], bucket_start)
            buckets.setdefault(key, []).append((abs(r["ts"] - center), r["id"]))

        keep_ids = {min(cands, key=lambda x: x[0])[1] for cands in buckets.values()}
        to_delete = [r["id"] for r in rows if r["id"] not in keep_ids]
        if not to_delete:
            return 0

        # Batch delete
        deleted = 0
        BATCH = 500
        for i in range(0, len(to_delete), BATCH):
            chunk = to_delete[i : i + BATCH]
            placeholders = ",".join(["%s"] * len(chunk))
            cur = conn.execute(f"DELETE FROM global_metrics_history WHERE id IN ({placeholders})", chunk)
            deleted += cur.rowcount
        return deleted
