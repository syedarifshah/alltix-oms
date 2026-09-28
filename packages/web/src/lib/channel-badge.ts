/**
 * A fixed, consistent color per sales channel wherever a channel name is
 * shown as a small pill (Dashboard, Orders, Channels, Analytics) -- purely
 * a display helper, mirrors order-status.ts's orderStatusBadgeClass()
 * pattern (one function, no component state, safe to call from any Server
 * Component). Channel values are free text in this schema (CLAUDE.md
 * §2.1's channel_listings.channel / §2.3's orders.channel are both plain
 * TEXT, not an enum), so this falls back to a neutral badge for anything
 * unrecognized rather than throwing -- new channels (see CLAUDE.md §4's
 * ordering) get a sensible default look with zero code change required.
 */
export function channelBadgeClass(channel: string): string {
  const key = channel.trim().toLowerCase();
  if (key === "amazon") return "channel-badge channel-badge-amazon";
  if (key === "shopify") return "channel-badge channel-badge-shopify";
  if (key === "walmart") return "channel-badge channel-badge-walmart";
  if (key === "ebay") return "channel-badge channel-badge-ebay";
  if (key === "temu") return "channel-badge channel-badge-temu";
  if (key === "tiktok") return "channel-badge channel-badge-tiktok";
  return "badge";
}

/** Chart stroke/fill color for a channel -- same hue grouping as
 *  channelBadgeClass above (amazon amber, shopify green, walmart blue,
 *  eBay/Temu/TikTok purple), expressed as the --chart-* CSS custom
 *  properties (app/globals.css) rather than a fixed hex so it still tracks
 *  the light/dark theme swap. Used by the hand-rolled SVG charts in
 *  components/charts/*.tsx, which take plain color strings and never
 *  compute their own. */
export function channelChartColor(channel: string): string {
  const key = channel.trim().toLowerCase();
  if (key === "amazon") return "var(--chart-4)";
  if (key === "shopify") return "var(--chart-5)";
  if (key === "walmart") return "var(--chart-3)";
  return "var(--chart-2)";
}

/** Display label for a channel key -- capitalizes everything except the
 *  two channels with their own established multi-word/mixed-case brand
 *  names (eBay, TikTok Shop), matching how CLAUDE.md and every other page
 *  in this app already refers to them in prose. */
export function channelLabel(channel: string): string {
  const key = channel.trim().toLowerCase();
  if (key === "ebay") return "eBay";
  if (key === "tiktok") return "TikTok Shop";
  return key.charAt(0).toUpperCase() + key.slice(1);
}
