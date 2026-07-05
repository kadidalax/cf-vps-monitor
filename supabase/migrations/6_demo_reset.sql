-- Source: 20260625070000_add_demo_reset.sql
create schema if not exists cfm_internal;

create table if not exists cfm_internal.demo_reset (
  key text primary key default 'default' check (key = 'default'),
  snapshot jsonb,
  last_restored_at timestamptz,
  updated_at timestamptz not null default now()
);

create or replace function public.cfm_demo_reset_state()
returns jsonb
language sql
security definer
set search_path = public, cfm_internal
as $$
  select jsonb_build_object(
    'snapshot_exists', snapshot is not null,
    'last_restored_at', last_restored_at
  )
  from cfm_internal.demo_reset
  where key = 'default';
$$;

create or replace function public.cfm_demo_snapshot()
returns jsonb
language sql
security definer
set search_path = public, cfm_internal
as $$
  select snapshot
  from cfm_internal.demo_reset
  where key = 'default';
$$;

create or replace function public.cfm_save_demo_snapshot(input_snapshot jsonb)
returns void
language plpgsql
security definer
set search_path = public, cfm_internal
as $$
begin
  if input_snapshot is null or jsonb_typeof(input_snapshot) <> 'object' then
    raise exception 'snapshot must be a JSON object';
  end if;

  insert into cfm_internal.demo_reset (key, snapshot, updated_at)
  values ('default', input_snapshot, now())
  on conflict (key) do update set
    snapshot = excluded.snapshot,
    updated_at = now();
end;
$$;

create or replace function public.cfm_mark_demo_reset_restored(input_restored_at text)
returns void
language sql
security definer
set search_path = public, cfm_internal
as $$
  insert into cfm_internal.demo_reset (key, last_restored_at, updated_at)
  values ('default', input_restored_at::timestamptz, now())
  on conflict (key) do update set
    last_restored_at = excluded.last_restored_at,
    updated_at = now();
$$;

create or replace function public.cfm_reset_admin_users(input_uuid text, input_username text, input_passwd text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if nullif(trim(input_uuid), '') is null
    or nullif(trim(input_username), '') is null
    or nullif(trim(input_passwd), '') is null then
    raise exception 'admin uuid, username, and password hash are required';
  end if;

  delete from login_rate_limits;
  delete from users;

  insert into users (uuid, username, passwd, session_version, password_changed_at)
  values (input_uuid, input_username, input_passwd, 1, now());
end;
$$;

create or replace function public.cfm_restore_demo_snapshot(input_backup jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  item jsonb;
  monitor_ids bigint[];
begin
  perform public.cfm_restore_backup_data(input_backup);

  if input_backup ? 'website_monitors' and jsonb_typeof(input_backup->'website_monitors') = 'array' then
    select coalesce(array_agg(id), array[]::bigint[]) into monitor_ids
    from (
      select (value->>'id')::bigint as id
      from jsonb_array_elements(input_backup->'website_monitors')
      where coalesce(value->>'id', '') ~ '^[0-9]+$'
        and (value->>'id')::bigint > 0
    ) rows;

    if coalesce(array_length(monitor_ids, 1), 0) > 0 then
      delete from website_checks where not (monitor_id = any(monitor_ids));
      delete from website_monitors where not (id = any(monitor_ids));
    else
      delete from website_monitors;
    end if;

    for item in select value from jsonb_array_elements(input_backup->'website_monitors')
    loop
      if not (coalesce(item->>'id', '') ~ '^[0-9]+$') or (item->>'id')::bigint <= 0 then
        continue;
      end if;

      insert into website_monitors (
        id, name, url, method, expected_status_min, expected_status_max,
        interval_sec, timeout_sec, grace_period_sec, enabled, hidden, sort_order,
        status, last_checked_at, last_success_at, last_failure_at, last_status_code,
        last_raw_status_code, last_latency_ms, last_effective_reason, last_error,
        down_since, last_notified_at, created_at, updated_at
      )
      values (
        (item->>'id')::bigint,
        coalesce(item->>'name', ''),
        coalesce(item->>'url', ''),
        coalesce(item->>'method', 'GET'),
        coalesce((item->>'expected_status_min')::integer, 200),
        coalesce((item->>'expected_status_max')::integer, 399),
        coalesce((item->>'interval_sec')::integer, 120),
        coalesce((item->>'timeout_sec')::integer, 10),
        coalesce((item->>'grace_period_sec')::integer, 180),
        coalesce((item->>'enabled')::boolean, true),
        coalesce((item->>'hidden')::boolean, false),
        coalesce((item->>'sort_order')::integer, 0),
        coalesce(item->>'status', 'pending'),
        nullif(item->>'last_checked_at', '')::timestamptz,
        nullif(item->>'last_success_at', '')::timestamptz,
        nullif(item->>'last_failure_at', '')::timestamptz,
        nullif(item->>'last_status_code', '')::integer,
        nullif(item->>'last_raw_status_code', '')::integer,
        nullif(item->>'last_latency_ms', '')::integer,
        nullif(item->>'last_effective_reason', ''),
        nullif(item->>'last_error', ''),
        nullif(item->>'down_since', '')::timestamptz,
        nullif(item->>'last_notified_at', '')::timestamptz,
        coalesce(nullif(item->>'created_at', '')::timestamptz, now()),
        coalesce(nullif(item->>'updated_at', '')::timestamptz, now())
      )
      on conflict (id) do update set
        name = excluded.name,
        url = excluded.url,
        method = excluded.method,
        expected_status_min = excluded.expected_status_min,
        expected_status_max = excluded.expected_status_max,
        interval_sec = excluded.interval_sec,
        timeout_sec = excluded.timeout_sec,
        grace_period_sec = excluded.grace_period_sec,
        enabled = excluded.enabled,
        hidden = excluded.hidden,
        sort_order = excluded.sort_order,
        status = excluded.status,
        last_checked_at = excluded.last_checked_at,
        last_success_at = excluded.last_success_at,
        last_failure_at = excluded.last_failure_at,
        last_status_code = excluded.last_status_code,
        last_raw_status_code = excluded.last_raw_status_code,
        last_latency_ms = excluded.last_latency_ms,
        last_effective_reason = excluded.last_effective_reason,
        last_error = excluded.last_error,
        down_since = excluded.down_since,
        last_notified_at = excluded.last_notified_at,
        updated_at = excluded.updated_at;
    end loop;

    perform setval(pg_get_serial_sequence('website_monitors', 'id'), coalesce((select max(id) from website_monitors), 0) + 1, false);
  end if;
end;
$$;

revoke all on function public.cfm_demo_reset_state() from public;
revoke all on function public.cfm_demo_reset_state() from anon;
revoke all on function public.cfm_demo_reset_state() from authenticated;
grant execute on function public.cfm_demo_reset_state() to service_role;

revoke all on function public.cfm_demo_snapshot() from public;
revoke all on function public.cfm_demo_snapshot() from anon;
revoke all on function public.cfm_demo_snapshot() from authenticated;
grant execute on function public.cfm_demo_snapshot() to service_role;

revoke all on function public.cfm_save_demo_snapshot(jsonb) from public;
revoke all on function public.cfm_save_demo_snapshot(jsonb) from anon;
revoke all on function public.cfm_save_demo_snapshot(jsonb) from authenticated;
grant execute on function public.cfm_save_demo_snapshot(jsonb) to service_role;

revoke all on function public.cfm_mark_demo_reset_restored(text) from public;
revoke all on function public.cfm_mark_demo_reset_restored(text) from anon;
revoke all on function public.cfm_mark_demo_reset_restored(text) from authenticated;
grant execute on function public.cfm_mark_demo_reset_restored(text) to service_role;

revoke all on function public.cfm_reset_admin_users(text, text, text) from public;
revoke all on function public.cfm_reset_admin_users(text, text, text) from anon;
revoke all on function public.cfm_reset_admin_users(text, text, text) from authenticated;
grant execute on function public.cfm_reset_admin_users(text, text, text) to service_role;

revoke all on function public.cfm_restore_demo_snapshot(jsonb) from public;
revoke all on function public.cfm_restore_demo_snapshot(jsonb) from anon;
revoke all on function public.cfm_restore_demo_snapshot(jsonb) from authenticated;
grant execute on function public.cfm_restore_demo_snapshot(jsonb) to service_role;

notify pgrst, 'reload schema';

-- -----------------------------------------------------------------------------

-- Source: 20260626020000_allow_demo_reset_safeupdate.sql
create or replace function public.cfm_reset_admin_users(input_uuid text, input_username text, input_passwd text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if nullif(trim(input_uuid), '') is null
    or nullif(trim(input_username), '') is null
    or nullif(trim(input_passwd), '') is null then
    raise exception 'admin uuid, username, and password hash are required';
  end if;

  delete from login_rate_limits where true;
  delete from users where true;

  insert into users (uuid, username, passwd, session_version, password_changed_at)
  values (input_uuid, input_username, input_passwd, 1, now());
end;
$$;

create or replace function public.cfm_restore_demo_snapshot(input_backup jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  item jsonb;
  monitor_ids bigint[];
begin
  perform public.cfm_restore_backup_data(input_backup);

  if input_backup ? 'website_monitors' and jsonb_typeof(input_backup->'website_monitors') = 'array' then
    select coalesce(array_agg(id), array[]::bigint[]) into monitor_ids
    from (
      select (value->>'id')::bigint as id
      from jsonb_array_elements(input_backup->'website_monitors')
      where coalesce(value->>'id', '') ~ '^[0-9]+$'
        and (value->>'id')::bigint > 0
    ) rows;

    if coalesce(array_length(monitor_ids, 1), 0) > 0 then
      delete from website_checks where not (monitor_id = any(monitor_ids));
      delete from website_monitors where not (id = any(monitor_ids));
    else
      delete from website_monitors where true;
    end if;

    for item in select value from jsonb_array_elements(input_backup->'website_monitors')
    loop
      if not (coalesce(item->>'id', '') ~ '^[0-9]+$') or (item->>'id')::bigint <= 0 then
        continue;
      end if;

      insert into website_monitors (
        id, name, url, method, expected_status_min, expected_status_max,
        interval_sec, timeout_sec, grace_period_sec, enabled, hidden, sort_order,
        status, last_checked_at, last_success_at, last_failure_at, last_status_code,
        last_raw_status_code, last_latency_ms, last_effective_reason, last_error,
        down_since, last_notified_at, created_at, updated_at
      )
      values (
        (item->>'id')::bigint,
        coalesce(item->>'name', ''),
        coalesce(item->>'url', ''),
        coalesce(item->>'method', 'GET'),
        coalesce((item->>'expected_status_min')::integer, 200),
        coalesce((item->>'expected_status_max')::integer, 399),
        coalesce((item->>'interval_sec')::integer, 120),
        coalesce((item->>'timeout_sec')::integer, 10),
        coalesce((item->>'grace_period_sec')::integer, 180),
        coalesce((item->>'enabled')::boolean, true),
        coalesce((item->>'hidden')::boolean, false),
        coalesce((item->>'sort_order')::integer, 0),
        coalesce(item->>'status', 'pending'),
        nullif(item->>'last_checked_at', '')::timestamptz,
        nullif(item->>'last_success_at', '')::timestamptz,
        nullif(item->>'last_failure_at', '')::timestamptz,
        nullif(item->>'last_status_code', '')::integer,
        nullif(item->>'last_raw_status_code', '')::integer,
        nullif(item->>'last_latency_ms', '')::integer,
        nullif(item->>'last_effective_reason', ''),
        nullif(item->>'last_error', ''),
        nullif(item->>'down_since', '')::timestamptz,
        nullif(item->>'last_notified_at', '')::timestamptz,
        coalesce(nullif(item->>'created_at', '')::timestamptz, now()),
        coalesce(nullif(item->>'updated_at', '')::timestamptz, now())
      )
      on conflict (id) do update set
        name = excluded.name,
        url = excluded.url,
        method = excluded.method,
        expected_status_min = excluded.expected_status_min,
        expected_status_max = excluded.expected_status_max,
        interval_sec = excluded.interval_sec,
        timeout_sec = excluded.timeout_sec,
        grace_period_sec = excluded.grace_period_sec,
        enabled = excluded.enabled,
        hidden = excluded.hidden,
        sort_order = excluded.sort_order,
        status = excluded.status,
        last_checked_at = excluded.last_checked_at,
        last_success_at = excluded.last_success_at,
        last_failure_at = excluded.last_failure_at,
        last_status_code = excluded.last_status_code,
        last_raw_status_code = excluded.last_raw_status_code,
        last_latency_ms = excluded.last_latency_ms,
        last_effective_reason = excluded.last_effective_reason,
        last_error = excluded.last_error,
        down_since = excluded.down_since,
        last_notified_at = excluded.last_notified_at,
        updated_at = excluded.updated_at;
    end loop;

    perform setval(pg_get_serial_sequence('website_monitors', 'id'), coalesce((select max(id) from website_monitors), 0) + 1, false);
  end if;
end;
$$;

revoke all on function public.cfm_reset_admin_users(text, text, text) from public;
revoke all on function public.cfm_reset_admin_users(text, text, text) from anon;
revoke all on function public.cfm_reset_admin_users(text, text, text) from authenticated;
grant execute on function public.cfm_reset_admin_users(text, text, text) to service_role;

revoke all on function public.cfm_restore_demo_snapshot(jsonb) from public;
revoke all on function public.cfm_restore_demo_snapshot(jsonb) from anon;
revoke all on function public.cfm_restore_demo_snapshot(jsonb) from authenticated;
grant execute on function public.cfm_restore_demo_snapshot(jsonb) to service_role;

notify pgrst, 'reload schema';

-- -----------------------------------------------------------------------------

-- Source: 20260626040000_fix_demo_reset_safeupdate_without_guc.sql
create or replace function public.cfm_clear_all_records()
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  deleted_records integer := 0;
  deleted_gpu_records integer := 0;
  deleted_gpu_snapshots integer := 0;
  deleted_ping_records integer := 0;
  deleted_ping_snapshots integer := 0;
begin
  with deleted as (delete from records where true returning 1)
  select count(*)::integer into deleted_records from deleted;

  with deleted as (delete from gpu_records where true returning 1)
  select count(*)::integer into deleted_gpu_records from deleted;

  with deleted as (delete from gpu_snapshots where true returning 1)
  select count(*)::integer into deleted_gpu_snapshots from deleted;

  with deleted as (delete from ping_records where true returning 1)
  select count(*)::integer into deleted_ping_records from deleted;

  with deleted as (delete from ping_snapshots where true returning 1)
  select count(*)::integer into deleted_ping_snapshots from deleted;

  return jsonb_build_object(
    'deleted', jsonb_build_object(
      'records', deleted_records,
      'gpu_records', deleted_gpu_records,
      'gpu_snapshots', deleted_gpu_snapshots,
      'ping_records', deleted_ping_records,
      'ping_snapshots', deleted_ping_snapshots
    ),
    'remaining', jsonb_build_object(
      'records', 0,
      'gpu_records', 0,
      'gpu_snapshots', 0,
      'ping_records', 0,
      'ping_snapshots', 0
    ),
    'has_more', false
  );
end;
$$;

create or replace function public.cfm_restore_backup_data(input_backup jsonb)
returns void
language plpgsql
set search_path = public
as $$
declare
  item jsonb;
  client_ids text[];
  task_ids bigint[];
begin
  if input_backup is null or jsonb_typeof(input_backup) <> 'object' then
    raise exception 'backup must be a JSON object';
  end if;

  if input_backup ? 'settings' and jsonb_typeof(input_backup->'settings') = 'object' then
    insert into settings (key, value)
    select key, value
    from jsonb_each_text(input_backup->'settings')
    where trim(key) <> ''
    on conflict (key) do update set value = excluded.value;
  end if;

  if input_backup ? 'clients' and jsonb_typeof(input_backup->'clients') = 'array' then
    select coalesce(array_agg(uuid), array[]::text[]) into client_ids
    from (
      select nullif(trim(value->>'uuid'), '') as uuid
      from jsonb_array_elements(input_backup->'clients')
    ) rows
    where uuid is not null;

    delete from records where not (client = any(client_ids));
    delete from gpu_records where not (client = any(client_ids));
    delete from gpu_snapshots where not (client = any(client_ids));
    delete from ping_records where not (client = any(client_ids));
    delete from ping_snapshots where not (client = any(client_ids));
    delete from offline_notifications where not (client = any(client_ids));
    delete from expiry_notifications where not (client = any(client_ids));
    delete from clients where not (uuid = any(client_ids));

    for item in select value from jsonb_array_elements(input_backup->'clients')
    loop
      if nullif(trim(item->>'uuid'), '') is null then
        continue;
      end if;

      insert into clients (
        uuid, token, token_hash, token_last_used_at, token_last_used_ip, token_rotated_at,
        name, cpu_name, virtualization, arch, cpu_cores, os, kernel_version, gpu_name,
        ipv4, ipv6, region, remark, public_remark, mem_total, swap_total, disk_total,
        version, price, billing_cycle, auto_renewal, currency, expired_at, "group", tags,
        hidden, traffic_limit, traffic_limit_type, sort_order, created_at, updated_at
      )
      values (
        item->>'uuid',
        nullif(item->>'token', ''),
        nullif(item->>'token_hash', ''),
        nullif(item->>'token_last_used_at', '')::timestamptz,
        coalesce(item->>'token_last_used_ip', ''),
        nullif(item->>'token_rotated_at', '')::timestamptz,
        coalesce(item->>'name', ''),
        coalesce(item->>'cpu_name', ''),
        coalesce(item->>'virtualization', ''),
        coalesce(item->>'arch', ''),
        coalesce((item->>'cpu_cores')::integer, 0),
        coalesce(item->>'os', ''),
        coalesce(item->>'kernel_version', ''),
        coalesce(item->>'gpu_name', ''),
        coalesce(item->>'ipv4', ''),
        coalesce(item->>'ipv6', ''),
        coalesce(item->>'region', ''),
        coalesce(item->>'remark', ''),
        coalesce(item->>'public_remark', ''),
        coalesce((item->>'mem_total')::bigint, 0),
        coalesce((item->>'swap_total')::bigint, 0),
        coalesce((item->>'disk_total')::bigint, 0),
        coalesce(item->>'version', ''),
        coalesce((item->>'price')::double precision, 0),
        coalesce((item->>'billing_cycle')::smallint, 0),
        case when coalesce((item->>'auto_renewal')::boolean, false) then 1 else 0 end,
        coalesce(item->>'currency', '$'),
        nullif(item->>'expired_at', '')::timestamptz,
        coalesce(item->>'group', ''),
        coalesce(item->>'tags', ''),
        case when coalesce((item->>'hidden')::boolean, false) then 1 else 0 end,
        coalesce((item->>'traffic_limit')::bigint, 0),
        coalesce(item->>'traffic_limit_type', 'max'),
        coalesce((item->>'sort_order')::integer, 0),
        coalesce(nullif(item->>'created_at', '')::timestamptz, now()),
        coalesce(nullif(item->>'updated_at', '')::timestamptz, now())
      )
      on conflict (uuid) do update set
        token = excluded.token,
        token_hash = excluded.token_hash,
        token_last_used_at = excluded.token_last_used_at,
        token_last_used_ip = excluded.token_last_used_ip,
        token_rotated_at = excluded.token_rotated_at,
        name = excluded.name,
        cpu_name = excluded.cpu_name,
        virtualization = excluded.virtualization,
        arch = excluded.arch,
        cpu_cores = excluded.cpu_cores,
        os = excluded.os,
        kernel_version = excluded.kernel_version,
        gpu_name = excluded.gpu_name,
        ipv4 = excluded.ipv4,
        ipv6 = excluded.ipv6,
        region = excluded.region,
        remark = excluded.remark,
        public_remark = excluded.public_remark,
        mem_total = excluded.mem_total,
        swap_total = excluded.swap_total,
        disk_total = excluded.disk_total,
        version = excluded.version,
        price = excluded.price,
        billing_cycle = excluded.billing_cycle,
        auto_renewal = excluded.auto_renewal,
        currency = excluded.currency,
        expired_at = excluded.expired_at,
        "group" = excluded."group",
        tags = excluded.tags,
        hidden = excluded.hidden,
        traffic_limit = excluded.traffic_limit,
        traffic_limit_type = excluded.traffic_limit_type,
        sort_order = excluded.sort_order,
        updated_at = now();
    end loop;
  end if;

  if input_backup ? 'ping_tasks' and jsonb_typeof(input_backup->'ping_tasks') = 'array' then
    select coalesce(array_agg(id), array[]::bigint[]) into task_ids
    from (
      select (value->>'id')::bigint as id
      from jsonb_array_elements(input_backup->'ping_tasks')
      where coalesce(value->>'id', '') ~ '^[0-9]+$'
        and (value->>'id')::bigint > 0
    ) rows;

    if coalesce(array_length(task_ids, 1), 0) > 0 then
      delete from ping_tasks where not (id = any(task_ids));
    else
      delete from ping_tasks where true;
    end if;

    for item in select value from jsonb_array_elements(input_backup->'ping_tasks')
    loop
      if coalesce(item->>'id', '') ~ '^[0-9]+$' and (item->>'id')::bigint > 0 then
        insert into ping_tasks (id, name, clients, all_clients, type, target, interval_sec, sort_order)
        values (
          (item->>'id')::bigint,
          coalesce(item->>'name', ''),
          case when jsonb_typeof(item->'clients') = 'array' then item->'clients' else '[]'::jsonb end,
          case when coalesce((item->>'all_clients')::boolean, false) then 1 else 0 end,
          coalesce(item->>'type', 'icmp'),
          coalesce(item->>'target', ''),
          coalesce((item->>'interval_sec')::integer, 120),
          coalesce((item->>'sort_order')::integer, (item->>'id')::integer)
        )
        on conflict (id) do update set
          name = excluded.name,
          clients = excluded.clients,
          all_clients = excluded.all_clients,
          type = excluded.type,
          target = excluded.target,
          interval_sec = excluded.interval_sec,
          sort_order = excluded.sort_order;
      else
        insert into ping_tasks (name, clients, all_clients, type, target, interval_sec, sort_order)
        values (
          coalesce(item->>'name', ''),
          case when jsonb_typeof(item->'clients') = 'array' then item->'clients' else '[]'::jsonb end,
          case when coalesce((item->>'all_clients')::boolean, false) then 1 else 0 end,
          coalesce(item->>'type', 'icmp'),
          coalesce(item->>'target', ''),
          coalesce((item->>'interval_sec')::integer, 120),
          coalesce((item->>'sort_order')::integer, 0)
        );
      end if;
    end loop;

    perform setval(pg_get_serial_sequence('ping_tasks', 'id'), coalesce((select max(id) from ping_tasks), 0) + 1, false);
  end if;

  if input_backup ? 'offline_notifications' and jsonb_typeof(input_backup->'offline_notifications') = 'array' then
    delete from offline_notifications where true;
    insert into offline_notifications (client, enable, grace_period, last_notified)
    select
      value->>'client',
      case when coalesce((value->>'enable')::boolean, false) then 1 else 0 end,
      coalesce((value->>'grace_period')::integer, 180),
      nullif(value->>'last_notified', '')::timestamptz
    from jsonb_array_elements(input_backup->'offline_notifications')
    where nullif(value->>'client', '') is not null;
  end if;

  if input_backup ? 'expiry_notifications' and jsonb_typeof(input_backup->'expiry_notifications') = 'array' then
    delete from expiry_notifications where true;
    insert into expiry_notifications (client, enable, advance_days, last_notified)
    select
      value->>'client',
      case when coalesce((value->>'enable')::boolean, false) then 1 else 0 end,
      coalesce((value->>'advance_days')::integer, 7),
      nullif(value->>'last_notified', '')::timestamptz
    from jsonb_array_elements(input_backup->'expiry_notifications')
    where nullif(value->>'client', '') is not null;
  end if;

  if input_backup ? 'load_notifications' and jsonb_typeof(input_backup->'load_notifications') = 'array' then
    delete from load_notifications where true;
    for item in select value from jsonb_array_elements(input_backup->'load_notifications')
    loop
      if coalesce(item->>'id', '') ~ '^[0-9]+$' and (item->>'id')::bigint > 0 then
        insert into load_notifications (id, name, clients, metric, threshold, ratio, interval_min, last_notified)
        values (
          (item->>'id')::bigint,
          coalesce(item->>'name', ''),
          case when jsonb_typeof(item->'clients') = 'array' then item->'clients' else '[]'::jsonb end,
          coalesce(item->>'metric', 'cpu'),
          coalesce((item->>'threshold')::double precision, 80),
          coalesce((item->>'ratio')::double precision, 0.8),
          coalesce((item->>'interval_min')::integer, 15),
          nullif(item->>'last_notified', '')::timestamptz
        );
      else
        insert into load_notifications (name, clients, metric, threshold, ratio, interval_min, last_notified)
        values (
          coalesce(item->>'name', ''),
          case when jsonb_typeof(item->'clients') = 'array' then item->'clients' else '[]'::jsonb end,
          coalesce(item->>'metric', 'cpu'),
          coalesce((item->>'threshold')::double precision, 80),
          coalesce((item->>'ratio')::double precision, 0.8),
          coalesce((item->>'interval_min')::integer, 15),
          nullif(item->>'last_notified', '')::timestamptz
        );
      end if;
    end loop;

    perform setval(pg_get_serial_sequence('load_notifications', 'id'), coalesce((select max(id) from load_notifications), 0) + 1, false);
  end if;
end;
$$;

create or replace function public.cfm_reset_admin_users(input_uuid text, input_username text, input_passwd text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if nullif(trim(input_uuid), '') is null
    or nullif(trim(input_username), '') is null
    or nullif(trim(input_passwd), '') is null then
    raise exception 'admin uuid, username, and password hash are required';
  end if;

  delete from login_rate_limits where true;
  delete from users where true;

  insert into users (uuid, username, passwd, session_version, password_changed_at)
  values (input_uuid, input_username, input_passwd, 1, now());
end;
$$;

create or replace function public.cfm_restore_demo_snapshot(input_backup jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  item jsonb;
  monitor_ids bigint[];
begin
  perform public.cfm_restore_backup_data(input_backup);

  if input_backup ? 'website_monitors' and jsonb_typeof(input_backup->'website_monitors') = 'array' then
    select coalesce(array_agg(id), array[]::bigint[]) into monitor_ids
    from (
      select (value->>'id')::bigint as id
      from jsonb_array_elements(input_backup->'website_monitors')
      where coalesce(value->>'id', '') ~ '^[0-9]+$'
        and (value->>'id')::bigint > 0
    ) rows;

    if coalesce(array_length(monitor_ids, 1), 0) > 0 then
      delete from website_checks where not (monitor_id = any(monitor_ids));
      delete from website_monitors where not (id = any(monitor_ids));
    else
      delete from website_monitors where true;
    end if;

    for item in select value from jsonb_array_elements(input_backup->'website_monitors')
    loop
      if not (coalesce(item->>'id', '') ~ '^[0-9]+$') or (item->>'id')::bigint <= 0 then
        continue;
      end if;

      insert into website_monitors (
        id, name, url, method, expected_status_min, expected_status_max,
        interval_sec, timeout_sec, grace_period_sec, enabled, hidden, sort_order,
        status, last_checked_at, last_success_at, last_failure_at, last_status_code,
        last_raw_status_code, last_latency_ms, last_effective_reason, last_error,
        down_since, last_notified_at, created_at, updated_at
      )
      values (
        (item->>'id')::bigint,
        coalesce(item->>'name', ''),
        coalesce(item->>'url', ''),
        coalesce(item->>'method', 'GET'),
        coalesce((item->>'expected_status_min')::integer, 200),
        coalesce((item->>'expected_status_max')::integer, 399),
        coalesce((item->>'interval_sec')::integer, 120),
        coalesce((item->>'timeout_sec')::integer, 10),
        coalesce((item->>'grace_period_sec')::integer, 180),
        coalesce((item->>'enabled')::boolean, true),
        coalesce((item->>'hidden')::boolean, false),
        coalesce((item->>'sort_order')::integer, 0),
        coalesce(item->>'status', 'pending'),
        nullif(item->>'last_checked_at', '')::timestamptz,
        nullif(item->>'last_success_at', '')::timestamptz,
        nullif(item->>'last_failure_at', '')::timestamptz,
        nullif(item->>'last_status_code', '')::integer,
        nullif(item->>'last_raw_status_code', '')::integer,
        nullif(item->>'last_latency_ms', '')::integer,
        nullif(item->>'last_effective_reason', ''),
        nullif(item->>'last_error', ''),
        nullif(item->>'down_since', '')::timestamptz,
        nullif(item->>'last_notified_at', '')::timestamptz,
        coalesce(nullif(item->>'created_at', '')::timestamptz, now()),
        coalesce(nullif(item->>'updated_at', '')::timestamptz, now())
      )
      on conflict (id) do update set
        name = excluded.name,
        url = excluded.url,
        method = excluded.method,
        expected_status_min = excluded.expected_status_min,
        expected_status_max = excluded.expected_status_max,
        interval_sec = excluded.interval_sec,
        timeout_sec = excluded.timeout_sec,
        grace_period_sec = excluded.grace_period_sec,
        enabled = excluded.enabled,
        hidden = excluded.hidden,
        sort_order = excluded.sort_order,
        status = excluded.status,
        last_checked_at = excluded.last_checked_at,
        last_success_at = excluded.last_success_at,
        last_failure_at = excluded.last_failure_at,
        last_status_code = excluded.last_status_code,
        last_raw_status_code = excluded.last_raw_status_code,
        last_latency_ms = excluded.last_latency_ms,
        last_effective_reason = excluded.last_effective_reason,
        last_error = excluded.last_error,
        down_since = excluded.down_since,
        last_notified_at = excluded.last_notified_at,
        updated_at = excluded.updated_at;
    end loop;

    perform setval(pg_get_serial_sequence('website_monitors', 'id'), coalesce((select max(id) from website_monitors), 0) + 1, false);
  end if;
end;
$$;

revoke all on function public.cfm_clear_all_records() from public;
revoke all on function public.cfm_clear_all_records() from anon;
revoke all on function public.cfm_clear_all_records() from authenticated;
grant execute on function public.cfm_clear_all_records() to service_role;

revoke all on function public.cfm_restore_backup_data(jsonb) from public;
revoke all on function public.cfm_restore_backup_data(jsonb) from anon;
revoke all on function public.cfm_restore_backup_data(jsonb) from authenticated;
grant execute on function public.cfm_restore_backup_data(jsonb) to service_role;

revoke all on function public.cfm_reset_admin_users(text, text, text) from public;
revoke all on function public.cfm_reset_admin_users(text, text, text) from anon;
revoke all on function public.cfm_reset_admin_users(text, text, text) from authenticated;
grant execute on function public.cfm_reset_admin_users(text, text, text) to service_role;

revoke all on function public.cfm_restore_demo_snapshot(jsonb) from public;
revoke all on function public.cfm_restore_demo_snapshot(jsonb) from anon;
revoke all on function public.cfm_restore_demo_snapshot(jsonb) from authenticated;
grant execute on function public.cfm_restore_demo_snapshot(jsonb) to service_role;

notify pgrst, 'reload schema';
