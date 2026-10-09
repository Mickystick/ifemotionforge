import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";

interface ErrorBoundaryProps {
  children: ReactNode;
  /**
   * What was on screen when it broke, e.g. "la pantalla de Recibos". Named in
   * the fallback so a clerk can tell someone which part stopped working.
   */
  area?: string;
  /**
   * `"page"` fills the viewport — used once, at the root. `"panel"` is an inline
   * card that sits inside the layout, so a single broken tab does not blank the
   * sidebar and the rest of the app with it.
   */
  variant?: "page" | "panel";
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Catches a render-time exception from anything below it and shows a message
 * with a way out, instead of React unmounting the whole tree and leaving a
 * blank white page.
 *
 * There is one of these at the root and one around each tab's panel. The inner
 * ones mean a bug in, say, the receipt view cannot take the Lotes tab and the
 * navigation down with it — the clerk switches tabs and keeps working.
 *
 * Still a class component: React has no hook for `componentDidCatch`.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Nothing ships errors anywhere yet; the console is where a developer will
    // look, and it keeps the stack and the component trace together.
    console.error("Render error caught by boundary:", error, info.componentStack);
  }

  private reset = () => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    const { error } = this.state;
    const { children, area, variant = "panel" } = this.props;

    if (!error) {
      return children;
    }

    const where = area ? ` in ${area}` : "";

    return (
      <div className={variant === "page" ? "error-boundary error-boundary-page" : "error-boundary"}>
        <div className="card error-boundary-card">
          <h2>Something went wrong{where}</h2>
          <p className="state-message">
            An unexpected error prevented this part of the app from loading. The rest is still
            working; if the problem continues, contact support.
          </p>
          <p className="error-boundary-detail">{error.message}</p>
          <div className="error-boundary-actions">
            <button type="button" className="btn-secondary" onClick={this.reset}>
              Try again
            </button>
            <button
              type="button"
              className="btn-primary"
              onClick={() => window.location.reload()}
            >
              Reload page
            </button>
          </div>
        </div>
      </div>
    );
  }
}
