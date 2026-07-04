interface PingYAxisTickProps {
  x?: number;
  y?: number;
  payload?: {
    value?: number | string;
  };
}

export default function PingYAxisTick({ x = 0, y = 0, payload }: PingYAxisTickProps) {
  const numericValue = Number(payload?.value);
  const value = Number.isFinite(numericValue)
    ? String(Math.round(numericValue))
    : String(payload?.value ?? '');

  return (
    <text className="ping-y-axis-tick" x={x} y={y} dy={4} textAnchor="end">
      <tspan>{value}</tspan>
      <tspan className="ping-y-axis-tick-unit" dx="2">ms</tspan>
    </text>
  );
}
