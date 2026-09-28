import { redirect } from "next/navigation";

/**
 * /settings/channels moved to the top-level /channels route as part of the
 * v1 visual redesign (matching the reference design's own top-level
 * "Channels" nav item -- see components/nav.tsx and (app)/channels/page.tsx,
 * which now has every query/form this route used to). This stub exists so
 * any bookmark, saved link, or external reference to the old path still
 * lands somewhere real instead of 404ing -- redirect() forwards any
 * querystring searchParams too (connected=/error=/webhooks= are all read by
 * the new page the same way).
 *
 * /settings/channels/tiktok-shops (a separate route) is untouched by this
 * move -- it's its own page, not something this file rendered.
 */
export default async function SettingsChannelsRedirect({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<never> {
  const resolvedParams = await searchParams;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(resolvedParams)) {
    if (typeof value === "string") params.set(key, value);
    else if (Array.isArray(value)) value.forEach((v) => params.append(key, v));
  }
  const query = params.toString();
  redirect(query ? `/channels?${query}` : "/channels");
}
