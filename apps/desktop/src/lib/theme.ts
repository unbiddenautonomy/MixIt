// Applies the chosen theme ("dark", "light", "system" or "lounge") to the document.
import { useEffect, useState } from "react";
import { useApp } from "../store/app";

export type ResolvedTheme = "dark" | "light" | "lounge";

export function resolveTheme(choice: string | undefined, systemLight: boolean): ResolvedTheme {
  if (choice === "light") return "light";
  if (choice === "lounge") return "lounge";
  if (choice === "system") return systemLight ? "light" : "dark";
  return "dark";
}

/** Keeps `<html data-theme>` in step with the setting and the system; returns the theme. */
export function useTheme(): ResolvedTheme {
  const choice = useApp((s) => s.settings?.theme);
  const [systemLight, setSystemLight] = useState(() => typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: light)").matches);
  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-color-scheme: light)");
    if (!mq) return;
    const on = () => setSystemLight(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  const theme = resolveTheme(choice, systemLight);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  return theme;
}
