import type { ReactElement } from "react";

/**
 * Small, hand-drawn 16x16 stroke icons for the sidebar nav -- no icon font
 * or icon-package dependency added (same "zero new infra risk" reasoning
 * as the hand-rolled SVG charts in components/charts/*.tsx). Deliberately
 * simple/geometric rather than pixel-perfect glyphs: legible at 16px,
 * consistent stroke weight, and easy to keep in sync if a new nav item is
 * ever added later without pulling in a whole icon set for one more glyph.
 * `currentColor` so each icon automatically matches its link's text color
 * (including the active/hover states already defined in globals.css).
 */
function Icon({ children }: { children: ReactElement }): ReactElement {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="sidebar-link-icon">
      {children}
    </svg>
  );
}

export const DashboardIcon = (): ReactElement => (
  <Icon>
    <>
      <rect x="1.5" y="1.5" width="6" height="6" rx="1" />
      <rect x="8.5" y="1.5" width="6" height="4" rx="1" />
      <rect x="8.5" y="7.5" width="6" height="7" rx="1" />
      <rect x="1.5" y="9.5" width="6" height="5" rx="1" />
    </>
  </Icon>
);

export const InventoryIcon = (): ReactElement => (
  <Icon>
    <>
      <path d="M1.5 4.5L8 1.5l6.5 3v7L8 14.5l-6.5-3z" />
      <path d="M1.5 4.5L8 7.5l6.5-3" />
      <path d="M8 7.5v7" />
    </>
  </Icon>
);

export const OrdersIcon = (): ReactElement => (
  <Icon>
    <>
      <path d="M2 3h1.6l1.2 8.4a1 1 0 0 0 1 .8h6a1 1 0 0 0 1-.8L14 5H4.2" />
      <circle cx="6.2" cy="14" r="0.9" />
      <circle cx="11.6" cy="14" r="0.9" />
    </>
  </Icon>
);

export const ChannelsIcon = (): ReactElement => (
  <Icon>
    <>
      <circle cx="4" cy="4" r="2.2" />
      <circle cx="12" cy="4" r="2.2" />
      <circle cx="8" cy="12.5" r="2.2" />
      <path d="M5.6 5.2L7 11" />
      <path d="M10.4 5.2L9 11" />
    </>
  </Icon>
);

export const AutomationIcon = (): ReactElement => (
  <Icon>
    <path d="M8.6 1.5L2.5 9h4l-1 5.5L14 7h-4z" />
  </Icon>
);

export const FulfillmentIcon = (): ReactElement => (
  <Icon>
    <>
      <rect x="1.5" y="4.5" width="8" height="7" rx="1" />
      <path d="M9.5 7h2.6L14.5 9.7V11.5h-5" />
      <circle cx="4.5" cy="12.8" r="1.3" />
      <circle cx="11.5" cy="12.8" r="1.3" />
    </>
  </Icon>
);

export const AnalyticsIcon = (): ReactElement => (
  <Icon>
    <>
      <path d="M1.5 14.5h13" />
      <rect x="3" y="8.5" width="2.4" height="6" />
      <rect x="6.8" y="5" width="2.4" height="9.5" />
      <rect x="10.6" y="2.5" width="2.4" height="12" />
    </>
  </Icon>
);

export const SettingsIcon = (): ReactElement => (
  <Icon>
    <>
      <circle cx="8" cy="8" r="2.4" />
      <path d="M8 1.8v1.6M8 12.6v1.6M14.2 8h-1.6M3.4 8H1.8M12.4 3.6l-1.1 1.1M4.7 11.3l-1.1 1.1M12.4 12.4l-1.1-1.1M4.7 4.7L3.6 3.6" />
    </>
  </Icon>
);

export const ProductsIcon = (): ReactElement => (
  <Icon>
    <>
      <path d="M2 8.2L7.2 2h4.3L14.5 6.3v4.3L8.3 14z" />
      <circle cx="6" cy="6" r="1" fill="currentColor" stroke="none" />
    </>
  </Icon>
);

export const PeopleIcon = (): ReactElement => (
  <Icon>
    <>
      <circle cx="6" cy="5.2" r="2.2" />
      <path d="M1.8 14v-.9a3.6 3.6 0 0 1 3.6-3.6h1.2a3.6 3.6 0 0 1 3.6 3.6v.9" />
      <path d="M10.6 3.2a2.2 2.2 0 0 1 0 4" />
      <path d="M12.4 9.8a3.4 3.4 0 0 1 2.3 3.2v1" />
    </>
  </Icon>
);

export const PayrollIcon = (): ReactElement => (
  <Icon>
    <>
      <circle cx="8" cy="8" r="6.3" />
      <path d="M8 4.6v6.8" />
      <path d="M10.1 6.2a1.9 1.9 0 0 0-1.8-1.2H7.8a1.6 1.6 0 0 0 0 3.2h.4a1.6 1.6 0 0 1 0 3.2H7.9a1.9 1.9 0 0 1-1.8-1.2" />
    </>
  </Icon>
);
