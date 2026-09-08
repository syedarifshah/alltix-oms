import type { ReactElement, ReactNode } from "react";
import { MarketingHeader } from "@/components/marketing/marketing-header";
import { MarketingFooter } from "@/components/marketing/marketing-footer";
import styles from "./marketing.module.css";

/**
 * Public marketing site: Home (/), Why AlltixOMS, Pricing, Book a Demo.
 * This is now the public root of alltixoms.com (see src/proxy.ts's
 * isPublicRoute, which used to gate "/" behind Clerk -- that's what made a
 * signed-out visit to www.alltixoms.com land straight on the sign-in wall).
 * The dashboard (orders/inventory/etc.) lives at app/(app) with its own
 * layout+Nav; visitors reach it via the "Login" tab in MarketingHeader ->
 * /sign-in -> Clerk -> /orders.
 *
 * `styles.mkt` (see marketing.module.css) is the only place this site's
 * colors/fonts/etc. are defined -- everything under it uses the original
 * plain class names from Arif's supplied HTML unchanged.
 */
export default function MarketingLayout({ children }: { children: ReactNode }): ReactElement {
  return (
    <div className={styles.mkt}>
      <MarketingHeader />
      {children}
      <MarketingFooter />
    </div>
  );
}
