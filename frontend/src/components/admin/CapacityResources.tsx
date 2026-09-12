import { Badge, Text } from '@radix-ui/themes';
import type { ResourceEstimate } from '../../../../worker/src/utils/capacity-estimate';

const labels: Record<ResourceEstimate['key'], string> = {
  worker_requests: 'Worker 请求',
  durable_object_requests: 'DO 请求',
  durable_object_rows_written: 'DO 存储写入',
  durable_object_rows_read: 'DO 存储读取',
  durable_object_duration_gb_seconds: 'DO 运行时长',
  supabase_storage_bytes: 'Supabase 历史存储',
  supabase_egress_bytes: 'Supabase 出站流量',
};

function amount(row: ResourceEstimate, value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '未知';
  if (row.key.endsWith('_bytes')) {
    if (value >= 1024 ** 3) return (value / 1024 ** 3).toFixed(2) + ' GB';
    if (value >= 1024 ** 2) return (value / 1024 ** 2).toFixed(1) + ' MB';
    return Math.ceil(value).toLocaleString() + ' B';
  }
  return Math.ceil(value).toLocaleString() + (row.key.endsWith('gb_seconds') ? ' GB·秒' : '');
}

function suffix(period: ResourceEstimate['period']): string {
  return period === 'day' ? '/天' : period === 'month' ? '/月' : '（保留期）';
}

function ScenarioUsage({ row, scenario }: { row: ResourceEstimate; scenario: 'websocket' | 'http' }) {
  const value = row[scenario];
  const exceeds = row[scenario === 'websocket' ? 'within_free_websocket' : 'within_free_http'] === false;
  const monthly = row[scenario === 'websocket' ? 'paid_usage_websocket' : 'paid_usage_http'];
  return <>
    <Badge color={value == null ? 'gray' : exceeds ? 'red' : 'blue'} variant="soft">
      {value != null && row.estimate === 'lower_bound' ? '≥ ' : ''}{amount(row, value)}{value == null ? '' : suffix(row.period)}
    </Badge>
    {row.period === 'day' && monthly != null && <Text as="div" size="1" color="gray">{amount(row, monthly)}/月</Text>}
  </>;
}

export default function CapacityResources({ resources, comparisonMonthDays }: { resources: ResourceEstimate[]; comparisonMonthDays: number }) {
  const exceeded = resources.some(row => row.within_free_websocket === false || row.within_free_http === false);
  return <section className="capacity-resources" aria-label="分项资源用量估算">
    <Text as="p" size="2" weight="bold">分项资源用量</Text>
    <Text as="p" size="1" color={exceeded ? 'red' : 'gray'}>
      {exceeded ? '部分场景已超过免费参考。' : '仍有未估项目，请核对平台实际用量。'}
      {' '}Worker、实时服务（DO）和 Supabase 分开计算；月度按 {comparisonMonthDays} 天比较。≥ 表示下限，未知不代表没有用量。
    </Text>
    <div style={{ overflowX: 'auto', maxWidth: '100%' }}>
      <table className="capacity-resource-table" aria-label="分项资源用量估算">
        <thead><tr><th>资源</th><th>WebSocket 场景</th><th>HTTP 场景</th><th>Free 参考</th><th>Paid / Pro 参考</th></tr></thead>
        <tbody>{resources.map(row => <tr key={row.key} data-resource={row.key}>
          <th scope="row">
            {labels[row.key]}
            <Text as="div" size="1" color="gray">{row.estimate === 'lower_bound' ? '下限' : row.estimate === 'unknown' ? '未估算' : '估算'}</Text>
            <details><summary>说明</summary><ul>{row.notes.map(note => <li key={note}>{note}</li>)}</ul></details>
          </th>
          <td><ScenarioUsage row={row} scenario="websocket" /></td>
          <td><ScenarioUsage row={row} scenario="http" /></td>
          <td>{amount(row, row.free_included)}{suffix(row.period)}</td>
          <td>{amount(row, row.paid_included)}{suffix(row.paid_period)}</td>
        </tr>)}</tbody>
      </table>
    </div>
  </section>;
}
