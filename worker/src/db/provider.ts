import { AsyncLocalStorage } from 'node:async_hooks';
import { isSupabaseApiConfigured, type SupabaseApiEnv } from './supabase-api/client';
import { redactDatabaseSecrets } from '../utils/setup-diagnostics';

export type DatabaseProvider = 'supabase-api';

export interface SupabaseApiAppDatabase {
  provider: 'supabase-api';
  env: SupabaseApiEnv;
}

export type AppDatabase = SupabaseApiAppDatabase;

export type DatabaseProviderEnv = SupabaseApiEnv;

export type DatabaseConfigurationErrorCode = 'missing_supabase_config';

export class DatabaseConfigurationError extends Error {
  readonly code: DatabaseConfigurationErrorCode;

  constructor(code: DatabaseConfigurationErrorCode, message: string) {
    super(redactDatabaseSecrets(message));
    this.code = code;
    this.name = 'DatabaseConfigurationError';
  }
}

const requestDb = new AsyncLocalStorage<AppDatabase>();

export function resolveDatabaseProvider(_env: DatabaseProviderEnv): DatabaseProvider {
  return 'supabase-api';
}

export function getDatabase(env: DatabaseProviderEnv): AppDatabase {
  const existing = requestDb.getStore();
  if (existing) return existing;
  if (!isSupabaseApiConfigured(env)) {
    throw new DatabaseConfigurationError(
      'missing_supabase_config',
      'SUPABASE_URL and SUPABASE_SECRET_KEY are required for Supabase HTTP API/RPC mode.',
    );
  }
  return { provider: 'supabase-api', env };
}

export async function withDatabase<T>(
  env: DatabaseProviderEnv,
  fn: (db: AppDatabase) => Promise<T>,
): Promise<T> {
  const database = getDatabase(env);
  return requestDb.run(database, () => fn(database));
}

export async function ensureDatabase(env: DatabaseProviderEnv): Promise<AppDatabase> {
  return getDatabase(env);
}
