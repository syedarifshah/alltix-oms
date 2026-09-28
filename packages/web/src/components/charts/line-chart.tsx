import type { ReactElement } from "react";

/**
 * Hand-rolled inline-SVG multi-series line chart (no chart library, see
 * donut-chart.tsx's sibling doc comment for why). A plain Server Component
 * -- takes already-aggregated per-day points and draws static SVG, no
 * client JS/hooks/tooltips. Used by /dashboard's "Orders trend" (one line
 * per channel, from the daily sales rollup) and /reports' "Revenue trend".
 */
export interface LineSeries {
  label: string;
  color: string;
  /** One value per label in `categories`, same length/order -- null for a
   *  day with no data (rendered as a gap in that series' line, not a 0). */
  values: Array<number | null>;
}

export function LineChart({
  categories,
  series,
  width = 640,
  height = 220,
}: {
  categories: string[];
  series: LineSeries[];
  width?: number;
  height?: number;
}): ReactElement {
  const paddingLeft = 40;
  const paddingBottom = 24;
  const paddingTop = 12;
  const paddingRight = 8;
  const plotWidth = width - paddingLeft - paddingRight;
  const plotHeight = height - paddingTop - paddingBottom;

  const allValues = series.flatMap((s) => s.values.filter((v): v is number => v !== null));
  const maxValue = allValues.length > 0 ? Math.max(...allValues, 0) : 0;
  // A flat/empty chart still draws a sensible axis instead of dividing by
  // zero below -- 1 keeps every point pinned to the baseline rather than
  // NaN-ing the whole path.
  const yMax = maxValue === 0 ? 1 : maxValue * 1.15;

  const stepX = categories.length > 1 ? plotWidth / (categories.length - 1) : 0;
  const xForIndex = (i: number): number => paddingLeft + stepX * i;
  const yForValue = (v: number): number => paddingTop + plotHeight - (v / yMax) * plotHeight;

  const gridLines = 4;
  const gridValues = Array.from({ length: gridLines + 1 }, (_, i) => (yMax / gridLines) * i);

  // Show at most ~7 x-axis labels so a 14/30/90-day range doesn't collide
  // into unreadable overlapping text -- every Nth category label is drawn,
  // the rest still get their point plotted, just no text underneath.
  const labelEvery = Math.max(1, Math.ceil(categories.length / 7));

  function pathFor(values: Array<number | null>): string {
    let d = "";
    let drawing = false;
    values.forEach((v, i) => {
      if (v === null) {
        drawing = false;
        return;
      }
      const x = xForIndex(i);
      const y = yForValue(v);
      d += drawing ? ` L ${x} ${y}` : ` M ${x} ${y}`;
      drawing = true;
    });
    return d.trim();
  }

  return (
    <div className="chart-wrap">
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Trend chart">
        {gridValues.map((gv) => {
          const y = yForValue(gv);
          return (
            <g key={gv}>
              <line x1={paddingLeft} y1={y} x2={width - paddingRight} y2={y} stroke="var(--chart-grid)" strokeWidth={1} />
              <text x={paddingLeft - 8} y={y + 3} fontSize="10" fill="var(--text-muted)" textAnchor="end">
                {Math.round(gv)}
              </text>
            </g>
          );
        })}
        {categories.map((cat, i) =>
          i % labelEvery === 0 ? (
            <text key={cat} x={xForIndex(i)} y={height - 6} fontSize="10" fill="var(--text-muted)" textAnchor="middle">
              {cat}
            </text>
          ) : null,
        )}
        {series.map((s) => (
          <path key={s.label} d={pathFor(s.values)} fill="none" stroke={s.color} strokeWidth={2.25} strokeLinejoin="round" strokeLinecap="round" />
        ))}
        {series.map((s) =>
          s.values.map((v, i) =>
            v === null ? null : (
              <circle key={`${s.label}-${i}`} cx={xForIndex(i)} cy={yForValue(v)} r={2.5} fill={s.color} />
            ),
          ),
        )}
      </svg>
      <div className="chart-legend">
        {series.map((s) => (
          <span key={s.label} className="chart-legend-item">
            <span className="chart-legend-swatch" style={{ background: s.color }} />
            {s.label}
          </span>
        ))}
      </div>
    </div>
  );
}
