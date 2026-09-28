import type { ReactElement } from "react";

/**
 * Shared tab bar for the /settings area (task #101, the v1 visual redesign's
 * "Settings shell"). Consolidates five existing, previously-scattered pages
 * under one consistent set of tabs -- Locations, Billing, Carriers, Payroll,
 * Audit Log -- without moving any of them: every route below is exactly
 * where it always was (/locations, /settings/billing, /settings/carriers,
 * /settings/payroll, /settings/activity), this component just renders the
 * same tab strip at the top of each so navigating between them feels like
 * one "Settings" area instead of five unrelated pages.
 *
 * Deliberately does NOT include a "Tenant" or "Webhooks" tab the way the
 * reference design's own Settings section does -- this app has no dedicated
 * tenant-profile page (the one tenant-level setting, reorder_threshold_days,
 * is edited on /inventory, not here) and no standalone webhook-management
 * feature (Shopify's webhook secret is entered on /channels' own connect
 * form, and the Sapient tracking webhook is documented on /settings/carriers
 * -- see CLAUDE.md §4.5/§19.9). Adding tabs for pages that don't exist would
 * be a new feature, not a restyle, so those two are left out; see this
 * component's own call sites for the settled 5-tab set instead.
 *
 * No "current route" highlighting via usePathname() -- same reasoning
 * components/nav.tsx's own SidebarLink already gives (would need a client
 * component or per-page plumbing not worth it for a visual-only pass); each
 * page instead passes its own `active` prop directly, which is already known
 * server-side without any client JS.
 */
const SETTINGS_TABS = [
  { href: "/locations", label: "Locations" },
  { href: "/settings/billing", label: "Billing" },
  { href: "/settings/carriers", label: "Carriers" },
  { href: "/settings/payroll", label: "Payroll" },
  { href: "/settings/activity", label: "Audit Log" },
] as const;

export type SettingsTabHref = (typeof SETTINGS_TABS)[number]["href"];

export function SettingsTabs({ active }: { active: SettingsTabHref }): ReactElement {
  return (
    <div className="tabs" style={{ marginBottom: 20 }}>
      {SETTINGS_TABS.map((tab) => (
        <a key={tab.href} href={tab.href} className={`tab ${tab.href === active ? "active" : ""}`}>
          {tab.label}
        </a>
      ))}
    </div>
  );
}
