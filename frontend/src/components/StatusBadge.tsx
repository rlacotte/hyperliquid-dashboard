interface Props {
  /** Horodatage du dernier snapshot collecté (ms), côté serveur. */
  ts: number | undefined;
  /** Erreur de la requête courante, le cas échéant. */
  error: string | null;
}

/**
 * La collecte tourne toutes les 30 s, déclenchée par un cron *externe* à Vercel.
 * Si ce cron meurt, l'API continue de servir le dernier snapshot en base : les
 * requêtes réussissent, seule la donnée vieillit. Un badge basé sur l'état de la
 * requête afficherait donc « Live » sur des prix figés — c'est précisément le
 * mode de panne le plus probable de l'architecture.
 *
 * On qualifie donc la fraîcheur à partir de l'horodatage du snapshot lui-même.
 */
const STALE_AFTER_MS = 120_000; // 4x l'intervalle de collecte : absorbe un cycle raté

function fmtAge(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return h < 24 ? `${h} h` : `${Math.floor(h / 24)} j`;
}

export function StatusBadge({ ts, error }: Props) {
  // Pas encore de donnée : on ne peut rien affirmer sur la fraîcheur.
  if (!ts) {
    const pending = error
      ? { dot: "bg-red-500", label: "Erreur", title: error }
      : { dot: "bg-gray-500", label: "Connexion…", title: undefined };
    return (
      <span className="flex items-center gap-1" title={pending.title}>
        <span className={`h-2 w-2 rounded-full ${pending.dot}`} />
        {pending.label}
      </span>
    );
  }

  const age = Date.now() - ts;
  const stale = age > STALE_AFTER_MS;

  // L'échec de requête prime : la donnée affichée n'est plus rafraîchie du tout.
  if (error) {
    return (
      <span className="flex items-center gap-1 text-red-400" title={error}>
        <span className="h-2 w-2 rounded-full bg-red-500" />
        Erreur · figé depuis {fmtAge(age)}
      </span>
    );
  }

  if (stale) {
    return (
      <span
        className="flex items-center gap-1 text-amber-400"
        title="L'API répond, mais aucun nouveau snapshot n'a été collecté : le cron de collecte est probablement arrêté."
      >
        <span className="h-2 w-2 rounded-full bg-amber-500" />
        Figé depuis {fmtAge(age)}
      </span>
    );
  }

  return (
    <span className="flex items-center gap-1">
      <span className="h-2 w-2 animate-pulse rounded-full bg-green-500" />
      Live
    </span>
  );
}
