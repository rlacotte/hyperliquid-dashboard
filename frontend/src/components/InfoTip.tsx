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
        className={`pointer-events-none invisible absolute top-full z-50 mt-1.5 w-64 rounded-md border border-bg-border bg-bg-base p-2.5 text-left text-xs font-normal normal-case leading-snug tracking-normal text-gray-300 opacity-0 shadow-xl transition-opacity group-focus-within:visible group-focus-within:opacity-100 group-hover:visible group-hover:opacity-100 ${pos}`}
      >
        {text}
      </span>
    </span>
  );
}
