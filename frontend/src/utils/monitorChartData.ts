export interface MonitorHistoryRecord {
  time: string;
  cpu?: number;
  ram?: number;
  ram_total?: number;
  disk?: number;
  disk_total?: number;
  net_in?: number;
  net_out?: number;
  temp?: number;
  connections?: number;
  connections_udp?: number;
  process_count?: number;
}

export interface MonitorChartPoint {
  time: number;
  cpu: number;
  ram: number;
  disk: number;
  net_in: number;
  net_out: number;
  temp: number;
  connections: number;
  connections_udp: number;
  process_count: number;
}

const emptyMetricValues = {
  cpu: 0,
  ram: 0,
  disk: 0,
  net_in: 0,
  net_out: 0,
  temp: 0,
  connections: 0,
  connections_udp: 0,
  process_count: 0,
};

export function buildMonitorChartData(records: MonitorHistoryRecord[]): MonitorChartPoint[] {
  return records.map((record) => ({
    time: new Date(record.time).getTime(),
    cpu: Number((record.cpu || 0).toFixed(2)),
    ram: record.ram_total && record.ram_total > 0
      ? Number((((record.ram || 0) / record.ram_total) * 100).toFixed(1))
      : 0,
    net_in: record.net_in || 0,
    net_out: record.net_out || 0,
    temp: record.temp || 0,
    disk: record.disk_total && record.disk_total > 0
      ? Number((((record.disk || 0) / record.disk_total) * 100).toFixed(1))
      : 0,
    connections: record.connections || 0,
    connections_udp: record.connections_udp || 0,
    process_count: record.process_count || 0,
  }));
}

export function buildMonitorChartAxisData(rangeMs: number, now = Date.now()): MonitorChartPoint[] {
  const end = Number.isFinite(now) ? now : Date.now();
  const start = end - Math.max(rangeMs, 1);

  return [
    { time: start, ...emptyMetricValues },
    { time: end, ...emptyMetricValues },
  ];
}

export function getMonitorChartRenderData(
  chartData: MonitorChartPoint[],
  rangeMs: number,
  now = Date.now(),
): MonitorChartPoint[] {
  return chartData.length > 0 ? chartData : buildMonitorChartAxisData(rangeMs, now);
}
