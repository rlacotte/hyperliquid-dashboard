interface Props {
  text: string;
  /** Côté d'ancrage de la bulle, pour qu'elle ne déborde pas du conteneur. */
  align?: "left" | "center" | "right";
}

/**
 * Explication d'une métrique, au survol ou au focus clavier.
 *
 * Chaque chiffre du dashboard a sa définition à côté de lui : c'est le
 * reproche le plus fréquent fait aux outils existants (panneaux non expliqués),
 * et le moins cher à corriger.
 */
export function InfoTip({ text, align = "center" }: Props) {
  const pos =
    align === "left" ? "left-0" : align === "right" ? "right-0" : "left-1/2 -translate-x-1/2";
  return (
    <span className="group relative inline-flex align-middle">
      <span
        tabIndex={0}
        aria-label={text}
        className="ml-1 cursor-help select-none text-[10px] text-gray-600 outline-none hover:text-gray-300 focus:text-gray-300"
      >
        ⓘ
      </span>
      <span
        role="tooltip"
        // display:none et non visibility:hidden : une bulle invisible occupe
        // quand même sa place et élargit la zone de défilement des tableaux,
        // ce qui ouvrait un vide à droite sur téléphone. Au doigt, toucher ⓘ
        // lui donne le focus et affiche la bulle.
        className={`pointer-events-none absolute top-full z-50 mt-1.5 hidden w-64 max-w-[calc(100vw-2rem)] whitespace-normal rounded-md border border-bg-border bg-bg-base p-2.5 text-left text-xs font-normal normal-case leading-snug tracking-normal text-gray-300 shadow-xl group-focus-within:block group-hover:block ${pos}`}
      >
        {text}
      </span>
    </span>
  );
}
