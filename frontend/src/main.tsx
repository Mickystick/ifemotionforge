import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { registerServiceWorker } from "./lib/serviceWorker";
import "./styles.css";

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Could not find the #root element in index.html.");
}

/*
 * Before rendering, and deliberately not awaited: registration is fire-and-
 * forget, defers its own work to the `load` event, and nothing on screen
 * depends on whether it succeeds. See lib/serviceWorker.ts.
 */
registerServiceWorker();

createRoot(rootElement).render(
  <StrictMode>
    {/* The outermost net: if a render error escapes every panel-level boundary,
        this shows a full-page message with a reload instead of a blank tab. */}
    <ErrorBoundary variant="page">
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
