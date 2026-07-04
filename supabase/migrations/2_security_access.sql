-- Source: 20260615001000_restrict_public_schema_privileges.sql
set local search_path = public;

do $$
declare
  role_name text;
begin
  revoke all on schema public from public;
  revoke all on all tables in schema public from public;
  revoke all on all sequences in schema public from public;
  revoke all on all functions in schema public from public;
  alter default privileges in schema public revoke all on tables from public;
  alter default privileges in schema public revoke all on sequences from public;
  alter default privileges in schema public revoke all on functions from public;

  foreach role_name in array array['anon', 'authenticated'] loop
    if to_regrole(role_name) is not null then
      execute format('revoke all on schema public from %I', role_name);
      execute format('revoke all on all tables in schema public from %I', role_name);
      execute format('revoke all on all sequences in schema public from %I', role_name);
      execute format('revoke all on all functions in schema public from %I', role_name);
      execute format('alter default privileges in schema public revoke all on tables from %I', role_name);
      execute format('alter default privileges in schema public revoke all on sequences from %I', role_name);
      execute format('alter default privileges in schema public revoke all on functions from %I', role_name);
    end if;
  end loop;
end $$;

insert into settings (key, value)
values ('schema_bootstrap_version', 'postgres-2026-06-15-v3')
on conflict (key) do update set value = excluded.value;

-- -----------------------------------------------------------------------------

-- Source: 20260616012923_add_worker_app_role.sql
set local search_path = public;

do $$
begin
  if to_regrole('cf_monitor_app') is null then
    create role cf_monitor_app nologin;
  end if;
end $$;

do $$
begin
  begin
    alter role cf_monitor_app nologin nosuperuser nobypassrls nocreaterole;
  exception
    when insufficient_privilege then
      null;
  end;
end $$;

grant usage on schema public to cf_monitor_app;
grant select, insert, update, delete on all tables in schema public to cf_monitor_app;
grant usage on all sequences in schema public to cf_monitor_app;
alter default privileges in schema public grant select, insert, update, delete on tables to cf_monitor_app;
alter default privileges in schema public grant usage on sequences to cf_monitor_app;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'clients',
    'records',
    'gpu_records',
    'gpu_snapshots',
    'users',
    'login_rate_limits',
    'settings',
    'ping_tasks',
    'ping_records',
    'ping_snapshots',
    'offline_notifications',
    'expiry_notifications',
    'load_notifications',
    'audit_logs'
  ] loop
    execute format('drop policy if exists cf_monitor_app_all on public.%I', table_name);
    execute format(
      'create policy cf_monitor_app_all on public.%I for all to cf_monitor_app using (true) with check (true)',
      table_name
    );
  end loop;
end $$;

insert into settings (key, value)
values ('schema_bootstrap_version', 'postgres-2026-06-15-v7')
on conflict (key) do update set value = excluded.value;

-- -----------------------------------------------------------------------------

-- Source: 20260616025513_force_rls_on_app_tables.sql
set local search_path = public;

alter table public.clients force row level security;
alter table public.records force row level security;
alter table public.gpu_records force row level security;
alter table public.gpu_snapshots force row level security;
alter table public.users force row level security;
alter table public.login_rate_limits force row level security;
alter table public.settings force row level security;
alter table public.ping_tasks force row level security;
alter table public.ping_records force row level security;
alter table public.ping_snapshots force row level security;
alter table public.offline_notifications force row level security;
alter table public.expiry_notifications force row level security;
alter table public.load_notifications force row level security;
alter table public.audit_logs force row level security;

insert into settings (key, value)
values ('schema_bootstrap_version', 'postgres-2026-06-15-v8')
on conflict (key) do update set value = excluded.value;

-- -----------------------------------------------------------------------------

-- Source: 20260616033821_rebuild_worker_app_policy.sql
set local search_path = public;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'clients',
    'records',
    'gpu_records',
    'gpu_snapshots',
    'users',
    'login_rate_limits',
    'settings',
    'ping_tasks',
    'ping_records',
    'ping_snapshots',
    'offline_notifications',
    'expiry_notifications',
    'load_notifications',
    'audit_logs'
  ] loop
    execute format('drop policy if exists cf_monitor_app_all on public.%I', table_name);
    execute format(
      'create policy cf_monitor_app_all on public.%I for all to cf_monitor_app using (true) with check (true)',
      table_name
    );
  end loop;
end $$;

insert into settings (key, value)
values ('schema_bootstrap_version', 'postgres-2026-06-15-v9')
on conflict (key) do update set value = excluded.value;

-- -----------------------------------------------------------------------------

-- Source: 20260616064651_revoke_supabase_admin_public_defaults.sql
set local search_path = public;

-- Supabase-managed default ACLs owned by supabase_admin are not mutable by
-- project-level migration roles. Runtime schema verification treats those
-- platform default ACLs as outside the application-owned schema contract while
-- still blocking public grants on actual application objects.

insert into settings (key, value)
values ('schema_bootstrap_version', 'postgres-2026-06-15-v10')
on conflict (key) do update set value = excluded.value;

-- -----------------------------------------------------------------------------

-- Source: 20260616224114_add_worker_login_role.sql
set local search_path = public;

do $$
begin
  if to_regrole('cf_monitor_worker') is null then
    create role cf_monitor_worker
      login
      inherit
      nosuperuser
      nocreatedb
      nocreaterole
      nobypassrls;
  end if;
end $$;

do $$
begin
  begin
    alter role cf_monitor_worker
      login
      inherit
      nosuperuser
      nocreatedb
      nocreaterole
      nobypassrls;
  exception
    when insufficient_privilege then
      null;
  end;
end $$;

grant cf_monitor_app to cf_monitor_worker;

insert into settings (key, value)
values ('schema_bootstrap_version', 'postgres-2026-06-15-v13')
on conflict (key) do update set value = excluded.value;
