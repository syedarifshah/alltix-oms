import type { ReactElement, ReactNode } from "react";
import { Nav } from "@/components/nav";

/**
 * Layout for every authenticated dashboard route (orders, inventory,
 * picklists, rules, settings, sign-in, sign-up). Route groups like `(app)`
 * add no path segment -- these pages still live at /orders, /sign-in, etc.
 * -- they just share this Nav instead of the public marketing site's own
 * header/footer (see src/app/(marketing)/layout.tsx). The dashboard Nav
 * used to live in the root layout; it moved here specifically so the new
 * public marketing pages (Home/Why AlltixOMS/Pricing/Book a Demo) don't
 * render it too.
 */
export default function AppLayout({ children }: { children: ReactNode }): ReactElement {
  return (
    <>
      <Nav />
      {children}
    </>
  );
}
