import { ClientInfo, LiveDataMap, LiveRecord } from '../types';
import { resolveFlagCode } from '../components/Flag';

export type OfflinePosition = 'first' | 'keep' | 'last';
export type NodeStatusFilter = 'all' | 'online' | 'offline';
export type AdminSortKey =
  | 'manual'
  | 'name'
  | 'status'
  | 'cpu'
  | 'memory'
  | 'disk'
  | 'network'
  | 'traffic';

export interface NodeStatsSummary {
  onlineCount: number;
  totalCount: number;
  regionCount: number;
  totalUp: number;
  totalDown: number;
  totalSpeedUp: number;
  totalSpeedDown: number;
}

export interface MonitorFilterOptions {
  searchTerm?: string;
  selectedGroup?: string;
  statusFilter?: NodeStatusFilter;
  offlinePosition?: OfflinePosition;
}

export interface AdminFilterOptions extends MonitorFilterOptions {
  sortKey?: AdminSortKey;
  sortDir?: 'asc' | 'desc';
}

export function normalizeLiveData(rawLiveData: any): LiveDataMap {
  if (!rawLiveData) return { online: [], data: {} };

  const online = [...(rawLiveData.online || [])] as string[];
  const data: Record<string, LiveRecord> = {};

  if (rawLiveData.data) {
    for (const [uuid, record] of Object.entries(rawLiveData.data)) {
      data[uuid] = record as LiveRecord;
    }
  }

  if (Array.isArray(rawLiveData.clients)) {
    for (const client of rawLiveData.clients) {
      const hasExplicitOnlineFlag = typeof client.online === 'boolean';
      if (client.uuid && !online.includes(client.uuid) && (!hasExplicitOnlineFlag || client.online)) {
        online.push(client.uuid);
      }

      if (client.uuid && !data[client.uuid]) {
        data[client.uuid] = client as LiveRecord;
      }
    }
  }

  return { online, data };
}

export function getNodeStatsSummary(
  clients: ClientInfo[],
  liveData: LiveDataMap,
): NodeStatsSummary {
  let totalUp = 0;
  let totalDown = 0;
  let totalSpeedUp = 0;
  let totalSpeedDown = 0;

  const onlineCount = clients.filter((client) =>
    liveData.online.includes(client.uuid),
  ).length;

  const regionSet = new Set(
    clients
      .filter((client) => liveData.online.includes(client.uuid) && client.region)
      .map((client) => resolveFlagCode(client.region))
      .filter((code) => code !== 'UN'),
  );

  for (const client of clients) {
    if (!liveData.online.includes(client.uuid)) continue;

    const record = liveData.data[client.uuid];
    if (!record) continue;

    totalUp += record.net_total_up || 0;
    totalDown += record.net_total_down || 0;
    totalSpeedUp += record.net_out || 0;
    totalSpeedDown += record.net_in || 0;
  }

  return {
    onlineCount,
    totalCount: clients.length,
    regionCount: regionSet.size,
    totalUp,
    totalDown,
    totalSpeedUp,
    totalSpeedDown,
  };
}

export function getNodeGroups(clients: ClientInfo[]): string[] {
  return Array.from(
    new Set(clients.map((client) => client.group?.trim()).filter(Boolean)),
  ).sort((a, b) => a.localeCompare(b));
}

export function filterMonitorNodes(
  clients: ClientInfo[],
  liveData: LiveDataMap,
  options: MonitorFilterOptions = {},
): ClientInfo[] {
  const {
    searchTerm = '',
    selectedGroup = 'all',
    statusFilter = 'all',
    offlinePosition = 'keep',
  } = options;

  const term = searchTerm.trim().toLowerCase();

  const filtered = clients.filter((client) => {
    const isOnline = liveData.online.includes(client.uuid);

    if (selectedGroup !== 'all' && client.group !== selectedGroup) {
      return false;
    }

    if (statusFilter === 'online' && !isOnline) {
      return false;
    }

    if (statusFilter === 'offline' && isOnline) {
      return false;
    }

    if (!term) return true;

    return [
      client.name,
      client.os,
      client.region,
      client.group,
      client.tags,
      client.public_remark || '',
    ]
      .join('\n')
      .toLowerCase()
      .includes(term);
  });

  return applyOfflinePosition(filtered, liveData, offlinePosition);
}

export function sortAdminNodes(
  clients: ClientInfo[],
  liveData: LiveDataMap,
  options: AdminFilterOptions = {},
): ClientInfo[] {
  const sortKey = options.sortKey || 'name';
  const sortDir = options.sortDir || 'asc';

  const sorted = [...filterMonitorNodes(clients, liveData, options)].sort((a, b) => {
    const aOnline = liveData.online.includes(a.uuid);
    const bOnline = liveData.online.includes(b.uuid);
    const aLive = liveData.data[a.uuid];
    const bLive = liveData.data[b.uuid];

    let comparison = 0;

    switch (sortKey) {
      case 'manual':
        comparison = getSortOrder(a) - getSortOrder(b);
        break;
      case 'name':
        comparison = (a.name || '').localeCompare(b.name || '');
        break;
      case 'status':
        comparison = Number(bOnline) - Number(aOnline);
        break;
      case 'cpu':
        comparison = (aLive?.cpu || 0) - (bLive?.cpu || 0);
        break;
      case 'memory':
        comparison = getUsagePercent(aLive?.ram || 0, a.mem_total) - getUsagePercent(bLive?.ram || 0, b.mem_total);
        break;
      case 'disk':
        comparison = getUsagePercent(aLive?.disk || 0, a.disk_total) - getUsagePercent(bLive?.disk || 0, b.disk_total);
        break;
      case 'network':
        comparison = ((aLive?.net_in || 0) + (aLive?.net_out || 0)) - ((bLive?.net_in || 0) + (bLive?.net_out || 0));
        break;
      case 'traffic':
        comparison = ((aLive?.net_total_up || 0) + (aLive?.net_total_down || 0)) - ((bLive?.net_total_up || 0) + (bLive?.net_total_down || 0));
        break;
      default:
        comparison = (a.name || '').localeCompare(b.name || '');
        break;
    }

    if (comparison === 0) {
      comparison = (a.name || '').localeCompare(b.name || '');
    }

    return sortDir === 'desc' ? -comparison : comparison;
  });

  return sorted;
}

function applyOfflinePosition(
  clients: ClientInfo[],
  liveData: LiveDataMap,
  offlinePosition: OfflinePosition,
): ClientInfo[] {
  if (offlinePosition === 'keep') return [...clients];

  return [...clients].sort((a, b) => {
    const aOnline = liveData.online.includes(a.uuid);
    const bOnline = liveData.online.includes(b.uuid);

    if (aOnline === bOnline) {
      return (a.name || '').localeCompare(b.name || '');
    }

    if (offlinePosition === 'first') {
      return aOnline ? 1 : -1;
    }

    return aOnline ? -1 : 1;
  });
}

function getUsagePercent(value: number, total: number): number {
  if (!total) return 0;
  return (value / total) * 100;
}

function getSortOrder(client: ClientInfo): number {
  return typeof client.sort_order === 'number' && Number.isFinite(client.sort_order)
    ? client.sort_order
    : Number.MAX_SAFE_INTEGER;
}
