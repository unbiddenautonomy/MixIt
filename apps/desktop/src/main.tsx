import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

// In development, expose the stores and backend so browser tests can drive and check
// the app (seek a deck, read Auto DJ's state). Not included in production builds.
if (import.meta.env.DEV) {
  void Promise.all([import("./backend"), import("./store/app"), import("./store/telemetry"), import("./store/autodj"), import("./lib/transition"), import("./components/arrange/ArrangeParts"), import("./components/arrange/preview"), import("./store/library")]).then(([b, app, tele, autodj, tr, arr, pv, lib]) => {
    (window as unknown as Record<string, unknown>).mixit = { backend: b.backend, useApp: app.useApp, useTelemetry: tele.useTelemetry, useAutoDj: autodj.useAutoDj, useTransition: tr.useTransition, useArrangeUi: arr.useArrangeUi, usePreview: pv.usePreview, useLibrary: lib.useLibrary };
  });
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
