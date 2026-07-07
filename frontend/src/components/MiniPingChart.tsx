import { useEffect, useMemo, useState } from 'react';
import { Box, Flex, Text } from '@radix-ui/themes';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  buildPingChartRows,
  fetchPingTaskSeries,
  formatPingMs,
  getPingSeriesAverage,
  getPingSeriesWithRecords,
  getPingTimeDomain,
  getPingYAxisDomain,
  PingTaskSeries,
} from '../utils/pingChart';
import PingYAxisTick from './PingYAxisTick';

interface MiniPingChartProps {
  uuid: string;
  width?: string | number;
  height?: number;
  limit?: number;
  rangeHours?: number;
  fillContainer?: boolean;
  includeHidden?: boolean;
}

export default function MiniPingChart({
  uuid,
  width = 420,
  height = 220,
  limit = 360,
  rangeHours = 1,
  fillContainer = false,
  includeHidden = false,
}: MiniPingChartProps) {
  const [series, setSeries] = useState<PingTaskSeries[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!uuid) return;

    const controller = new AbortController();

    async function loadData() {
      setLoading(true);
      setError(null);

      try {
        const nextSeries = await fetchPingTaskSeries(uuid, {
          limit,
          maxTasks: 8,
          rangeHours,
          includeHidden,
          signal: controller.signal,
        });
        if (!controller.signal.aborted) setSeries(nextSeries);
      } catch (err: any) {
        if (!controller.signal.aborted) {
          setError(err?.message || '加载 Ping 数据失败');
          setSeries([]);
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }

    loadData();
    return () => controller.abort();
  }, [includeHidden, limit, rangeHours, uuid]);

  const seriesWithRecords = useMemo(
    () => getPingSeriesWithRecords(series),
    [series],
  );
  const chartRows = useMemo(() => buildPingChartRows(seriesWithRecords), [seriesWithRecords]);
  const yAxisDomain = useMemo(() => getPingYAxisDomain(seriesWithRecords), [seriesWithRecords]);
  const xAxisDomain = useMemo(
    () => getPingTimeDomain(seriesWithRecords, rangeHours),
    [rangeHours, seriesWithRecords],
  );

  const contentWidth = typeof width === 'number' ? `${width}px` : width;

  if (loading) {
    return (
      <Flex align="center" justify="center" style={{ width: contentWidth, height }}>
        <Text size="2" color="gray">加载 Ping 数据…</Text>
      </Flex>
    );
  }

  if (error) {
    return (
      <Flex align="center" justify="center" style={{ width: contentWidth, minHeight: 120, padding: 16 }}>
        <Text size="2" color="red">{error}</Text>
      </Flex>
    );
  }

  if (series.length === 0) {
    return (
      <Flex align="center" justify="center" style={{ width: contentWidth, minHeight: 120, padding: 16 }}>
        <Text size="2" color="gray">暂无 Ping 任务</Text>
      </Flex>
    );
  }

  if (chartRows.length === 0 || seriesWithRecords.length === 0) {
    return (
      <Flex direction="column" gap="2" style={{ width: contentWidth, minHeight: 120, padding: 14 }}>
        <Text size="2" weight="bold">Ping 延迟</Text>
        <Text size="2" color="gray">暂无该节点的 Ping 记录</Text>
      </Flex>
    );
  }

  return (
    <Box
      className="mini-ping-chart"
      style={{
        width: contentWidth,
        maxWidth: fillContainer ? 'none' : 'calc(100vw - 32px)',
        padding: 8,
      }}
    >
      <Box style={{ width: '100%', height }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={chartRows} margin={{ top: 12, right: 10, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} strokeDasharray="3 3" opacity={0.25} />
            <XAxis
              dataKey="time"
              type="number"
              domain={xAxisDomain}
              tickFormatter={(value) => new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
              fontSize={11}
              tickLine={false}
              axisLine={false}
              minTickGap={28}
            />
            <YAxis
              fontSize={11}
              width={48}
              tickLine={false}
              axisLine={false}
              allowDecimals={false}
              domain={yAxisDomain}
              tick={<PingYAxisTick />}
            />
            <Tooltip
              labelFormatter={(value) => new Date(value as number).toLocaleString('zh-CN')}
              formatter={(value: number, name) => [
                formatPingMs(value),
                name,
              ]}
              contentStyle={{
                border: '1px solid var(--gray-5)',
                borderRadius: 8,
                background: 'var(--color-panel-solid)',
                color: 'var(--gray-12)',
                fontSize: 12,
              }}
            />
            {seriesWithRecords.map((item) => (
              <Line
                key={item.task.key}
                type="monotone"
                dataKey={item.task.key}
                name={item.task.label}
                stroke={item.task.color}
                strokeWidth={3}
                strokeOpacity={1}
                strokeLinecap="round"
                strokeLinejoin="round"
                dot={false}
                connectNulls
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </Box>

      <Box className="mini-ping-chart-legend">
        {seriesWithRecords.map((item) => {
          const avg = getPingSeriesAverage(item.records);
          return (
            <Box
              key={item.task.key}
              className="mini-ping-chart-legend-item"
              style={{
                border: `1px solid ${item.task.color}`,
                borderLeft: `4px solid ${item.task.color}`,
                background: `color-mix(in srgb, ${item.task.color} 10%, var(--color-panel-solid))`,
              }}
              title={`${item.task.type} ${item.task.target}`}
            >
              <Flex align="center" gap="2">
                <span
                  aria-hidden="true"
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: 999,
                    background: item.task.color,
                    flexShrink: 0,
                  }}
                />
                <Text size="1" weight="bold" truncate className="mini-ping-chart-legend-name" style={{ color: item.task.color }}>
                  {item.task.label}
                </Text>
              </Flex>
              <Text size="1" color="gray" className="mini-ping-chart-legend-stat">
                {avg === null ? '全部超时' : `平均 ${formatPingMs(avg)}`}
              </Text>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}
