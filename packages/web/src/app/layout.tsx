import { ClerkProvider } from "@clerk/nextjs";
import type { ReactElement, ReactNode } from "react";
import "./globals.css";

/**
 * Sets documentElement's [data-theme] from localStorage BEFORE first paint,
 * so a dashboard user who explicitly picked a theme (see
 * components/theme-toggle.tsx) never sees a flash of the wrong one on
 * reload. Must run synchronously, before React hydrates and before the
 * browser paints -- a useEffect in theme-toggle.tsx is too late for that
 * (it only runs after the initial paint), which is exactly why this is a
 * plain blocking <script> in <head> rather than component logic. No
 * framework API involved (not next/script, not next/head -- see AGENTS.md's
 * warning that this Next.js version's APIs may differ from training data):
 * this is nothing more than a literal <script> tag the root layout renders,
 * identical in every Next.js version.
 *
 * No-op (and no flash) for anyone who's never touched the toggle: absent/
 * invalid localStorage leaves [data-theme] unset, and globals.css's
 * unguarded @media (prefers-color-scheme: dark) block already handles that
 * case on its own.
 */
const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem("alltix-theme");if(t==="light"||t==="dark"){document.documentElement.dataset.theme=t;}}catch(e){}})();`;

/**
 * Root layout for the whole app -- both the public marketing site
 * (app/(marketing)) and the authenticated dashboard (app/(app)). Deliberately
 * has no Nav of its own: the dashboard Nav and the marketing header/footer
 * are different UIs for different audiences, so each route group supplies
 * its own via its own nested layout.tsx.
 */
export default function RootLayout({ children }: { children: ReactNode }): ReactElement {
  return (
    <ClerkProvider>
      <html lang="en">
        <head>
          {/* eslint-disable-next-line @next/next/no-sync-scripts -- must run
              synchronously before paint, see THEME_INIT_SCRIPT's own comment. */}
          <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        </head>
        <body>{children}</body>
      </html>
    </ClerkProvider>
  );
}
