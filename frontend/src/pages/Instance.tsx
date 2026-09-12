import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Flex, Card, Text, Badge, Heading,
  Button, Box, Tabs, SegmentedControl
} from '@radix-ui/themes';
import {
  ArrowLeft,
  Server, Globe, Activity,
  Layers
} from 'lucide-react';
import Loading from '../components/Loading';
import DetailsGrid from '../components/DetailsGrid';
import Flag from '../components/Flag';
import PingYAxisTick from '../components/PingYAxisTick';
import { useLiveData } from '../contexts/LiveDataContext';
import { useAuth } from '../contexts/AuthContext';
import { publicFetch } from '../utils/api';
import { normalizePublicClients } from '../utils/publicClients';
import {
  collectCursorHistory,
  normalizePublicGpuRecords,
  normalizePublicMonitorRecords,
  type PublicGpuRecord,
  type PublicMonitorRecord,
} from '../utils/publicHistory';
import type { ClientInfo, LiveDataMap } from '../types';
import { formatLastReport, formatMetricUptime, getNodeDisplayRecord, getNodeLastReportTime, getNodeStatus } from '../utils/nodeMetrics';
import { filterMonitorNodes } from '../utils/monitorView';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Area, AreaChart
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
import { buildMonitorChartData, getMonitorChartRenderData } from '../utils/monitorChartData';
import { monitorYAxisProps, pingYAxisProps, wideYAxisProps } from '../utils/monitorChartAxis';
import { chartTooltipProps } from '../utils/chartTooltip';

const formatSpeed = (bytes: number): string => {
  if (!bytes || bytes === 0) return '0 B/s';
  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i >= 2 ? 1 : 0)} ${units[i]}`;
};

type TimeRange = '1h' | '4h' | '24h' | '3d';
type ChartTab = 'cpu' | 'ram' | 'disk' | 'network' | 'connections' | 'process' | 'temp' | 'gpu';

const timeRangeMs: Record<TimeRange, number> = {
  '1h': 3600000,
  '4h': 14400000,
  '24h': 86400000,
  '3d': 259200000,
};

const timeRangeHours: Record<TimeRange, number> = {
  '1h': 1,
  '4h': 4,
  '24h': 24,
  '3d': 72,
};

const timeRangePointLimit: Record<TimeRange, number> = {
  '1h': 240,
  '4h': 360,
  '24h': 720,
  '3d': 1000,
};

const monitorChartMargin = { top: 12, right: 16, bottom: 4, left: 4 };
const monitorChartHeight = 296;
const pingChartHeight = 210;

function historyQuery(params: Record<string, string | number | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') query.set(key, String(value));
  }
  return query.toString();
}
export default function Instance() {
  const { uuid } = useParams<{ uuid: string }>();
  const navigate = useNavigate();
  const { authLoading, isAuthenticated } = useAuth();
  const [client, setClient] = useState<ClientInfo | null>(null);
  const [clients, setClients] = useState<ClientInfo[]>([]);
  const [records, setRecords] = useState<PublicMonitorRecord[]>([]);
  const [clientLoading, setClientLoading] = useState(true);
  const [recordsLoading, setRecordsLoading] = useState(true);
  const [recordsError, setRecordsError] = useState<string | null>(null);
  const [gpuError, setGpuError] = useState<string | null>(null);
  const [gpuLoading, setGpuLoading] = useState(false);
  const [gpuRefresh, setGpuRefresh] = useState(0);
  const clientRequestRef = useRef(0);
  const recordsRequestRef = useRef(0);
  const [error, setError] = useState<string | null>(null);
  const [chartTab, setChartTab] = useState<ChartTab>('cpu');
  const [timeRange, setTimeRange] = useState<TimeRange>('1h');
  const [recordsRangeEnd, setRecordsRangeEnd] = useState(() => Date.now());
  const [pingSeries, setPingSeries] = useState<PingTaskSeries[]>([]);
  const [pingLoading, setPingLoading] = useState(false);
  const [pingError, setPingError] = useState<string | null>(null);
  const [shouldLoadPing, setShouldLoadPing] = useState(false);
  const [gpuRecords, setGpuRecords] = useState<PublicGpuRecord[]>([]);
  const pingSectionRef = useRef<HTMLDivElement | null>(null);
  const { liveData, snapshotReady } = useLiveData();
  const liveView: LiveDataMap = useMemo(() => ({ online: liveData?.online || [], data: liveData?.data || {},
    clients: liveData?.clients || [], last_known: liveData?.last_known || {}, statusReady: snapshotReady }), [liveData, snapshotReady]);
  const liveRecord = uuid ? getNodeDisplayRecord(uuid, liveView) : undefined;
  const nodeStatus = uuid ? getNodeStatus(uuid, liveView) : 'unknown';
  const onlineSet = useMemo(() => new Set(liveData?.online || []), [liveData?.online]);
  const groupedClients = useMemo(() => {
    const sorted = filterMonitorNodes(clients, liveView, { offlinePosition: 'last' });

    const groups = new Map<string, ClientInfo[]>();
    sorted.forEach((node) => {
      const groupName = node.group?.trim() || '未分组';
      if (!groups.has(groupName)) groups.set(groupName, []);
      groups.get(groupName)!.push(node);
    });

    return Array.from(groups.entries())
      .sort(([a], [b]) => {
        if (a === '未分组') return 1;
        if (b === '未分组') return -1;
        return a.localeCompare(b);
      })
      .map(([group, nodes]) => ({ group, nodes }));
  }, [clients, liveView]);

  // Load public client info.
  const loadClient = useCallback(async (signal?: AbortSignal) => {
    if (!uuid || authLoading) return;
    const requestId = ++clientRequestRef.current;
    setClientLoading(true);
    setClient(null);
    try {
      setError(null);
      const data = await publicFetch(`/nodes${isAuthenticated ? '?include_hidden=1' : ''}`, { signal });
      if (signal?.aborted || requestId !== clientRequestRef.current) return;
      const visible = normalizePublicClients(data, { includeHidden: isAuthenticated });
      setClients(visible);
      const found = visible.find((c) => c.uuid === uuid) || null;
      if (found) { setClient(found); } else { setError('服务器不存在'); }
    } catch {
      if (!signal?.aborted && requestId === clientRequestRef.current) setError('加载失败');
    } finally {
      if (!signal?.aborted && requestId === clientRequestRef.current) setClientLoading(false);
    }
  }, [uuid, authLoading, isAuthenticated]);

  useEffect(() => {
    const controller = new AbortController();
    void loadClient(controller.signal);
    return () => { controller.abort(); clientRequestRef.current += 1; };
  }, [loadClient]);

  // Load history records
  const loadRecords = useCallback(async (range: TimeRange, signal?: AbortSignal) => {
    if (!uuid || authLoading) return;
    const requestId = ++recordsRequestRef.current;
    setRecordsLoading(true);
    setRecords([]);
    setRecordsError(null);
    const endTs = Date.now();
    const startTs = endTs - timeRangeMs[range];
    const start = new Date(startTs).toISOString();
    const end = new Date(endTs).toISOString();
    const limit = timeRangePointLimit[range];
    setRecordsRangeEnd(endTs);

    try {
      const data = await collectCursorHistory(
        (cursor) => publicFetch(`/records/load?${historyQuery({ uuid, start, end, cursor, limit: Math.min(limit, 500), include_hidden: isAuthenticated ? 1 : undefined })}`, { signal }),
        { cursor: end, start, end, normalize: normalizePublicMonitorRecords, signal },
      );
      if (!signal?.aborted && requestId === recordsRequestRef.current) setRecords(data);
    } catch {
      if (!signal?.aborted && requestId === recordsRequestRef.current) setRecordsError('加载监控历史失败，请重试');
    } finally {
      if (!signal?.aborted && requestId === recordsRequestRef.current) setRecordsLoading(false);
    }
  }, [uuid, authLoading, isAuthenticated]);

  useEffect(() => {
    const controller = new AbortController();
    void loadRecords(timeRange, controller.signal);
    return () => { controller.abort(); recordsRequestRef.current += 1; };
  }, [loadRecords, timeRange]);

  useEffect(() => {
    setShouldLoadPing(false);
    setPingSeries([]);
    setPingError(null);
    setPingLoading(false);
  }, [uuid]);

  useEffect(() => {
    if (shouldLoadPing) return;
    const target = pingSectionRef.current;
    if (!target || typeof IntersectionObserver === 'undefined') {
      setShouldLoadPing(true);
      return;
    }

    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      setShouldLoadPing(true);
      observer.disconnect();
    }, { rootMargin: '240px 0px' });
    observer.observe(target);
    return () => observer.disconnect();
  }, [shouldLoadPing, uuid]);

  // Load ping tasks and records only when the Ping card is near the viewport.
  useEffect(() => {
    if (!uuid || authLoading || !shouldLoadPing) return;
    const controller = new AbortController();
    setPingSeries([]);
    setPingError(null);
    setPingLoading(true);

    fetchPingTaskSeries(uuid, { limit: 360, maxTasks: 8, rangeHours: timeRangeHours[timeRange], cursor: new Date().toISOString(), includeHidden: isAuthenticated, signal: controller.signal })
      .then((series) => {
        if (!controller.signal.aborted) setPingSeries(series);
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setPingError('加载 Ping 数据失败');
          setPingSeries([]);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setPingLoading(false);
      });

    return () => controller.abort();
  }, [shouldLoadPing, timeRange, uuid, authLoading, isAuthenticated]);

  // Load GPU records (only for GPU-capable clients)
  useEffect(() => {
    if (client && !client.gpu_name) setChartTab(current => current === 'gpu' ? 'cpu' : current);
  }, [client?.uuid, client?.gpu_name]);

  useEffect(() => {
    setGpuRecords([]);
    setGpuError(null);
    setGpuLoading(false);
    if (!uuid || authLoading || !client?.gpu_name || client.uuid !== uuid) return;
    setGpuLoading(true);
    const controller = new AbortController();
    const endTs = Date.now();
    const startTs = endTs - timeRangeMs[timeRange];
    const start = new Date(startTs).toISOString();
    const end = new Date(endTs).toISOString();

    collectCursorHistory(
      (cursor) => publicFetch(`/records/gpu?${historyQuery({ uuid, start, end, cursor, limit: 500, include_hidden: isAuthenticated ? 1 : undefined })}`, { signal: controller.signal }),
      { cursor: end, start, end, normalize: normalizePublicGpuRecords, signal: controller.signal },
    )
      .then((data) => { if (!controller.signal.aborted) setGpuRecords(data); })
      .catch(() => { if (!controller.signal.aborted) setGpuError('加载 GPU 历史失败，请重试'); })
      .finally(() => { if (!controller.signal.aborted) setGpuLoading(false); });
    return () => controller.abort();
  }, [uuid, timeRange, client?.uuid, client?.gpu_name, authLoading, isAuthenticated, gpuRefresh]);

  const handleTimeRangeChange = (v: string) => {
    const range = v as TimeRange;
    setTimeRange(range);
    setRecords([]);
    setGpuRecords([]);
    setRecordsLoading(true);
  };

  if (clientLoading || (client && client.uuid !== uuid) || (recordsLoading && records.length === 0)) return <Loading />;
  if (error || !client) return <Text color="red" align="center" style={{ padding: 40 }}>{error || '未找到'}</Text>;

  const latestHistory = records.length > 0 ? records[records.length - 1] : null;
  const latest = liveRecord || latestHistory;
  const latestRecordTime = liveRecord ? getNodeLastReportTime(uuid || '', liveView)
    : latestHistory ? Date.parse(latestHistory.time) : undefined;

  const chartTimeFormatter = (value: unknown) => {
    const dateInput = typeof value === 'string' || typeof value === 'number' || value instanceof Date ? value : '';
    const date = new Date(dateInput);
    if (Number.isNaN(date.getTime())) return '';
    return timeRange === '24h' || timeRange === '3d'
      ? date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      : date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  };

  const chartData = buildMonitorChartData(records);
  const chartRenderData = getMonitorChartRenderData(chartData, timeRangeMs[timeRange], recordsRangeEnd);
  const monitorXAxisDomain = [recordsRangeEnd - timeRangeMs[timeRange], recordsRangeEnd] as [number, number];

  const gpuChartData = gpuRecords.map((r) => ({
    time: new Date(r.time).getTime(),
    utilization: r.utilization || 0,
    memory: r.mem_total > 0 ? Number(((r.mem_used / r.mem_total) * 100).toFixed(1)) : 0,
    temp: r.temperature || 0,
  }));

  const pingSeriesWithRecords = getPingSeriesWithRecords(pingSeries);
  const pingChartRows = buildPingChartRows(pingSeriesWithRecords);
  const pingYAxisDomain = getPingYAxisDomain(pingSeriesWithRecords);
  const pingXAxisDomain = getPingTimeDomain(pingSeriesWithRecords, timeRangeHours[timeRange]);

  return (
    <div className="instance-page">
      <div className="instance-shell">
        <InstanceNodeSidebar
          groups={groupedClients}
          activeUuid={uuid || ''}
          onlineSet={onlineSet}
          statusReady={snapshotReady}
          liveData={liveData?.data || {}}
          onSelect={(nextUuid) => navigate(`/instance/${nextUuid}`)}
        />

        <section className="instance-detail-panel">
      {/* Top bar */}
      <Flex justify="between" align="center" mb="4">
        <Button variant="ghost" onClick={() => navigate('/')}>
          <ArrowLeft size={16} /> 返回
        </Button>
      </Flex>

      {/* Header + compact details */}
      <Card className="instance-top-summary" mb="3">
        <Flex align="center" gap="3" wrap="wrap" className="instance-top-summary-header">
          <Server size={26} color="var(--accent-9)" />
          <Heading size="5">{client.name}</Heading>
          {client.region && <Badge color="gray"><Globe size={12} /> {client.region}</Badge>}
          {client.group && <Badge color="purple"><Layers size={12} /> {client.group}</Badge>}
          <Badge color={nodeStatus === 'online' ? 'green' : nodeStatus === 'offline' ? 'red' : 'gray'} variant="solid">
            <Activity size={12} /> {nodeStatus === 'online' ? `在线 · 已运行 ${formatMetricUptime(latest?.uptime)}` : nodeStatus === 'offline' ? '离线' : '确认中'}
          </Badge>
          {nodeStatus === 'offline' && <Text size="1" color="gray">最后上报 {formatLastReport(latestRecordTime)} · 上报时已运行 {formatMetricUptime(latest?.uptime)}</Text>}
        </Flex>
        <DetailsGrid client={client} live={latest || undefined} compact remark={client.public_remark} />
      </Card>

      {/* Chart section */}
      <Card mb="4">
        {recordsError && <Flex align="center" gap="2" mb="2"><Text color="red" role="alert">{recordsError}</Text><Button size="1" variant="soft" onClick={() => void loadRecords(timeRange)}>重试</Button></Flex>}
        {chartTab === 'gpu' && gpuError && <Flex align="center" gap="2" mb="2"><Text color="red" role="alert">{gpuError}</Text><Button size="1" variant="soft" onClick={() => setGpuRefresh(value => value + 1)}>重试 GPU 历史</Button></Flex>}
        <Flex justify="between" align="center" mb="3" gap="3" wrap="wrap">
          <Text weight="bold">监控图表 · {timeRange === '1h' ? '最近1小时' : timeRange === '4h' ? '最近4小时' : timeRange === '24h' ? '最近24小时' : '最近3天'}</Text>
          <Flex align="center" gap="3" wrap="wrap">
            <SegmentedControl.Root size="1" value={timeRange} onValueChange={handleTimeRangeChange}>
              <SegmentedControl.Item value="1h">1小时</SegmentedControl.Item>
              <SegmentedControl.Item value="4h">4小时</SegmentedControl.Item>
              <SegmentedControl.Item value="24h">24小时</SegmentedControl.Item>
              <SegmentedControl.Item value="3d">3天</SegmentedControl.Item>
            </SegmentedControl.Root>
            <Text size="1" color="gray">{records.length} 个数据点</Text>
          </Flex>
        </Flex>
        <Tabs.Root value={chartTab} onValueChange={(value) => setChartTab(value as ChartTab)}>
          <Flex justify="center" className="instance-chart-tabs">
            <Tabs.List>
              <Tabs.Trigger value="cpu">CPU</Tabs.Trigger>
              <Tabs.Trigger value="ram">内存</Tabs.Trigger>
              <Tabs.Trigger value="disk">磁盘</Tabs.Trigger>
              <Tabs.Trigger value="network">网络</Tabs.Trigger>
              <Tabs.Trigger value="connections">连接数</Tabs.Trigger>
              <Tabs.Trigger value="process">进程数</Tabs.Trigger>
              <Tabs.Trigger value="temp">温度</Tabs.Trigger>
              {client.gpu_name && (
                <Tabs.Trigger value="gpu">GPU</Tabs.Trigger>
              )}
            </Tabs.List>
          </Flex>

          <Box pt="3">
            {chartTab === 'disk' && <Text as="p" size="1" color="gray" mb="2">按上报时间记录，可能包含容器文件占用估算；同一次磁盘采样可出现在多次上报中。</Text>}
            {(chartTab === 'temp' || chartTab === 'disk') && !recordsLoading && !recordsError && !chartData.some((point) => point[chartTab] !== null) ? (
              <Flex align="center" justify="center" style={{ height: monitorChartHeight }}>
                <Text role="status" color="gray">{chartTab === 'temp' ? '温度数据不可用' : '磁盘使用量数据不可用'}</Text>
              </Flex>
            ) : chartTab === 'gpu' && gpuLoading ? (
              <Text role="status" color="gray">正在加载 GPU 历史…</Text>
            ) : chartTab === 'gpu' && !gpuError && gpuRecords.length === 0 ? (
              <Text role="status" color="gray">暂无 GPU 历史记录</Text>
            ) : chartTab === 'gpu' && gpuError ? null : chartTab === 'gpu' ? (
              <ResponsiveContainer width="100%" height={monitorChartHeight}>
                <LineChart data={gpuChartData} margin={monitorChartMargin}>
                  <CartesianGrid vertical={false} strokeDasharray="3 3" opacity={0.3} />
                  <XAxis
                    dataKey="time"
                    type="number"
                    domain={monitorXAxisDomain}
                    tickFormatter={chartTimeFormatter}
                    fontSize={12}
                    minTickGap={28}
                    tickLine={false}
                    axisLine={false}
                  />
                  <YAxis {...monitorYAxisProps} domain={[0, 100]} tickFormatter={(value) => `${value}%`} />
                  <Tooltip
                    {...chartTooltipProps}
                    labelFormatter={chartTimeFormatter}
                    formatter={(value: number, name) => [
                      `${Number(value).toFixed(1)}${name === '温度 °C' ? ' °C' : '%'}`,
                      name,
                    ]}
                  />
                  <Line type="monotone" dataKey="utilization" stroke="var(--accent-9)" dot={false} strokeWidth={2} name="利用率 %" isAnimationActive={false} />
                  <Line type="monotone" dataKey="memory" stroke="var(--green-9)" dot={false} strokeWidth={2} name="显存 %" isAnimationActive={false} />
                  <Line type="monotone" dataKey="temp" stroke="var(--red-9)" dot={false} strokeWidth={2} name="温度 °C" isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            ) : chartTab === 'network' ? (
              <ResponsiveContainer width="100%" height={monitorChartHeight}>
                <AreaChart data={chartRenderData} margin={monitorChartMargin}>
                  <CartesianGrid vertical={false} strokeDasharray="3 3" opacity={0.3} />
                  <XAxis
                    dataKey="time"
                    type="number"
                    domain={monitorXAxisDomain}
                    tickFormatter={chartTimeFormatter}
                    fontSize={12}
                    minTickGap={28}
                    tickLine={false}
                    axisLine={false}
                  />
                  <YAxis {...wideYAxisProps} tickFormatter={(value) => formatSpeed(Number(value))} unit="" />
                  <Tooltip
                    {...chartTooltipProps}
                    labelFormatter={chartTimeFormatter}
                    formatter={(value: number, name) => [formatSpeed(Number(value)), name]}
                  />
                  <Area type="monotone" dataKey="net_in" stroke="var(--green-9)" fill="var(--green-3)" fillOpacity={0.32} dot={false} name="下载" isAnimationActive={false} />
                  <Area type="monotone" dataKey="net_out" stroke="var(--blue-9)" fill="var(--blue-3)" fillOpacity={0.32} dot={false} name="上传" isAnimationActive={false} />
                </AreaChart>
              </ResponsiveContainer>
            ) : chartTab === 'connections' ? (
              <ResponsiveContainer width="100%" height={monitorChartHeight}>
                <LineChart data={chartRenderData} margin={monitorChartMargin}>
                  <CartesianGrid vertical={false} strokeDasharray="3 3" opacity={0.3} />
                  <XAxis
                    dataKey="time"
                    type="number"
                    domain={monitorXAxisDomain}
                    tickFormatter={chartTimeFormatter}
                    fontSize={12}
                    minTickGap={28}
                    tickLine={false}
                    axisLine={false}
                  />
                  <YAxis {...wideYAxisProps} domain={['auto', 'auto']} allowDecimals={false} unit=" 个" />
                  <Tooltip
                    {...chartTooltipProps}
                    labelFormatter={chartTimeFormatter}
                    formatter={(value: number, name) => [Number(value).toFixed(0), name]}
                  />
                  <Line type="monotone" dataKey="connections" stroke="var(--accent-9)" dot={false} strokeWidth={2} name="TCP" isAnimationActive={false} />
                  <Line type="monotone" dataKey="connections_udp" stroke="var(--cyan-9)" dot={false} strokeWidth={2} name="UDP" isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            ) : chartTab === 'process' ? (
              <ResponsiveContainer width="100%" height={monitorChartHeight}>
                <LineChart data={chartRenderData} margin={monitorChartMargin}>
                  <CartesianGrid vertical={false} strokeDasharray="3 3" opacity={0.3} />
                  <XAxis
                    dataKey="time"
                    type="number"
                    domain={monitorXAxisDomain}
                    tickFormatter={chartTimeFormatter}
                    fontSize={12}
                    minTickGap={28}
                    tickLine={false}
                    axisLine={false}
                  />
                  <YAxis {...wideYAxisProps} domain={['auto', 'auto']} allowDecimals={false} unit=" 个" />
                  <Tooltip
                    {...chartTooltipProps}
                    labelFormatter={chartTimeFormatter}
                    formatter={(value: number) => [Number(value).toFixed(0), '进程数']}
                  />
                  <Line type="monotone" dataKey="process_count" stroke="var(--accent-9)" dot={false} strokeWidth={2} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <ResponsiveContainer width="100%" height={monitorChartHeight}>
                <LineChart data={chartRenderData} margin={monitorChartMargin}>
                  <CartesianGrid vertical={false} strokeDasharray="3 3" opacity={0.3} />
                  <XAxis
                    dataKey="time"
                    type="number"
                    domain={monitorXAxisDomain}
                    tickFormatter={chartTimeFormatter}
                    fontSize={12}
                    minTickGap={28}
                    tickLine={false}
                    axisLine={false}
                  />
                  <YAxis
                    {...monitorYAxisProps}
                    domain={chartTab === 'temp' ? ['auto', 'auto'] : [0, 100]}
                    tickFormatter={(value) => {
                      if (chartTab === 'temp') return `${Number(value).toFixed(0)}°C`;
                      return `${Number(value).toFixed(0)}%`;
                    }}
                  />
                  <Tooltip
                    {...chartTooltipProps}
                    labelFormatter={chartTimeFormatter}
                    formatter={(value: number) => {
                      if (chartTab === 'temp') return [`${Number(value).toFixed(1)} °C`, '温度'];
                      return [`${Number(value).toFixed(1)}%`, chartTab === 'cpu' ? 'CPU' : chartTab === 'ram' ? '内存' : '磁盘'];
                    }}
                  />
                  <Line type="monotone" dataKey={chartTab} stroke="var(--accent-9)" dot={chartTab === 'temp' || chartTab === 'disk' ? { r: 2 } : false} connectNulls={false} strokeWidth={2} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            )}
          </Box>
        </Tabs.Root>
      </Card>

      {/* Ping chart */}
      <div ref={pingSectionRef}>
      <Card mb="4">
        <Flex justify="between" align="center" mb="3" gap="3" wrap="wrap">
          <Text weight="bold">Ping 延迟</Text>
          {pingSeries.length > 0 && (
            <Text size="1" color="gray">
              {pingSeriesWithRecords.length} / {pingSeries.length} 个任务有记录
            </Text>
          )}
        </Flex>

        {pingLoading ? (
          <Loading />
        ) : pingError ? (
          <Text size="2" color="red" align="center" style={{ display: 'block', padding: '20px' }}>
            {pingError}
          </Text>
        ) : pingSeries.length === 0 ? (
          <Text size="2" color="gray" align="center" style={{ display: 'block', padding: '20px' }}>
            暂无 Ping 任务
          </Text>
        ) : pingChartRows.length === 0 || pingSeriesWithRecords.length === 0 ? (
          <Text size="2" color="gray" align="center" style={{ display: 'block', padding: '20px' }}>
            暂无该节点的 Ping 记录
          </Text>
        ) : (
          <>
            <ResponsiveContainer width="100%" height={pingChartHeight}>
              <LineChart data={pingChartRows} margin={monitorChartMargin}>
                <CartesianGrid vertical={false} strokeDasharray="3 3" opacity={0.3} />
                <XAxis
                  dataKey="time"
                  type="number"
                  domain={pingXAxisDomain}
                  tickFormatter={chartTimeFormatter}
                  fontSize={12}
                  minTickGap={28}
                  tickLine={false}
                  axisLine={false}
                />
                <YAxis
                  {...pingYAxisProps}
                  domain={pingYAxisDomain}
                  allowDecimals={false}
                  tick={<PingYAxisTick />}
                />
                <Tooltip
                  {...chartTooltipProps}
                  labelFormatter={chartTimeFormatter}
                  formatter={(value: number, name) => [
                    formatPingMs(value),
                    name,
                  ]}
                />
                {pingSeriesWithRecords.map((item) => (
                  <Line
                    key={item.task.key}
                    type="monotone"
                    dataKey={item.task.key}
                    name={item.task.label}
                    stroke={item.task.color}
                    strokeWidth={2.5}
                    dot={false}
                    connectNulls
                    isAnimationActive={false}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>

            <div className="instance-ping-series-grid">
              {pingSeriesWithRecords.map((item) => {
                const avg = getPingSeriesAverage(item.records);
                return (
                  <div
                    key={item.task.key}
                    className="instance-ping-series-item"
                    style={{
                      borderColor: item.task.color,
                      background: `color-mix(in srgb, ${item.task.color} 9%, var(--color-panel-solid))`,
                    }}
                    title={`${item.task.type} ${item.task.target}`}
                  >
                    <Flex align="center" gap="2" style={{ minWidth: 0 }}>
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
                      <Text size="1" weight="bold" truncate style={{ color: item.task.color }}>
                        {item.task.label}
                      </Text>
                    </Flex>
                    <Text size="1" color="gray" className="instance-ping-series-stat">
                      {avg === null ? '全部超时' : `平均 ${formatPingMs(avg)}`}
                    </Text>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </Card>
      </div>

        </section>
      </div>
    </div>
  );
}

function InstanceNodeSidebar({
  groups,
  activeUuid,
  onlineSet,
  statusReady,
  liveData,
  onSelect,
}: {
  groups: Array<{ group: string; nodes: ClientInfo[] }>;
  activeUuid: string;
  onlineSet: Set<string>;
  statusReady: boolean;
  liveData: Record<string, Partial<PublicMonitorRecord>>;
  onSelect: (uuid: string) => void;
}) {
  const total = groups.reduce((sum, group) => sum + group.nodes.length, 0);

  return (
    <aside className="instance-node-sidebar" aria-label="节点列表">
      <Card className="instance-node-sidebar-card">
        <Flex direction="column" style={{ height: '100%', minHeight: 0 }}>
          <Flex justify="between" align="center" className="instance-sidebar-header">
            <Box>
              <Text size="2" weight="bold" style={{ display: 'block' }}>节点列表</Text>
              <Text size="1" color="gray">{statusReady ? onlineSet.size : '—'} / {total} 在线</Text>
            </Box>
          </Flex>

          <Box className="instance-sidebar-scroll">
            {groups.map((group) => (
              <Box key={group.group}>
                <div className="instance-sidebar-group">
                  {group.group} ({group.nodes.length})
                </div>
                {group.nodes.map((node) => {
                  const isActive = node.uuid === activeUuid;
                  const isOnline = onlineSet.has(node.uuid);
                  const live = liveData[node.uuid];

                  return (
                    <button
                      key={node.uuid}
                      type="button"
                      className={`instance-sidebar-node${isActive ? ' is-active' : ''}`}
                      onClick={() => onSelect(node.uuid)}
                      title={node.name}
                    >
                      <span
                        className={`instance-sidebar-status${isOnline ? ' is-online' : statusReady ? ' is-offline' : ''}`}
                        aria-hidden="true"
                      />
                      <Flag region={node.region} size={16} />
                      <span className="instance-sidebar-node-main">
                        <span className="instance-sidebar-node-name">{node.name}</span>
                        <span className="instance-sidebar-node-meta">
                          {isOnline ? `CPU ${typeof live?.cpu === 'number' ? `${live.cpu.toFixed(0)}%` : '—'}` : statusReady ? '离线' : '确认中'}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </Box>
            ))}
          </Box>
        </Flex>
      </Card>
    </aside>
  );
}
