import { redirect } from "next/navigation";

/**
 * /settings itself has no content of its own -- it's the sidebar's landing
 * target for the whole Settings area (see components/nav.tsx), which is
 * really five separate, pre-existing pages (Locations, Billing, Carriers,
 * Payroll, Audit Log) now sharing one tab bar (components/settings-tabs.tsx,
 * task #101). Redirecting to the first tab, rather than rendering a plain
 * "pick one" page here, matches the pattern every other consolidated route
 * in this redesign uses (see the old /settings/channels route's own stub,
 * app/(app)/settings/channels/page.tsx) and means clicking "Settings" in the
 * sidebar always lands somewhere with real content.
 */
export default function SettingsIndexRedirect(): never {
  redirect("/locations");
}
