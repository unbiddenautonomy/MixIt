import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

// In development, expose the stores and backend so browser tests can drive and check
// the app (seek a deck, read Auto DJ's state). Not included in production builds.
if (import.meta.env.DEV) {
  void Promise.all([import("./backend"), import("./store/app"), import("./store/telemetry"), import("./store/autodj"), import("./lib/transition")]).then(([b, app, tele, autodj, tr]) => {
    (window as unknown as Record<string, unknown>).mixit = { backend: b.backend, useApp: app.useApp, useTelemetry: tele.useTelemetry, useAutoDj: autodj.useAutoDj, useTransition: tr.useTransition };
  });
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
