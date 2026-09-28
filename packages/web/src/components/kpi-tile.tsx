import type { ReactElement, ReactNode } from "react";

/**
 * A single KPI stat tile (Dashboard's top row, Analytics' summary row) --
 * a thin presentational wrapper around the .kpi-tile* classes in
 * app/globals.css, kept as one shared component so every page's KPI row
 * looks identical rather than each page hand-rolling its own markup.
 *
 * `delta` is optional and purely cosmetic framing for a number the page
 * already computed (e.g. "vs yesterday") -- this component never computes
 * a comparison itself, it only renders one it's given.
 */
export function KpiTile({
  label,
  value,
  meta,
  delta,
}: {
  label: string;
  value: ReactNode;
  meta?: ReactNode;
  delta?: { direction: "up" | "down"; text: string };
}): ReactElement {
  return (
    <div className="kpi-tile">
      <div className="kpi-tile-label">{label}</div>
      <div className="kpi-tile-value">{value}</div>
      {(meta || delta) && (
        <div className="kpi-tile-meta">
          {delta && <span className={`kpi-tile-delta ${delta.direction}`}>{delta.direction === "up" ? "▲" : "▼"} {delta.text}</span>}
          {meta}
        </div>
      )}
    </div>
  );
}
