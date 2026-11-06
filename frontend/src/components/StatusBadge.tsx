import { classifyFreshness, fmtAge } from "../freshness";

interface Props {
  /** Horodatage du dernier snapshot collecté (ms), côté serveur. */
  ts: number | undefined;
  /** Erreur de la requête courante, le cas échéant. */
  error: string | null;
}

/**
 * Indicateur compact dans l'en-tête. Le bandeau (StaleBanner) prend le relais
 * pour l'état « down » ; ici on reste discret. La fraîcheur vient de
 * l'horodatage du snapshot, pas de l'état de la requête — cf. freshness.ts.
 */
export function StatusBadge({ ts, error }: Props) {
  const state = classifyFreshness(ts, error);

  if (state === "pending") {
    return (
      <span className="flex items-center gap-1">
        <span className="h-2 w-2 rounded-full bg-gray-500" />
        Connexion…
      </span>
    );
  }

  if (state === "error") {
    const suffix = ts ? ` · figé depuis ${fmtAge(Date.now() - ts)}` : "";
    return (
      <span className="flex items-center gap-1 text-red-400" title={error ?? undefined}>
        <span className="h-2 w-2 rounded-full bg-red-500" />
        Erreur{suffix}
      </span>
    );
  }

  if (state === "lagging" || state === "down") {
    return (
      <span
        className="flex items-center gap-1 text-amber-400"
        title="Aucun nouveau snapshot collecté : le cron de collecte est probablement arrêté."
      >
        <span className="h-2 w-2 rounded-full bg-amber-500" />
        Figé depuis {fmtAge(Date.now() - (ts as number))}
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
