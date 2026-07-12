export * from './types';

import type { AppDatabase } from './provider';
import * as sba from './supabase-api/client';
import type * as t from './types';
import type { BackupData } from '../utils/backup';
import { redactDatabaseSecrets } from '../utils/setup-diagnostics';

export type QueryDatabase = AppDatabase;

function filterSettings(settings: Record<string, string>, keys: string[]): Record<string, string> {
  return Object.fromEntries(keys.flatMap(key => key in settings ? [[key, settings[key]]] : []));
}

export async function getClient(database: QueryDatabase, uuid: string): Promise<t.Client | null> {
  return sba.getSupabaseClient(database.env, uuid);
}

export async function clientExists(database: QueryDatabase, uuid: string): Promise<boolean> {
  return sba.supabaseClientExists(database.env, uuid);
}

export async function getClientTokenMeta(database: QueryDatabase, uuid: string): Promise<t.ClientTokenMeta | null> {
  return sba.getSupabaseClientTokenMeta(database.env, uuid);
}

export async function getClientsByIds(database: QueryDatabase, uuids: string[]): Promise<t.Client[]> {
  return sba.getSupabaseClientsByIds(database.env, uuids);
}

export async function getClientByToken(database: QueryDatabase, token: string, _fresh = false): Promise<t.Client | null> {
  return sba.getSupabaseClientByToken(database.env, token);
}

export async function getClientIdentityByToken(database: QueryDatabase, token: string, _fresh = false): Promise<t.ClientIdentity | null> {
  return sba.getSupabaseClientIdentityByToken(database.env, token);
}

export async function clientTokenExists(database: QueryDatabase, token: string): Promise<boolean> {
  return sba.supabaseClientTokenExists(database.env, token);
}

export async function getClientCreateConflict(database: QueryDatabase, uuid: string, token: string): Promise<'uuid' | 'token' | null> {
  return sba.getSupabaseClientCreateConflict(database.env, uuid, token);
}

export async function listClients(database: QueryDatabase, _fresh = false): Promise<t.Client[]> {
  return sba.getSupabaseAdminClients(database.env);
}

export async function countClientCapacityTargets(database: QueryDatabase): Promise<t.ClientCapacityCounts> {
  return sba.getSupabaseClientCapacityCounts(database.env);
}

export async function listPublicClientRows(database: QueryDatabase, _fresh = false): Promise<t.PublicClientRow[]> {
  return sba.getSupabasePublicClients(database.env);
}

export async function getClientVisibility(database: QueryDatabase, uuid: string): Promise<t.ClientVisibility | null> {
  return sba.getSupabaseClientVisibility(database.env, uuid);
}

export async function listScheduledClientRows(database: QueryDatabase): Promise<t.ScheduledClientRow[]> {
  return sba.listSupabaseScheduledClientRows(database.env);
}

export async function getScheduledClientRowsByIds(database: QueryDatabase, uuids: string[]): Promise<t.ScheduledClientRow[]> {
  return sba.getSupabaseScheduledClientRowsByIds(database.env, uuids);
}

export async function listClientIds(database: QueryDatabase): Promise<string[]> {
  return sba.getSupabaseClientIds(database.env);
}

export async function createClient(database: QueryDatabase, client: Partial<t.Client>): Promise<t.Client> {
  return sba.createSupabaseClient(database.env, client);
}

export async function updateClient(database: QueryDatabase, uuid: string, data: Partial<t.Client> | Record<string, unknown>): Promise<boolean> {
  return sba.updateSupabaseClient(database.env, uuid, data);
}

export async function updateClientAndReturn(database: QueryDatabase, uuid: string, data: Partial<t.Client> | Record<string, unknown>): Promise<t.Client | null> {
  return sba.updateSupabaseClientAndReturn(database.env, uuid, data);
}

export async function rotateClientToken(database: QueryDatabase, uuid: string, token: string): Promise<t.Client | null> {
  return sba.rotateSupabaseClientToken(database.env, uuid, token);
}

export async function markClientTokenUsed(database: QueryDatabase, uuid: string, ip = ''): Promise<boolean> {
  return sba.markSupabaseClientTokenUsed(database.env, uuid, ip);
}

export async function deleteClient(database: QueryDatabase, uuid: string): Promise<t.DeleteClientsResult> {
  return sba.deleteSupabaseClients(database.env, [uuid]);
}

export async function deleteClients(database: QueryDatabase, uuids: string[]): Promise<t.DeleteClientsResult> {
  return sba.deleteSupabaseClients(database.env, uuids);
}

export async function updateClientsHidden(database: QueryDatabase, uuids: string[], hidden: boolean): Promise<number> {
  return sba.updateSupabaseClientsHidden(database.env, uuids, hidden);
}

export async function reorderClients(database: QueryDatabase, orderedUuids: string[]): Promise<number> {
  return sba.reorderSupabaseClients(database.env, orderedUuids);
}

export async function countUsers(database: QueryDatabase): Promise<number> {
  return sba.countSupabaseUsers(database.env);
}

export async function createUser(
  database: QueryDatabase,
  user: { uuid: string; username: string; hashedPassword: string },
): Promise<boolean> {
  return sba.createSupabaseUser(database.env, user);
}

export async function deleteUserIfMatches(
  database: QueryDatabase,
  user: { uuid: string; username: string; hashedPassword: string },
): Promise<boolean> {
  return sba.deleteSupabaseUserIfMatches(database.env, user);
}

export async function recoverSingleAdmin(
  database: QueryDatabase,
  user: { uuid: string; username: string; hashedPassword: string },
): Promise<t.User> {
  return sba.recoverSupabaseSingleAdmin(database.env, user);
}

export async function getUserByUsername(database: QueryDatabase, username: string): Promise<t.User | null> {
  return sba.getSupabaseLoginUser(database.env, username);
}

export async function getUserByUuid(database: QueryDatabase, uuid: string): Promise<t.User | null> {
  return sba.getSupabaseUserByUuid(database.env, uuid);
}

export async function enableUserTotp(
  database: QueryDatabase,
  uuid: string,
  secretEnc: string,
  recoveryCodeHashes: string[],
  usedStep: number,
): Promise<t.User | null> {
  return sba.enableSupabaseUserTotp(database.env, uuid, secretEnc, recoveryCodeHashes, usedStep);
}

export async function disableUserTotp(database: QueryDatabase, uuid: string): Promise<t.User | null> {
  return sba.disableSupabaseUserTotp(database.env, uuid);
}

export async function replaceUserRecoveryCodes(
  database: QueryDatabase,
  uuid: string,
  recoveryCodeHashes: string[],
): Promise<t.User | null> {
  return sba.replaceSupabaseUserRecoveryCodes(database.env, uuid, recoveryCodeHashes);
}

export async function consumeTotpStep(database: QueryDatabase, uuid: string, step: number): Promise<boolean> {
  return sba.consumeSupabaseTotpStep(database.env, uuid, step);
}

export async function consumeRecoveryCode(database: QueryDatabase, uuid: string, codeHash: string): Promise<boolean> {
  return sba.consumeSupabaseRecoveryCode(database.env, uuid, codeHash);
}
export async function updateUserUsername(database: QueryDatabase, uuid: string, username: string): Promise<void> {
  return sba.updateSupabaseUserUsername(database.env, uuid, username);
}

export async function updateUserUsernameAndRotateSession(database: QueryDatabase, uuid: string, username: string): Promise<t.User | null> {
  return sba.updateSupabaseUserUsernameAndRotateSession(database.env, uuid, username);
}

export async function updateUserPassword(database: QueryDatabase, uuid: string, hashedPassword: string): Promise<void> {
  return sba.updateSupabaseUserPassword(database.env, uuid, hashedPassword);
}

export async function updateUserPasswordAndRotateSession(
  database: QueryDatabase,
  uuid: string,
  hashedPassword: string,
): Promise<t.User | null> {
  return sba.updateSupabaseUserPasswordAndRotateSession(database.env, uuid, hashedPassword);
}

export async function rotateUserSession(database: QueryDatabase, uuid: string): Promise<t.User | null> {
  return sba.rotateSupabaseUserSession(database.env, uuid);
}

export async function getLoginRateLimit(database: QueryDatabase, bucket: string): Promise<t.LoginRateLimit | null> {
  return sba.getSupabaseLoginRateLimit(database.env, bucket);
}

export async function getLoginRateLimitsByBuckets(database: QueryDatabase, buckets: string[]): Promise<Map<string, t.LoginRateLimit>> {
  const rows = await sba.getSupabaseLoginRateLimitsByBuckets(database.env, buckets);
  return new Map(rows.map(row => [row.bucket, row]));
}

export async function setLoginRateLimit(database: QueryDatabase, state: t.LoginRateLimit): Promise<void> {
  return sba.setSupabaseLoginRateLimit(database.env, state);
}

export async function setLoginRateLimits(database: QueryDatabase, states: t.LoginRateLimit[]): Promise<void> {
  return sba.setSupabaseLoginRateLimits(database.env, states);
}

export async function clearLoginRateLimit(database: QueryDatabase, bucket: string): Promise<void> {
  return sba.clearSupabaseLoginRateLimit(database.env, bucket);
}

export async function clearLoginRateLimits(database: QueryDatabase, buckets: string[]): Promise<void> {
  return sba.clearSupabaseLoginRateLimits(database.env, buckets);
}

export async function deleteLoginRateLimitsBefore(database: QueryDatabase, beforeTime: string): Promise<void> {
  return sba.deleteSupabaseLoginRateLimitsBefore(database.env, beforeTime);
}

export async function getSetting(database: QueryDatabase, key: string): Promise<string | null> {
  return (await sba.getSupabasePublicSettings(database.env))[key] ?? null;
}

export async function getSettingsByKeys(database: QueryDatabase, keys: string[], _fresh = false): Promise<Record<string, string>> {
  return filterSettings(await sba.getSupabasePublicSettings(database.env), keys);
}

export async function getRawSettingsByKeys(database: QueryDatabase, keys: string[]): Promise<Record<string, string>> {
  return filterSettings(await sba.getSupabasePublicSettings(database.env), keys);
}

export async function setSetting(database: QueryDatabase, key: string, value: string): Promise<void> {
  return sba.setSupabaseSettings(database.env, { [key]: value });
}

export async function setSettings(database: QueryDatabase, settings: Record<string, string>): Promise<void> {
  return sba.setSupabaseSettings(database.env, settings);
}

export async function getAllSettings(database: QueryDatabase, _fresh = false): Promise<Record<string, string>> {
  return sba.getSupabasePublicSettings(database.env);
}

export async function listThemes(database: QueryDatabase): Promise<t.Theme[]> {
  return sba.listSupabaseThemes(database.env);
}

export async function getTheme(database: QueryDatabase, short: string): Promise<t.Theme | null> {
  return sba.getSupabaseTheme(database.env, short);
}

export async function upsertTheme(
  database: QueryDatabase,
  theme: t.ThemeUpsertInput,
  assets: t.ThemeAssetUpsertInput[],
): Promise<void> {
  return sba.upsertSupabaseTheme(database.env, theme, assets);
}

export async function updateThemeSettings(
  database: QueryDatabase,
  short: string,
  configJson: string,
  customCss: string,
): Promise<boolean> {
  return sba.updateSupabaseThemeSettings(database.env, short, configJson, customCss);
}

export async function deleteTheme(database: QueryDatabase, short: string): Promise<boolean> {
  return sba.deleteSupabaseTheme(database.env, short);
}

export async function getThemeAsset(database: QueryDatabase, short: string, path: string): Promise<t.ThemeAsset | null> {
  return sba.getSupabaseThemeAsset(database.env, short, path);
}

export async function getPingTask(database: QueryDatabase, id: number): Promise<t.PingTask | null> {
  return sba.getSupabasePingTask(database.env, id);
}

export async function listPingTasks(database: QueryDatabase, _fresh = false): Promise<t.PingTask[]> {
  return sba.getSupabasePublicPingTasks(database.env);
}

export async function listPingTaskEstimateRows(database: QueryDatabase): Promise<t.PingTaskEstimateRow[]> {
  return sba.getSupabasePingTaskEstimateRows(database.env);
}

export async function createPingTask(database: QueryDatabase, task: t.PingTask): Promise<t.PingTask> {
  return sba.createSupabasePingTask(database.env, task);
}

export async function updatePingTaskAndReturn(database: QueryDatabase, id: number, task: Partial<t.PingTask>): Promise<t.PingTask | null> {
  return sba.updateSupabasePingTaskAndReturn(database.env, id, task);
}

export async function reorderPingTasks(database: QueryDatabase, orderedIds: number[]): Promise<number> {
  return sba.reorderSupabasePingTasks(database.env, orderedIds);
}

export async function deletePingTask(database: QueryDatabase, id: number): Promise<t.PingTask | null> {
  return sba.deleteSupabasePingTask(database.env, id);
}

export async function getWebsiteMonitor(database: QueryDatabase, id: number): Promise<t.WebsiteMonitor | null> {
  return sba.getSupabaseWebsiteMonitor(database.env, id);
}

export async function listWebsiteMonitors(database: QueryDatabase, _fresh = false): Promise<t.WebsiteMonitor[]> {
  return sba.listSupabaseWebsiteMonitors(database.env);
}

export async function listPublicWebsiteMonitors(database: QueryDatabase, checkLimit: number = 60, _fresh = false, periodHours = 24, includeHidden = false): Promise<t.PublicWebsiteMonitor[]> {
  return sba.getSupabasePublicWebsites(database.env, periodHours, checkLimit, includeHidden);
}

export async function getPublicWebsiteMonitorById(database: QueryDatabase, id: number, checkLimit: number = 120, includeHidden = false): Promise<t.PublicWebsiteMonitor | null> {
  return sba.getSupabasePublicWebsiteMonitorById(database.env, id, checkLimit, includeHidden);
}

export async function createWebsiteMonitor(database: QueryDatabase, monitor: t.WebsiteMonitorInput): Promise<t.WebsiteMonitor> {
  return sba.createSupabaseWebsiteMonitor(database.env, monitor);
}

export async function updateWebsiteMonitor(database: QueryDatabase, id: number, monitor: Partial<t.WebsiteMonitorInput>): Promise<boolean> {
  return sba.updateSupabaseWebsiteMonitor(database.env, id, monitor);
}

export async function updateWebsiteMonitorAndReturn(database: QueryDatabase, id: number, monitor: Partial<t.WebsiteMonitorInput>): Promise<t.WebsiteMonitor | null> {
  return sba.updateSupabaseWebsiteMonitorAndReturn(database.env, id, monitor);
}

export async function deleteWebsiteMonitor(database: QueryDatabase, id: number): Promise<void> {
  return sba.deleteSupabaseWebsiteMonitor(database.env, id);
}

export async function reorderWebsiteMonitors(database: QueryDatabase, orderedIds: number[]): Promise<number> {
  return sba.reorderSupabaseWebsiteMonitors(database.env, orderedIds);
}

export async function setWebsiteMonitorVisibility(database: QueryDatabase, id: number, hidden: boolean): Promise<boolean> {
  return sba.setSupabaseWebsiteMonitorVisibility(database.env, id, hidden);
}

export async function setWebsiteMonitorEnabled(database: QueryDatabase, id: number, enabled: boolean): Promise<boolean> {
  return sba.setSupabaseWebsiteMonitorEnabled(database.env, id, enabled);
}

export async function listDueWebsiteMonitors(database: QueryDatabase, now: string, limit: number = 50): Promise<t.WebsiteMonitor[]> {
  return sba.listSupabaseDueWebsiteMonitors(database.env, now, limit);
}

export async function recordWebsiteCheck(database: QueryDatabase, check: t.WebsiteCheckInput): Promise<t.WebsiteMonitor | null> {
  return sba.recordSupabaseWebsiteCheck(database.env, check);
}

export async function listAgentWebsiteProbeTasks(
  database: QueryDatabase,
  client: string,
  now: string,
  limit: number = 20,
): Promise<t.WebsiteMonitor[]> {
  return sba.listSupabaseAgentWebsiteProbeTasks(database.env, client, now, limit);
}

export async function listWebsiteChecks(database: QueryDatabase, monitorId: number, limit: number = 60): Promise<t.WebsiteCheck[]> {
  return sba.listSupabaseWebsiteChecks(database.env, monitorId, limit);
}

export async function markWebsiteMonitorNotified(database: QueryDatabase, id: number, time: string | null): Promise<boolean> {
  return sba.markSupabaseWebsiteMonitorNotified(database.env, id, time);
}

export async function insertRecord(database: QueryDatabase, record: t.MonitorRecord): Promise<void> {
  return sba.insertSupabaseMonitorRecord(database.env, record);
}

export async function getRecentRecords(database: QueryDatabase, client: string, limit: number = 30): Promise<t.MonitorRecord[]> {
  return sba.getSupabaseRecentRecords(database.env, client, limit);
}

export async function getRecordsByTimeRange(database: QueryDatabase, client: string, start: string, end: string): Promise<t.MonitorRecord[]> {
  return sba.getSupabaseRecordsByTimeRange(database.env, client, start, end);
}

export async function getRecordsByTimeRangeLimited(
  database: QueryDatabase,
  client: string,
  start: string,
  end: string,
  limit: number,
): Promise<t.MonitorRecord[]> {
  return sba.getSupabaseRecordsByTimeRangeLimited(database.env, client, start, end, limit);
}

export async function getRecordsByTimeRangePaged(
  database: QueryDatabase,
  client: string,
  start: string,
  end: string,
  page: number = 1,
  limit: number = 100,
): Promise<t.PagedResult<t.MonitorRecord>> {
  return sba.getSupabaseRecordsByTimeRangePaged(database.env, client, start, end, page, limit);
}

export async function getRecordsByTimeRangeCursor(
  database: QueryDatabase,
  client: string,
  start: string,
  end: string,
  cursor: string | undefined,
  limit: number = 100,
): Promise<t.PagedResult<t.MonitorRecord>> {
  return sba.getSupabaseRecordsByTimeRangeCursor(database.env, client, start, end, cursor, limit);
}

export async function getLatestRecordTimes(database: QueryDatabase): Promise<Array<{ client: string; last_time: string }>> {
  return sba.getSupabaseLatestRecordTimes(database.env);
}

export async function getLatestRecordTimesForClients(
  database: QueryDatabase,
  clients: string[],
): Promise<Array<{ client: string; last_time: string }>> {
  return sba.getSupabaseLatestRecordTimesForClients(database.env, clients);
}

export async function getLatestRecords(database: QueryDatabase): Promise<t.MonitorRecord[]> {
  return sba.getSupabaseLatestRecords(database.env);
}

export async function getGPURecords(database: QueryDatabase, client: string, start?: string, end?: string, limit: number = 100): Promise<t.GPUHistoryRecord[]> {
  return sba.getSupabaseGpuRecords(database.env, client, start, end, limit);
}

export async function getGPURecordsPaged(
  database: QueryDatabase,
  client: string,
  start?: string,
  end?: string,
  page: number = 1,
  limit: number = 100,
): Promise<t.PagedResult<t.GPUHistoryRecord>> {
  return sba.getSupabaseGpuRecordsPaged(database.env, client, start, end, page, limit);
}

export async function getGPURecordsCursor(
  database: QueryDatabase,
  client: string,
  start: string | undefined,
  end: string | undefined,
  cursor: string | undefined,
  limit: number = 100,
): Promise<t.PagedResult<t.GPUHistoryRecord>> {
  return sba.getSupabaseGpuRecordsCursor(database.env, client, start, end, cursor, limit);
}

export async function insertGPURecords(database: QueryDatabase, client: string, time: string, gpus: t.GPUInfo[]): Promise<void> {
  return sba.insertSupabaseGpuRecords(database.env, client, time, gpus);
}

export async function deleteOldRecords(
  database: QueryDatabase,
  beforeTime: string,
  options: t.DeleteOldRowsOptions = {},
): Promise<{ records: number; gpu_records: number; gpu_snapshots: number }> {
  return sba.deleteSupabaseOldRecords(database.env, beforeTime, options);
}

export async function deleteOldWebsiteChecks(
  database: QueryDatabase,
  beforeTime: string,
  options: t.DeleteOldRowsOptions = {},
): Promise<{ website_checks: number }> {
  return sba.deleteSupabaseOldWebsiteChecks(database.env, beforeTime, options);
}

export async function deleteOldPingRecords(
  database: QueryDatabase,
  beforeTime: string,
  options: t.DeleteOldRowsOptions = {},
): Promise<{ ping_records: number; ping_snapshots: number }> {
  return sba.deleteSupabaseOldPingRecords(database.env, beforeTime, options);
}

export async function clearAllRecords(
  database: QueryDatabase,
): Promise<t.ClearAllRecordsResult> {
  return sba.clearSupabaseAllRecords(database.env);
}

export async function clearClientRecords(database: QueryDatabase, client: string): Promise<void> {
  return sba.clearSupabaseClientRecords(database.env, client);
}

export async function insertPingSnapshot(database: QueryDatabase, client: string, time: string, results: t.PingSnapshotInput[]): Promise<void> {
  return sba.insertSupabasePingSnapshot(database.env, client, time, results);
}

export async function getPingRecords(database: QueryDatabase, client: string, taskId: number, limit: number = 120): Promise<t.PingHistoryRecord[]> {
  return sba.getSupabasePingRecords(database.env, client, taskId, limit);
}

export async function getPingRecordsForTasks(
  database: QueryDatabase,
  client: string,
  taskIds: number[] | t.PingTaskHistoryRequest[],
  limit: number = 120,
  _baseIntervalSec?: number,
  cursor?: string,
): Promise<Record<string, t.PingHistoryRecord[]>> {
  return sba.getSupabasePingRecordsForTasks(database.env, client, taskIds, limit, cursor);
}

export async function getPingRecordsPaged(
  database: QueryDatabase,
  client: string,
  taskId: number,
  page: number = 1,
  limit: number = 120,
): Promise<t.PagedResult<t.PingHistoryRecord>> {
  return sba.getSupabasePingRecordsPaged(database.env, client, taskId, page, limit);
}

export async function getPingRecordsCursor(
  database: QueryDatabase,
  client: string,
  taskId: number,
  cursor: string | undefined,
  limit: number = 120,
): Promise<t.PagedResult<t.PingHistoryRecord>> {
  return sba.getSupabasePingRecordsCursor(database.env, client, taskId, cursor, limit);
}

export async function getLoadMetricWindowStats(
  database: QueryDatabase,
  client: string,
  start: string,
  end: string,
  metric: t.LoadNotificationMetric,
  threshold: number,
): Promise<t.LoadMetricWindowStats> {
  const stats = await sba.getSupabaseLoadMetricWindowStatsForClients(database.env, [client], start, end, metric, threshold);
  return stats.get(client) || { samples: 0, exceeded: 0, avg_value: 0 };
}

export async function getLoadMetricWindowStatsForClients(
  database: QueryDatabase,
  clients: string[],
  start: string,
  end: string,
  metric: t.LoadNotificationMetric,
  threshold: number,
): Promise<Map<string, t.LoadMetricWindowStats>> {
  return sba.getSupabaseLoadMetricWindowStatsForClients(database.env, clients, start, end, metric, threshold);
}

export async function deleteOldAuditLogs(
  database: QueryDatabase,
  beforeTime: string,
  options: t.DeleteOldRowsOptions = {},
): Promise<{ audit_logs: number }> {
  return sba.deleteSupabaseOldAuditLogs(database.env, beforeTime, options);
}

export async function getStorageRowCounts(database: QueryDatabase): Promise<t.TableRowCounts> {
  return sba.getSupabaseStorageRowCounts(database.env);
}

export async function getBoundedStorageRowCounts(
  database: QueryDatabase,
  limit: number,
): Promise<t.BoundedTableRowCounts> {
  return sba.getSupabaseBoundedStorageRowCounts(database.env, limit);
}

export async function getHistoryStorageRowCounts(database: QueryDatabase): Promise<t.HistoryTableRowCounts> {
  return sba.getSupabaseHistoryStorageRowCounts(database.env);
}

export async function getExpiredRowCounts(
  database: QueryDatabase,
  beforeTimes: { records: string; ping_records: string; audit_logs: string },
): Promise<t.TableRowCounts> {
  return sba.getSupabaseExpiredRowCounts(database.env, beforeTimes);
}

export async function getOfflineNotification(database: QueryDatabase, client: string, _fresh = false): Promise<t.OfflineNotification | null> {
  return sba.getSupabaseOfflineNotification(database.env, client);
}

export async function listOfflineNotifications(database: QueryDatabase, _fresh = false): Promise<t.OfflineNotification[]> {
  return sba.listSupabaseOfflineNotifications(database.env);
}

export async function setOfflineNotification(database: QueryDatabase, client: string, enable: boolean, gracePeriod: number): Promise<boolean> {
  return (await sba.setSupabaseOfflineNotifications(database.env, [{ client, enable, grace_period: gracePeriod }])) > 0;
}

export async function setOfflineNotifications(database: QueryDatabase, items: t.OfflineNotificationUpdate[]): Promise<number> {
  return sba.setSupabaseOfflineNotifications(database.env, items);
}

export async function markOfflineNotificationSent(database: QueryDatabase, client: string, time: string | null): Promise<void> {
  return sba.markSupabaseOfflineNotificationSent(database.env, client, time);
}

export async function getExpiryNotification(database: QueryDatabase, client: string, _fresh = false): Promise<t.ExpiryNotification | null> {
  return sba.getSupabaseExpiryNotification(database.env, client);
}

export async function listExpiryNotifications(database: QueryDatabase, _fresh = false): Promise<t.ExpiryNotification[]> {
  return sba.listSupabaseExpiryNotifications(database.env);
}

export async function setExpiryNotification(database: QueryDatabase, client: string, enable: boolean, advanceDays: number): Promise<boolean> {
  return (await sba.setSupabaseExpiryNotifications(database.env, [{ client, enable, advance_days: advanceDays }])) > 0;
}

export async function setExpiryNotifications(database: QueryDatabase, items: t.ExpiryNotificationUpdate[]): Promise<number> {
  return sba.setSupabaseExpiryNotifications(database.env, items);
}

export async function markExpiryNotificationSent(database: QueryDatabase, client: string, time: string): Promise<void> {
  return sba.markSupabaseExpiryNotificationSent(database.env, client, time);
}

export async function listLoadNotifications(database: QueryDatabase, _fresh = false): Promise<t.LoadNotification[]> {
  return sba.listSupabaseLoadNotifications(database.env);
}

export async function getLoadNotification(database: QueryDatabase, id: number, _fresh = false): Promise<t.LoadNotification | null> {
  return sba.getSupabaseLoadNotification(database.env, id);
}

export async function createLoadNotification(database: QueryDatabase, data: t.LoadNotificationInput): Promise<void> {
  return sba.createSupabaseLoadNotification(database.env, data);
}

export async function updateLoadNotification(database: QueryDatabase, id: number, data: t.LoadNotificationInput): Promise<boolean> {
  return sba.updateSupabaseLoadNotification(database.env, id, data);
}

export async function deleteLoadNotification(database: QueryDatabase, id: number): Promise<void> {
  return sba.deleteSupabaseLoadNotification(database.env, id);
}

export async function pruneClientReferences(database: QueryDatabase, uuid: string): Promise<t.ClientReferenceCleanupResult> {
  return sba.pruneSupabaseClientReferences(database.env, uuid);
}

export async function pruneClientReferencesForClients(database: QueryDatabase, uuids: string[]): Promise<t.ClientReferenceCleanupResult> {
  return sba.pruneSupabaseClientReferencesForClients(database.env, uuids);
}

export async function cleanupOrphanClientData(database: QueryDatabase): Promise<t.OrphanClientDataCleanupResult> {
  return sba.cleanupSupabaseOrphanClientData(database.env);
}

export async function listAuditLogsPaged(
  database: QueryDatabase,
  page: number = 1,
  limit: number = 50,
): Promise<t.AuditLogsPage> {
  return sba.listSupabaseAuditLogsPaged(database.env, page, limit);
}

export async function restoreBackupData(database: QueryDatabase, backup: BackupData): Promise<void> {
  return sba.restoreSupabaseBackupData(database.env, backup);
}

export async function insertAuditLog(
  database: QueryDatabase,
  user: string,
  action: string,
  detail: string,
  level = 'info',
): Promise<void> {
  return sba.insertSupabaseAuditLog(database.env, user, action, redactDatabaseSecrets(detail), level);
}
