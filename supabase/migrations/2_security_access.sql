-- Source: 20260615001000_restrict_public_schema_privileges.sql
set local search_path = public;

-- 1_core_schema.sql restricts the named application tables and owned sequences.
-- RPC grants are restricted individually in 4_rpc_api.sql. Do not change shared
-- schema access, unrelated objects, or the owner's default privileges here.

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

do $$
declare
  table_name text;
  sequence_oid oid;
  sequence_table_name text;
  app_tables constant text[] := array[
    'clients', 'records', 'gpu_records', 'gpu_snapshots', 'users',
    'login_rate_limits', 'settings', 'themes', 'theme_assets', 'ping_tasks',
    'ping_records', 'ping_snapshots', 'website_monitors', 'website_checks',
    'offline_notifications', 'expiry_notifications', 'load_notifications', 'audit_logs'
  ];
begin
  foreach table_name in array app_tables loop
    execute format('grant select, insert, update, delete on table public.%I to cf_monitor_app, service_role', table_name);
    execute format('drop policy if exists cf_monitor_app_all on public.%I', table_name);
    execute format(
      'create policy cf_monitor_app_all on public.%I for all to cf_monitor_app using (true) with check (true)',
      table_name
    );
  end loop;
  for sequence_oid, sequence_table_name in
    select distinct sequence.oid, owner_table.relname
    from pg_class sequence
    join pg_depend dependency on dependency.objid = sequence.oid
      and dependency.classid = 'pg_class'::regclass
      and dependency.deptype in ('a', 'i')
    join pg_class owner_table on owner_table.oid = dependency.refobjid
    join pg_namespace namespace on namespace.oid = owner_table.relnamespace
    where sequence.relkind = 'S' and namespace.nspname = 'public'
      and owner_table.relname = any(app_tables)
  loop
    execute format('grant usage on sequence %s to cf_monitor_app, service_role', sequence_oid::regclass);
    if sequence_table_name = any(array['website_monitors', 'ping_tasks', 'load_notifications']) then
      -- Restore reserves explicit IDs with setval, which requires UPDATE rather
      -- than USAGE. Do not depend on the project owner's default sequence ACLs.
      execute format('grant update on sequence %s to service_role', sequence_oid::regclass);
    end if;
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
