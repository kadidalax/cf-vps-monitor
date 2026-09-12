import { broadcastCrossTab, subscribeCrossTab } from './crossTabEvents';

export const WEBSITE_MONITORS_UPDATED_EVENT = 'cf-monitor:website-monitors-updated';

export type WebsiteMonitorsUpdateDetail = {
  upsert?: unknown[];
  remove?: number[];
  reorder?: number[];
};

export function notifyWebsiteMonitorsUpdated(_detail?: WebsiteMonitorsUpdateDetail | true) {
  // Callers can hold private administrator rows. Each tab reloads its own
  // authorized view; no administrator object belongs in public transport.
  broadcastCrossTab(WEBSITE_MONITORS_UPDATED_EVENT, true);
}

export function subscribeWebsiteMonitorsUpdated(
  callback: (detail?: WebsiteMonitorsUpdateDetail | true) => void,
) {
  return subscribeCrossTab(
    WEBSITE_MONITORS_UPDATED_EVENT,
    detail => callback(detail as WebsiteMonitorsUpdateDetail | true | undefined),
  );
}
