import * as db from '../db/queries';
import { buildAdminSettings } from '../settings/schema';
import {
  BACKUP_EXCLUDED_MODULES,
  BACKUP_SCHEMA_ID,
  BACKUP_SCOPE,
  BACKUP_VERSION,
  type BackupData,
} from './backup';

export async function buildBackupSnapshot(database: db.QueryDatabase): Promise<BackupData> {
  const clients = await db.listClients(database);
  const settings = buildAdminSettings(await db.getAllSettings(database));
  const pingTasks = await db.listPingTasks(database);
  const offlineNotifications = await db.listOfflineNotifications(database);
  const expiryNotifications = await db.listExpiryNotifications(database);
  const loadNotifications = await db.listLoadNotifications(database);
  const websiteMonitors = await db.listWebsiteMonitors(database);

  return {
    schema: BACKUP_SCHEMA_ID,
    version: BACKUP_VERSION,
    scope: BACKUP_SCOPE,
    timestamp: new Date().toISOString(),
    excluded: [...BACKUP_EXCLUDED_MODULES],
    sensitive: true,
    clients,
    settings,
    ping_tasks: pingTasks,
    offline_notifications: offlineNotifications,
    expiry_notifications: expiryNotifications,
    load_notifications: loadNotifications,
    website_monitors: websiteMonitors,
  };
}
