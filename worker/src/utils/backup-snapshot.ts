import * as db from '../db/queries';
import { buildAdminSettings } from '../settings/schema';
import {
  BACKUP_EXCLUDED_MODULES,
  BACKUP_SCHEMA_ID,
  BACKUP_SCOPE,
  BACKUP_VERSION,
  validateBackup,
  websiteMonitorConfiguration,
  type BackupData,
} from './backup';

export async function buildBackupSnapshot(database: db.QueryDatabase): Promise<BackupData> {
  const snapshot = await db.getBackupConfigurationSnapshot(database);

  const backup: BackupData = {
    schema: BACKUP_SCHEMA_ID,
    version: BACKUP_VERSION,
    scope: BACKUP_SCOPE,
    timestamp: new Date().toISOString(),
    excluded: [...BACKUP_EXCLUDED_MODULES],
    sensitive: true,
    clients: snapshot.clients,
    settings: buildAdminSettings(snapshot.settings),
    ping_tasks: snapshot.ping_tasks,
    offline_notifications: snapshot.offline_notifications,
    expiry_notifications: snapshot.expiry_notifications,
    load_notifications: snapshot.load_notifications,
    website_monitors: snapshot.website_monitors.map(websiteMonitorConfiguration),
  };
  const validated = validateBackup(backup);
  if (!validated.ok) throw new Error(`备份配置校验失败，请修正配置后重试: ${validated.errors.join('；')}`);
  return validated.backup;
}
