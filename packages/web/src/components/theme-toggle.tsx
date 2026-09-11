"use client";

import { useEffect, useState, type ReactElement } from "react";

/** localStorage key holding the user's explicit theme choice ("light" or
 *  "dark"). Absent = no explicit choice made yet, follow the OS
 *  (prefers-color-scheme) -- see globals.css's "Theme resolution order"
 *  comment and the inline script in app/layout.tsx, which are the other two
 *  pieces of this same mechanism. */
const STORAGE_KEY = "alltix-theme";

type Theme = "light" | "dark";

function readStoredTheme(): Theme | null {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return stored === "light" || stored === "dark" ? stored : null;
  } catch {
    // Storage can throw (private browsing, disabled storage, etc.) -- treat
    // exactly like "no explicit choice", not an error.
    return null;
  }
}

function systemPrefersDark(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/**
 * Dashboard-only light/dark toggle (see nav.tsx). Deliberately absent from
 * the marketing site (components/marketing/*), which per its own design is
 * fixed-dark -- see marketing.module.css's header comment.
 *
 * Renders nothing until mounted (returns null on the server and on first
 * client render) so it never has to guess the right label before it can
 * actually read localStorage/matchMedia -- both are unavailable during SSR.
 * This does NOT cause the dashboard's own background flash: that's
 * prevented separately by the blocking inline script in app/layout.tsx,
 * which sets documentElement's [data-theme] before first paint. This
 * component only needs to catch up on which label to show.
 */
export function ThemeToggle(): ReactElement | null {
  const [theme, setTheme] = useState<Theme | null>(null);

  useEffect(() => {
    setTheme(readStoredTheme() ?? (systemPrefersDark() ? "dark" : "light"));
  }, []);

  if (theme === null) {
    return null;
  }

  function toggle(): void {
    const next: Theme = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Best-effort persistence -- the toggle still works for this page
      // view even if storage is unavailable, it just won't be remembered.
    }
    setTheme(next);
  }

  return (
    <button type="button" className="secondary theme-toggle" onClick={toggle} aria-label="Toggle color theme">
      {theme === "dark" ? "Light mode" : "Dark mode"}
    </button>
  );
}
