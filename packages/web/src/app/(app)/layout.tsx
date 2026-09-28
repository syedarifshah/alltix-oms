import type { ReactElement, ReactNode } from "react";
import { Nav, TopBarControls } from "@/components/nav";

/**
 * Layout for every authenticated dashboard route (orders, inventory,
 * picklists, rules, settings, sign-in, sign-up). Route groups like `(app)`
 * add no path segment -- these pages still live at /orders, /sign-in, etc.
 * -- they just share this Nav instead of the public marketing site's own
 * header/footer (see src/app/(marketing)/layout.tsx).
 *
 * The v1 visual redesign changed Nav from a single top row into a fixed
 * sidebar (see components/nav.tsx's own doc comment), so this layout now
 * wraps it in the matching .app-shell/.app-main/.topbar structure
 * (app/globals.css's "app shell" section) instead of just rendering Nav
 * above the page content. Every page underneath still renders its own
 * <main className="page"> exactly as before -- this only changes what
 * wraps it, not the pages themselves.
 */
export default function AppLayout({ children }: { children: ReactNode }): ReactElement {
  return (
    <div className="app-shell">
      <Nav />
      <div className="app-main">
        <div className="topbar">
          <div className="topbar-spacer" />
          <TopBarControls />
        </div>
        {children}
      </div>
    </div>
  );
}
