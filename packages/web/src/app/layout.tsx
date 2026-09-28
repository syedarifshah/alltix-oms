import { ClerkProvider } from "@clerk/nextjs";
import type { ReactElement, ReactNode } from "react";
import "./globals.css";

/**
 * Root layout for the whole app -- both the public marketing site
 * (app/(marketing)) and the authenticated dashboard (app/(app)). Deliberately
 * has no Nav of its own: the dashboard Nav and the marketing header/footer
 * are different UIs for different audiences, so each route group supplies
 * its own via its own nested layout.tsx.
 *
 * Used to also render a blocking pre-hydration <script> here that set
 * documentElement's [data-theme] from localStorage before first paint, so a
 * user who'd explicitly picked light or dark (components/theme-toggle.tsx)
 * never saw a flash of the wrong one on reload. Removed as part of the
 * gold/plum/cream palette pass (CLAUDE.md §20's own follow-up): the app is
 * now a single fixed look with no toggle and no [data-theme] concept at
 * all, per Arif's own explicit choice, so there's nothing left for a
 * pre-paint script to set.
 */
export default function RootLayout({ children }: { children: ReactNode }): ReactElement {
  return (
    <ClerkProvider>
      <html lang="en">
        <body>{children}</body>
      </html>
    </ClerkProvider>
  );
}
