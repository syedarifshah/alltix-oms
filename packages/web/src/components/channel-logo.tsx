import type { CSSProperties, ReactElement } from "react";

/**
 * Small, inline brand mark for a sales channel -- rendered directly before
 * the channel's own name wherever one is shown (badges on Dashboard/Orders/
 * Picklists/Inventory/Channels, the Products outbound-listing table, the
 * Reports channel table), per Arif's own two explicit choices: "official
 * style brand icons" (real, recognizable marks in each brand's own colors,
 * not a geometric/single-stroke style the way components/icons.tsx's own
 * nav icons are) and "small icon directly before the text" (inline,
 * compact -- never a standalone logo lockup).
 *
 * Sourced, not fabricated: Amazon/Shopify/eBay/TikTok use the exact SVG
 * path data + brand hex shipped by widely-used open-source icon packages
 * (simple-icons for Shopify/eBay/TikTok, Font Awesome's react-icons for
 * Amazon -- simple-icons itself does not ship an Amazon mark). Walmart and
 * Temu have no accurately-shaped mark in any open-source icon package
 * checked (simple-icons, react-icons' fa/fa6/si bundles -- confirmed
 * absent, not merely unchecked) -- rather than fabricate an inaccurate
 * copy of either brand's real logo shape (which this app should not
 * distribute), both render as a plain colored monogram badge in that
 * brand's own real, publicly published color (Walmart blue #0071CE,
 * Temu orange #FB7701) -- an honest placeholder, not a counterfeit logo.
 *
 * Deliberately NOT a new npm dependency (no simple-icons/react-icons
 * added to packages/web/package.json) -- same "hand-write the SVG, no
 * icon-package runtime dependency" precedent components/icons.tsx's own
 * header comment already establishes for this app's nav icons; the path
 * data below was extracted from those packages in a throwaway scratch
 * install, never imported into this app's own dependency tree.
 */
export function ChannelLogo({
  channel,
  size = 14,
}: {
  channel: string;
  size?: number;
}): ReactElement | null {
  const key = channel.trim().toLowerCase();

  switch (key) {
    case "amazon":
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 448 512"
          fill="#FF9900"
          aria-hidden="true"
          className="channel-logo"
        >
          <path d="M257.2 162.7c-48.7 1.8-169.5 15.5-169.5 117.5 0 109.5 138.3 114 183.5 43.2 6.5 10.2 35.4 37.5 45.3 46.8l56.8-56S341 288.9 341 261.4V114.3C341 89 316.5 32 228.7 32 140.7 32 94 87 94 136.3l73.5 6.8c16.3-49.5 54.2-49.5 54.2-49.5 40.7-.1 35.5 29.8 35.5 69.1zm0 86.8c0 80-84.2 68-84.2 17.2 0-47.2 50.5-56.7 84.2-57.8v40.6zm136 163.5c-7.7 10-70 67-174.5 67S34.2 408.5 9.7 379c-6.8-7.7 1-11.3 5.5-8.3C88.5 415.2 203 488.5 387.7 401c7.5-3.7 13.3 2 5.5 12zm39.8 2.2c-6.5 15.8-16 26.8-21.2 31-5.5 4.5-9.5 2.7-6.5-3.8s19.3-46.5 12.7-55c-6.5-8.3-37-4.3-48-3.2-10.8 1-13 2-14-.3-2.3-5.7 21.7-15.5 37.5-17.5 15.7-1.8 41-.8 46 5.7 3.7 5.1 0 27.1-6.5 43.1z" />
        </svg>
      );

    case "shopify":
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="#7AB55C"
          aria-hidden="true"
          className="channel-logo"
        >
          <path d="M15.337 23.979l7.216-1.561s-2.604-17.613-2.625-17.73c-.018-.116-.114-.192-.211-.192s-1.929-.136-1.929-.136-1.275-1.274-1.439-1.411c-.045-.037-.075-.057-.121-.074l-.914 21.104h.023zM11.71 11.305s-.81-.424-1.774-.424c-1.447 0-1.504.906-1.504 1.141 0 1.232 3.24 1.715 3.24 4.629 0 2.295-1.44 3.76-3.406 3.76-2.354 0-3.54-1.465-3.54-1.465l.646-2.086s1.245 1.066 2.28 1.066c.675 0 .975-.545.975-.932 0-1.619-2.654-1.694-2.654-4.359-.034-2.237 1.571-4.416 4.827-4.416 1.257 0 1.875.361 1.875.361l-.945 2.715-.02.01zM11.17.83c.136 0 .271.038.405.135-.984.465-2.064 1.639-2.508 3.992-.656.213-1.293.405-1.889.578C7.697 3.75 8.951.84 11.17.84V.83zm1.235 2.949v.135c-.754.232-1.583.484-2.394.736.466-1.777 1.333-2.645 2.085-2.971.193.501.309 1.176.309 2.1zm.539-2.234c.694.074 1.141.867 1.429 1.755-.349.114-.735.231-1.158.366v-.252c0-.752-.096-1.371-.271-1.871v.002zm2.992 1.289c-.02 0-.06.021-.078.021s-.289.075-.714.21c-.423-1.233-1.176-2.37-2.508-2.37h-.115C12.135.209 11.669 0 11.265 0 8.159 0 6.675 3.877 6.21 5.846c-1.194.365-2.063.636-2.16.674-.675.213-.694.232-.772.87-.075.462-1.83 14.063-1.83 14.063L15.009 24l.927-21.166z" />
        </svg>
      );

    case "ebay":
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="#E53238"
          aria-hidden="true"
          className="channel-logo"
        >
          <path d="M6.056 12.132v-4.92h1.2v3.026c.59-.703 1.402-.906 2.202-.906 1.34 0 2.828.904 2.828 2.855 0 .233-.015.457-.06.668.24-.953 1.274-1.305 2.896-1.344.51-.018 1.095-.018 1.56-.018v-.135c0-.885-.556-1.244-1.53-1.244-.72 0-1.245.3-1.305.81h-1.275c.136-1.29 1.5-1.62 2.686-1.62 1.064 0 1.995.27 2.415 1.02l-.436-.84h1.41l2.055 4.125 2.055-4.126H24l-3.72 7.305h-1.346l1.07-2.04-2.33-4.38c.13.255.2.555.2.93v2.46c0 .346.01.69.04 1.005H16.8a6.543 6.543 0 01-.046-.765c-.603.734-1.32.96-2.32.96-1.48 0-2.272-.78-2.272-1.695 0-.15.015-.284.037-.405-.3 1.246-1.36 2.086-2.767 2.086-.87 0-1.694-.315-2.2-.93 0 .24-.015.494-.04.734h-1.18c.02-.39.04-.855.04-1.245v-1.05h-4.83c.065 1.095.818 1.74 1.853 1.74.718 0 1.355-.3 1.568-.93h1.24c-.24 1.29-1.61 1.725-2.79 1.725C.95 15.009 0 13.822 0 12.232c0-1.754.982-2.91 3.116-2.91 1.688 0 2.93.886 2.94 2.806v.005zm9.137.183c-1.095.034-1.77.233-1.77.95 0 .465.36.97 1.305.97 1.26 0 1.935-.69 1.935-1.814v-.13c-.45 0-.99.006-1.484.022h.012zm-6.06 1.875c1.11 0 1.876-.806 1.876-2.02s-.768-2.02-1.893-2.02c-1.11 0-1.89.806-1.89 2.02s.765 2.02 1.875 2.02h.03zm-4.35-2.514c-.044-1.125-.854-1.546-1.725-1.546-.944 0-1.694.474-1.815 1.546z" />
        </svg>
      );

    case "tiktok":
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="#000000"
          aria-hidden="true"
          className="channel-logo"
        >
          <path d="M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z" />
        </svg>
      );

    case "walmart":
      return <ChannelMonogram letter="W" background="#0071CE" size={size} />;

    case "temu":
      return <ChannelMonogram letter="T" background="#FB7701" size={size} />;

    default:
      return null;
  }
}

/** Plain colored-circle monogram used for a channel with no accurately-shaped
 *  open-source mark available (Walmart, Temu -- see ChannelLogo's own header
 *  comment for why this app doesn't fabricate an approximation of either
 *  brand's real logo). Uses that brand's own real, publicly published color
 *  so it still reads as "that brand" at a glance, just via letterform + color
 *  instead of a shape. */
function ChannelMonogram({
  letter,
  background,
  size,
}: {
  letter: string;
  background: string;
  size: number;
}): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      className="channel-logo"
    >
      <circle cx="12" cy="12" r="12" fill={background} />
      <text
        x="12"
        y="16.5"
        textAnchor="middle"
        fontSize="13"
        fontWeight="700"
        fontFamily="system-ui, sans-serif"
        fill="#ffffff"
      >
        {letter}
      </text>
    </svg>
  );
}

/**
 * A channel's badge pill (channelBadgeClass, lib/channel-badge.ts) with its
 * ChannelLogo inline immediately before the label -- the one composed
 * component every "channel name shown as a small pill" call site in this
 * app (Dashboard, Orders, Orders detail, Picklists, Inventory, Channels)
 * should render through, so the icon+label pairing never drifts between
 * pages the way duplicating this markup at each call site would risk.
 * Deliberately takes the already-computed className/label rather than
 * recomputing them itself, so a call site that needs a non-default label
 * (e.g. Inventory's own per-channel "channel: qty" text) or an extra
 * className/style still composes cleanly.
 */
export function ChannelBadge({
  channel,
  label,
  className,
  style,
}: {
  channel: string;
  label: string;
  className: string;
  style?: CSSProperties;
}): ReactElement {
  return (
    <span className={className} style={style}>
      <ChannelLogo channel={channel} size={12} />
      <span className="channel-badge-label">{label}</span>
    </span>
  );
}
