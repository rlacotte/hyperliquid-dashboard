import { classifyFreshness, fmtAge } from "../freshness";

interface Props {
  /** Horodatage du dernier snapshot collecté (ms), côté serveur. */
  ts: number | undefined;
  /** Erreur de la requête courante, le cas échéant. */
  error: string | null;
}

/**
 * Bandeau pleine largeur affiché uniquement quand la donnée visible n'est plus
 * fiable — et seulement dans ce cas, pour ne pas devenir du bruit permanent.
 *
 * Il couvre les deux situations où l'écran ment :
 * - « down » : l'API répond mais plus aucun snapshot n'arrive. Les prix sont
 *   figés sans que rien ne le signale franchement. C'est la panne qui est passée
 *   inaperçue six semaines.
 * - « error » avec une donnée déjà affichée : les requêtes échouent, l'écran
 *   garde donc le dernier état connu, de plus en plus périmé.
 *
 * Les états « lagging » (retard court, normal) et « live » n'affichent rien :
 * seul le badge de l'en-tête bouge.
 */
export function StaleBanner({ ts, error }: Props) {
  const state = classifyFreshness(ts, error);

  if (state !== "down" && !(state === "error" && ts)) return null;

  const age = ts ? fmtAge(Date.now() - ts) : null;

  const isError = state === "error";
  const palette = isError
    ? "border-red-500/40 bg-red-500/15 text-red-200"
    : "border-amber-500/40 bg-amber-500/15 text-amber-200";
  const dot = isError ? "bg-red-500" : "bg-amber-500";

  const title = isError
    ? "Connexion à l'API perdue"
    : "Collecte arrêtée — données figées";

  const detail = isError
    ? "Les requêtes vers l'API échouent : l'écran conserve le dernier état connu, qui se périme."
    : "L'API répond, mais aucun nouveau snapshot n'est collecté. Le cron de collecte (pinger) est probablement arrêté ; les prix et alertes affichés ne sont plus actualisés.";

  return (
    <div
      role="alert"
      className={`flex items-start gap-3 border-b px-6 py-2.5 text-sm ${palette}`}
    >
      <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${dot} animate-pulse`} />
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="font-semibold">{title}</span>
        {age && (
          <span className="opacity-80">
            Dernière donnée il y a <span className="font-semibold">{age}</span>.
          </span>
        )}
        <span className="opacity-80">{detail}</span>
      </div>
    </div>
  );
}
