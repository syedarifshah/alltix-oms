import type { ReactElement } from "react";

/**
 * Hand-rolled inline-SVG grouped bar chart (no chart library, see
 * donut-chart.tsx's sibling doc comment for why). A plain Server Component.
 * Used by /dashboard's "Inventory health by location" (on-hand vs reserved
 * per location) and /reports' "Orders by channel".
 */
export interface BarGroup {
  category: string;
  /** One value per entry in the `series` labels passed to BarChart, same
   *  order. */
  values: number[];
}

export function BarChart({
  groups,
  seriesLabels,
  seriesColors,
  width = 640,
  height = 220,
}: {
  groups: BarGroup[];
  seriesLabels: string[];
  seriesColors: string[];
  width?: number;
  height?: number;
}): ReactElement {
  const paddingLeft = 40;
  const paddingBottom = 24;
  const paddingTop = 12;
  const paddingRight = 8;
  const plotWidth = width - paddingLeft - paddingRight;
  const plotHeight = height - paddingTop - paddingBottom;

  const maxValue = Math.max(0, ...groups.flatMap((g) => g.values));
  const yMax = maxValue === 0 ? 1 : maxValue * 1.15;
  const yForValue = (v: number): number => paddingTop + plotHeight - (v / yMax) * plotHeight;

  const groupWidth = groups.length > 0 ? plotWidth / groups.length : plotWidth;
  const barGap = 4;
  const seriesCount = Math.max(1, seriesLabels.length);
  const barWidth = Math.max(2, (groupWidth - barGap * 2) / seriesCount);

  const gridLines = 4;
  const gridValues = Array.from({ length: gridLines + 1 }, (_, i) => (yMax / gridLines) * i);

  return (
    <div className="chart-wrap">
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Bar chart">
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
        {groups.map((group, gi) => {
          const groupX = paddingLeft + gi * groupWidth;
          return (
            <g key={group.category}>
              {group.values.map((value, si) => {
                const barX = groupX + barGap + si * barWidth;
                const barY = yForValue(value);
                const barHeight = paddingTop + plotHeight - barY;
                return (
                  <rect
                    key={si}
                    x={barX}
                    y={barY}
                    width={Math.max(1, barWidth - 2)}
                    height={Math.max(0, barHeight)}
                    fill={seriesColors[si] ?? "var(--chart-1)"}
                    rx={2}
                  />
                );
              })}
              <text x={groupX + groupWidth / 2} y={height - 6} fontSize="10" fill="var(--text-muted)" textAnchor="middle">
                {group.category}
              </text>
            </g>
          );
        })}
      </svg>
      <div className="chart-legend">
        {seriesLabels.map((label, i) => (
          <span key={label} className="chart-legend-item">
            <span className="chart-legend-swatch" style={{ background: seriesColors[i] }} />
            {label}
          </span>
        ))}
      </div>
    </div>
  );
}
