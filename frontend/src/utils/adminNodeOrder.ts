import { arrayMove } from '@dnd-kit/sortable';
import type { ClientInfo } from '../types';

export function moveAdminNodeInVisibleOrder<T extends ClientInfo>(
  allClients: T[],
  visibleClients: T[],
  activeId: string,
  overId: string,
): T[] {
  const oldVisibleIndex = visibleClients.findIndex((client) => client.uuid === activeId);
  const newVisibleIndex = visibleClients.findIndex((client) => client.uuid === overId);
  if (oldVisibleIndex < 0 || newVisibleIndex < 0) return allClients;

  const movedVisible = arrayMove(visibleClients, oldVisibleIndex, newVisibleIndex);
  const byUuid = new Map(movedVisible.map((client) => [client.uuid, client]));
  let visibleIndex = 0;
  return allClients.map((client) => {
    if (!byUuid.has(client.uuid)) return client;
    return movedVisible[visibleIndex++];
  }).map((client, index) => ({ ...client, sort_order: index + 1 }));
}
