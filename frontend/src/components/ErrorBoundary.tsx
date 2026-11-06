import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  /** Change de valeur → l'erreur est oubliée (ex. changement de page). */
  resetKey?: string;
}

interface State {
  error: Error | null;
}

/**
 * Isole une page : sans barrière, une seule exception de rendu efface TOUTE
 * l'application (écran vide, constaté en développement). Ici l'en-tête, la
 * navigation et les autres pages restent utilisables, et l'erreur est lisible.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[ErrorBoundary]", error, info.componentStack);
  }

  componentDidUpdate(prev: Props) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <div className="max-w-lg rounded-lg border border-red-500/30 bg-red-500/10 p-4 text-sm">
          <p className="font-semibold text-red-200">Cette section a rencontré une erreur.</p>
          <p className="mt-1 break-words font-mono text-xs text-red-300/80">{this.state.error.message}</p>
          <button
            onClick={() => this.setState({ error: null })}
            className="mt-3 rounded-md border border-red-500/40 px-3 py-1 text-xs text-red-200 hover:bg-red-500/20"
          >
            Réessayer
          </button>
        </div>
      </div>
    );
  }
}
