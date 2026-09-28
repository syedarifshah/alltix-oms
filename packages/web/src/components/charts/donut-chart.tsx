import type { ReactElement } from "react";

/**
 * Hand-rolled inline-SVG donut chart -- no chart library dependency (this
 * app has none, see this directory's sibling files' own comments for why
 * that's a deliberate choice, not an oversight, for a purely visual
 * redesign pass). A plain Server Component: takes already-aggregated
 * segments and renders static SVG server-side, same "no client JS needed"
 * posture every other page in this app already has (the mobile-menu
 * hamburger on components/marketing/marketing-header.tsx is one of the few
 * real exceptions, needing real interactive state; a light/dark theme
 * toggle used to be another, removed along with the toggle itself when the
 * app moved to a single fixed palette -- see globals.css's own header
 * comment).
 *
 * Used by /dashboard's "Order state distribution" -- segments are the
 * ALL_ORDER_STATUSES counts, already computed by the page itself; this
 * component only draws what it's given, it never queries anything.
 */
export interface DonutSegment {
  label: string;
  value: number;
  color: string;
}

export function DonutChart({
  segments,
  size = 168,
  thickness = 26,
  centerLabel,
  centerValue,
}: {
  segments: DonutSegment[];
  size?: number;
  thickness?: number;
  centerLabel?: string;
  centerValue?: string;
}): ReactElement {
  const total = segments.reduce((sum, s) => sum + s.value, 0);
  const radius = (size - thickness) / 2;
  const circumference = 2 * Math.PI * radius;
  const center = size / 2;

  let offsetSoFar = 0;
  const arcs = segments
    .filter((s) => s.value > 0)
    .map((segment) => {
      const fraction = total > 0 ? segment.value / total : 0;
      const dash = fraction * circumference;
      const dashArray = `${dash} ${circumference - dash}`;
      // SVG circles start their stroke at 3 o'clock going clockwise; the
      // -90deg rotation on the <g> below moves the start to 12 o'clock, and
      // this negative dashoffset walks each subsequent arc forward by the
      // total drawn so far, so segments tile around the ring with no gaps.
      const dashOffset = -offsetSoFar;
      offsetSoFar += dash;
      return { ...segment, dashArray, dashOffset };
    });

  return (
    <div className="chart-wrap">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label="Order state distribution">
        <circle cx={center} cy={center} r={radius} fill="none" stroke="var(--chart-grid)" strokeWidth={thickness} />
        <g transform={`rotate(-90 ${center} ${center})`}>
          {arcs.map((arc) => (
            <circle
              key={arc.label}
              cx={center}
              cy={center}
              r={radius}
              fill="none"
              stroke={arc.color}
              strokeWidth={thickness}
              strokeDasharray={arc.dashArray}
              strokeDashoffset={arc.dashOffset}
              strokeLinecap="butt"
            />
          ))}
        </g>
        {(centerLabel || centerValue) && (
          <g textAnchor="middle">
            {centerValue && (
              <text x={center} y={center - 2} fontSize="20" fontWeight="700" fill="var(--text)">
                {centerValue}
              </text>
            )}
            {centerLabel && (
              <text x={center} y={center + 18} fontSize="11" fill="var(--text-muted)">
                {centerLabel}
              </text>
            )}
          </g>
        )}
      </svg>
      <div className="chart-legend">
        {segments.map((segment) => (
          <span key={segment.label} className="chart-legend-item">
            <span className="chart-legend-swatch" style={{ background: segment.color }} />
            {segment.label} ({segment.value})
          </span>
        ))}
      </div>
    </div>
  );
}
