-- Source: 20260622010000_add_worker_data_api_phase1_rpc.sql
set local search_path = public;

-- Phase 1 Worker Data API RPC. These functions are called only by the Worker
-- with Supabase service_role; browsers still talk only to the Worker.

create or replace function public.cfm_public_settings()
returns jsonb
language sql
stable
set search_path = public
as $$
  select coalesce(jsonb_object_agg(key, value), '{}'::jsonb)
  from settings;
$$;

create or replace function public.cfm_set_settings(input_settings jsonb)
returns void
language plpgsql
set search_path = public
as $$
begin
  if input_settings is null or jsonb_typeof(input_settings) <> 'object' then
    raise exception 'input_settings must be a JSON object';
  end if;

  insert into settings (key, value)
  select key, value
  from jsonb_each_text(input_settings)
  on conflict (key) do update set value = excluded.value;
end;
$$;

create or replace function public.cfm_public_clients()
returns jsonb
language sql
stable
set search_path = public
as $$
  select coalesce(jsonb_agg(to_jsonb(row_data)), '[]'::jsonb)
  from (
    select
      uuid, name, cpu_name, virtualization, arch, cpu_cores, os,
      kernel_version, gpu_name, ipv4, ipv6, region, public_remark,
      mem_total, swap_total, disk_total, version, price, billing_cycle,
      auto_renewal, currency, expired_at, "group", tags, hidden,
      traffic_limit, traffic_limit_type, sort_order, created_at, updated_at
    from clients
    order by sort_order asc, lower(name) asc, created_at asc
  ) row_data;
$$;

create or replace function public.cfm_admin_clients()
returns jsonb
language sql
stable
set search_path = public
as $$
  select coalesce(jsonb_agg(to_jsonb(row_data)), '[]'::jsonb)
  from (
    select
      uuid, ''::text as token, ''::text as token_hash,
      token_last_used_at, token_last_used_ip, token_rotated_at,
      name, cpu_name, virtualization, arch, cpu_cores, os,
      kernel_version, gpu_name, ipv4, ipv6, region, remark, public_remark,
      mem_total, swap_total, disk_total, version, price, billing_cycle,
      auto_renewal, currency, expired_at, "group", tags, hidden,
      traffic_limit, traffic_limit_type, sort_order, created_at, updated_at
    from clients
    order by sort_order asc, lower(name) asc, created_at asc
  ) row_data;
$$;

create or replace function public.cfm_client_exists(input_uuid text)
returns boolean
language sql
stable
set search_path = public
as $$
  select exists (
    select 1
    from clients
    where uuid = input_uuid
    limit 1
  );
$$;

create or replace function public.cfm_client_visibility(input_uuid text)
returns jsonb
language sql
stable
set search_path = public
as $$
  select to_jsonb(row_data)
  from (
    select uuid, hidden
    from clients
    where uuid = input_uuid
    limit 1
  ) row_data;
$$;

create or replace function public.cfm_scheduled_clients()
returns jsonb
language sql
stable
set search_path = public
as $$
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'uuid', uuid,
      'name', name,
      'created_at', created_at,
      'expired_at', expired_at
    )
    order by sort_order asc, lower(name) asc, created_at asc
  ), '[]'::jsonb)
  from (
    select uuid, name, created_at, expired_at, sort_order
    from clients
  ) row_data;
$$;

create or replace function public.cfm_scheduled_clients_by_ids(input_uuids jsonb)
returns jsonb
language sql
stable
set search_path = public
as $$
  with ids as (
    select distinct on (uuid) uuid, ord
    from jsonb_array_elements_text(coalesce(input_uuids, '[]'::jsonb)) with ordinality as item(uuid, ord)
    where trim(uuid) <> ''
    order by uuid, ord
  )
  select coalesce(jsonb_agg(to_jsonb(row_data) order by ids.ord), '[]'::jsonb)
  from ids
  join lateral (
    select uuid, name, created_at, expired_at
    from clients
    where clients.uuid = ids.uuid
  ) row_data on true;
$$;

create or replace function public.cfm_client(input_uuid text)
returns jsonb
language sql
stable
set search_path = public
as $$
  select to_jsonb(row_data)
  from (
    select *
    from clients
    where uuid = input_uuid
    limit 1
  ) row_data;
$$;

create or replace function public.cfm_client_token_meta(input_uuid text)
returns jsonb
language sql
stable
set search_path = public
as $$
  select to_jsonb(row_data)
  from (
    select uuid, coalesce(token, '') as token, coalesce(token_hash, '') as token_hash, name
    from clients
    where uuid = input_uuid
    limit 1
  ) row_data;
$$;

create or replace function public.cfm_clients_by_ids(input_uuids jsonb)
returns jsonb
language sql
stable
set search_path = public
as $$
  with ids as (
    select distinct on (uuid) uuid, ord
    from jsonb_array_elements_text(coalesce(input_uuids, '[]'::jsonb)) with ordinality as item(uuid, ord)
    where trim(uuid) <> ''
    order by uuid, ord
  )
  select coalesce(jsonb_agg(to_jsonb(c) order by ids.ord), '[]'::jsonb)
  from ids
  join clients c on c.uuid = ids.uuid;
$$;

create or replace function public.cfm_client_ids()
returns jsonb
language sql
stable
set search_path = public
as $$
  select coalesce(jsonb_agg(uuid), '[]'::jsonb)
  from clients;
$$;

create or replace function public.cfm_agent_client_by_token(input_token_hash text, input_token text default '')
returns jsonb
language sql
stable
set search_path = public
as $$
  select to_jsonb(row_data)
  from (
    select *
    from clients
    where token_hash = input_token_hash
       or (coalesce(input_token, '') <> '' and token = input_token)
    limit 1
  ) row_data;
$$;

create or replace function public.cfm_client_token_exists(input_token_hash text, input_token text default '')
returns boolean
language sql
stable
set search_path = public
as $$
  select exists (
    select 1
    from clients
    where token_hash = input_token_hash
       or (coalesce(input_token, '') <> '' and token = input_token)
    limit 1
  );
$$;

create or replace function public.cfm_client_create_conflict(input_uuid text, input_token_hash text, input_token text default '')
returns text
language sql
stable
set search_path = public
as $$
  select case
    when exists (select 1 from clients where uuid = input_uuid) then 'uuid'
    when exists (
      select 1
      from clients
      where token_hash = input_token_hash
         or (coalesce(input_token, '') <> '' and token = input_token)
    ) then 'token'
    else null
  end;
$$;

create or replace function public.cfm_create_client(input_client jsonb)
returns jsonb
language sql
set search_path = public
as $$
  insert into clients (uuid, token, token_hash, token_rotated_at, name, sort_order)
  values (
    coalesce(nullif(input_client->>'uuid', ''), gen_random_uuid()::text),
    input_client->>'token',
    input_client->>'token_hash',
    now(),
    coalesce(input_client->>'name', ''),
    coalesce((input_client->>'sort_order')::integer, (select coalesce(max(sort_order), 0) + 1 from clients))
  )
  returning to_jsonb(clients);
$$;

create or replace function public.cfm_agent_client_identity_by_token(input_token_hash text, input_token text default '')
returns jsonb
language sql
stable
set search_path = public
as $$
  select to_jsonb(row_data)
  from (
    select uuid, coalesce(token, '') as token, token_last_used_ip, token_rotated_at, created_at, name, hidden
    from clients
    where token_hash = input_token_hash
       or (coalesce(input_token, '') <> '' and token = input_token)
    limit 1
  ) row_data;
$$;

create or replace function public.cfm_mark_client_token_used(input_uuid text, input_ip text default '')
returns boolean
language plpgsql
set search_path = public
as $$
declare
  updated_count integer;
  normalized_ip text := left(coalesce(trim(input_ip), ''), 128);
begin
  update clients
  set token_last_used_at = now(),
      token_last_used_ip = case when normalized_ip <> '' then normalized_ip else token_last_used_ip end
  where uuid = input_uuid
    and (
      token_last_used_at is null
      or token_last_used_at < now() - interval '15 minutes'
    );
  get diagnostics updated_count = row_count;
  return updated_count > 0;
end;
$$;

create or replace function public.cfm_rotate_client_token(input_uuid text, input_token text, input_token_hash text)
returns jsonb
language sql
set search_path = public
as $$
  update clients
  set token = input_token,
      token_hash = input_token_hash,
      token_last_used_at = null,
      token_last_used_ip = '',
      token_rotated_at = now(),
      updated_at = now()
  where uuid = input_uuid
  returning to_jsonb(clients);
$$;

create or replace function public.cfm_update_client_returning(input_uuid text, input_patch jsonb)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  row_data clients%rowtype;
begin
  if input_patch is null or jsonb_typeof(input_patch) <> 'object' then
    return null;
  end if;

  update clients
  set
    name = case when input_patch ? 'name' then coalesce(input_patch->>'name', '') else name end,
    cpu_name = case when input_patch ? 'cpu_name' then coalesce(input_patch->>'cpu_name', '') else cpu_name end,
    virtualization = case when input_patch ? 'virtualization' then coalesce(input_patch->>'virtualization', '') else virtualization end,
    arch = case when input_patch ? 'arch' then coalesce(input_patch->>'arch', '') else arch end,
    cpu_cores = case when input_patch ? 'cpu_cores' then coalesce((input_patch->>'cpu_cores')::integer, 0) else cpu_cores end,
    os = case when input_patch ? 'os' then coalesce(input_patch->>'os', '') else os end,
    kernel_version = case when input_patch ? 'kernel_version' then coalesce(input_patch->>'kernel_version', '') else kernel_version end,
    gpu_name = case when input_patch ? 'gpu_name' then coalesce(input_patch->>'gpu_name', '') else gpu_name end,
    ipv4 = case when input_patch ? 'ipv4' then coalesce(input_patch->>'ipv4', '') else ipv4 end,
    ipv6 = case when input_patch ? 'ipv6' then coalesce(input_patch->>'ipv6', '') else ipv6 end,
    region = case when input_patch ? 'region' then coalesce(input_patch->>'region', '') else region end,
    remark = case when input_patch ? 'remark' then coalesce(input_patch->>'remark', '') else remark end,
    public_remark = case when input_patch ? 'public_remark' then coalesce(input_patch->>'public_remark', '') else public_remark end,
    mem_total = case when input_patch ? 'mem_total' then coalesce((input_patch->>'mem_total')::double precision, 0) else mem_total end,
    swap_total = case when input_patch ? 'swap_total' then coalesce((input_patch->>'swap_total')::double precision, 0) else swap_total end,
    disk_total = case when input_patch ? 'disk_total' then coalesce((input_patch->>'disk_total')::double precision, 0) else disk_total end,
    version = case when input_patch ? 'version' then coalesce(input_patch->>'version', '') else version end,
    price = case when input_patch ? 'price' then coalesce((input_patch->>'price')::double precision, 0) else price end,
    billing_cycle = case when input_patch ? 'billing_cycle' then coalesce((input_patch->>'billing_cycle')::smallint, 0) else billing_cycle end,
    auto_renewal = case when input_patch ? 'auto_renewal' then case when lower(coalesce(input_patch->>'auto_renewal', '')) in ('true', '1') then 1 else 0 end else auto_renewal end,
    currency = case when input_patch ? 'currency' then coalesce(input_patch->>'currency', '$') else currency end,
    expired_at = case when input_patch ? 'expired_at' then nullif(input_patch->>'expired_at', '')::timestamptz else expired_at end,
    "group" = case when input_patch ? 'group' then coalesce(input_patch->>'group', '') else "group" end,
    tags = case when input_patch ? 'tags' then coalesce(input_patch->>'tags', '') else tags end,
    hidden = case when input_patch ? 'hidden' then case when lower(coalesce(input_patch->>'hidden', '')) in ('true', '1') then 1 else 0 end else hidden end,
    traffic_limit = case when input_patch ? 'traffic_limit' then coalesce((input_patch->>'traffic_limit')::bigint, 0) else traffic_limit end,
    traffic_limit_type = case when input_patch ? 'traffic_limit_type' then coalesce(input_patch->>'traffic_limit_type', 'max') else traffic_limit_type end,
    sort_order = case when input_patch ? 'sort_order' then coalesce((input_patch->>'sort_order')::integer, 0) else sort_order end,
    updated_at = now()
  where uuid = input_uuid
  returning * into row_data;

  if not found then
    return null;
  end if;
  return to_jsonb(row_data);
end;
$$;

create or replace function public.cfm_update_client(input_uuid text, input_patch jsonb)
returns boolean
language sql
set search_path = public
as $$
  select public.cfm_update_client_returning(input_uuid, input_patch) is not null;
$$;

create or replace function public.cfm_delete_clients(input_uuids jsonb)
returns jsonb
language sql
set search_path = public
as $$
  with
    ids as (
      select distinct uuid
      from jsonb_array_elements_text(coalesce(input_uuids, '[]'::jsonb)) as item(uuid)
      where trim(uuid) <> ''
    ),
    deleted_records as (delete from records where client in (select uuid from ids) returning 1),
    deleted_gpu_records as (delete from gpu_records where client in (select uuid from ids) returning 1),
    deleted_gpu_snapshots as (delete from gpu_snapshots where client in (select uuid from ids) returning 1),
    deleted_ping_records as (delete from ping_records where client in (select uuid from ids) returning 1),
    deleted_ping_snapshots as (delete from ping_snapshots where client in (select uuid from ids) returning 1),
    deleted_clients as (delete from clients where uuid in (select uuid from ids) returning 1)
  select jsonb_build_object(
    'removed', (select count(*) from deleted_clients),
    'deleted_records', jsonb_build_object(
      'records', (select count(*) from deleted_records),
      'gpu_records', (select count(*) from deleted_gpu_records),
      'gpu_snapshots', (select count(*) from deleted_gpu_snapshots),
      'ping_records', (select count(*) from deleted_ping_records),
      'ping_snapshots', (select count(*) from deleted_ping_snapshots)
    )
  );
$$;

create or replace function public.cfm_prune_client_references(input_uuids jsonb)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  remove_ids text[] := '{}';
  ping_tasks_updated integer := 0;
  load_notifications_updated integer := 0;
  load_notifications_deleted integer := 0;
  expiry_notifications_deleted integer := 0;
begin
  select coalesce(array_agg(distinct trim(uuid)), '{}')
  into remove_ids
  from jsonb_array_elements_text(coalesce(input_uuids, '[]'::jsonb)) as item(uuid)
  where trim(uuid) <> '';

  if array_length(remove_ids, 1) is null then
    return jsonb_build_object(
      'ping_tasks_updated', 0,
      'load_notifications_updated', 0,
      'load_notifications_deleted', 0,
      'expiry_notifications_deleted', 0
    );
  end if;

  with candidates as (
    select p.id,
      (
        select coalesce(jsonb_agg(client), '[]'::jsonb)
        from jsonb_array_elements_text(p.clients) as item(client)
        where not (client = any(remove_ids))
      ) as next_clients
    from ping_tasks p
    where p.all_clients = 0
      and exists (
        select 1
        from jsonb_array_elements_text(p.clients) as item(client)
        where client = any(remove_ids)
      )
  ), updated as (
    update ping_tasks p
    set clients = candidates.next_clients
    from candidates
    where p.id = candidates.id
      and p.clients is distinct from candidates.next_clients
    returning 1
  )
  select count(*)::integer into ping_tasks_updated from updated;

  with candidates as (
    select l.id,
      (
        select coalesce(jsonb_agg(client), '[]'::jsonb)
        from jsonb_array_elements_text(l.clients) as item(client)
        where not (client = any(remove_ids))
      ) as next_clients
    from load_notifications l
    where exists (
      select 1
      from jsonb_array_elements_text(l.clients) as item(client)
      where client = any(remove_ids)
    )
  ), deleted as (
    delete from load_notifications l
    using candidates
    where l.id = candidates.id
      and jsonb_array_length(candidates.next_clients) = 0
    returning 1
  )
  select count(*)::integer into load_notifications_deleted from deleted;

  with candidates as (
    select l.id,
      (
        select coalesce(jsonb_agg(client), '[]'::jsonb)
        from jsonb_array_elements_text(l.clients) as item(client)
        where not (client = any(remove_ids))
      ) as next_clients
    from load_notifications l
    where exists (
      select 1
      from jsonb_array_elements_text(l.clients) as item(client)
      where client = any(remove_ids)
    )
  ), updated as (
    update load_notifications l
    set clients = candidates.next_clients
    from candidates
    where l.id = candidates.id
      and jsonb_array_length(candidates.next_clients) > 0
      and l.clients is distinct from candidates.next_clients
    returning 1
  )
  select count(*)::integer into load_notifications_updated from updated;

  delete from expiry_notifications
  where client = any(remove_ids);
  get diagnostics expiry_notifications_deleted = row_count;

  return jsonb_build_object(
    'ping_tasks_updated', ping_tasks_updated,
    'load_notifications_updated', load_notifications_updated,
    'load_notifications_deleted', load_notifications_deleted,
    'expiry_notifications_deleted', expiry_notifications_deleted
  );
end;
$$;

create or replace function public.cfm_cleanup_orphan_client_data()
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  ping_tasks_updated integer := 0;
  load_notifications_updated integer := 0;
  load_notifications_deleted integer := 0;
  offline_notifications_deleted integer := 0;
  expiry_notifications_deleted integer := 0;
  records_deleted integer := 0;
  gpu_records_deleted integer := 0;
  gpu_snapshots_deleted integer := 0;
  ping_records_deleted integer := 0;
  ping_snapshots_deleted integer := 0;
begin
  with candidates as (
    select p.id,
      (
        select coalesce(jsonb_agg(client), '[]'::jsonb)
        from jsonb_array_elements_text(p.clients) as item(client)
        where exists (select 1 from clients c where c.uuid = client)
      ) as next_clients
    from ping_tasks p
    where p.all_clients = 0
  ), changed as (
    select id, next_clients
    from candidates
    where (select count(*) from jsonb_array_elements_text(next_clients)) is distinct from (
      select count(*) from jsonb_array_elements_text((select clients from ping_tasks where ping_tasks.id = candidates.id))
    )
  ), updated as (
    update ping_tasks p
    set clients = changed.next_clients
    from changed
    where p.id = changed.id
    returning 1
  )
  select count(*)::integer into ping_tasks_updated from updated;

  with candidates as (
    select l.id,
      (
        select coalesce(jsonb_agg(client), '[]'::jsonb)
        from jsonb_array_elements_text(l.clients) as item(client)
        where exists (select 1 from clients c where c.uuid = client)
      ) as next_clients
    from load_notifications l
  ), changed as (
    select id, next_clients
    from candidates
    where (select count(*) from jsonb_array_elements_text(next_clients)) is distinct from (
      select count(*) from jsonb_array_elements_text((select clients from load_notifications where load_notifications.id = candidates.id))
    )
  ), deleted as (
    delete from load_notifications l
    using changed
    where l.id = changed.id
      and jsonb_array_length(changed.next_clients) = 0
    returning 1
  )
  select count(*)::integer into load_notifications_deleted from deleted;

  with candidates as (
    select l.id,
      (
        select coalesce(jsonb_agg(client), '[]'::jsonb)
        from jsonb_array_elements_text(l.clients) as item(client)
        where exists (select 1 from clients c where c.uuid = client)
      ) as next_clients
    from load_notifications l
  ), changed as (
    select id, next_clients
    from candidates
    where (select count(*) from jsonb_array_elements_text(next_clients)) is distinct from (
      select count(*) from jsonb_array_elements_text((select clients from load_notifications where load_notifications.id = candidates.id))
    )
  ), updated as (
    update load_notifications l
    set clients = changed.next_clients
    from changed
    where l.id = changed.id
      and jsonb_array_length(changed.next_clients) > 0
    returning 1
  )
  select count(*)::integer into load_notifications_updated from updated;

  delete from offline_notifications o where not exists (select 1 from clients c where c.uuid = o.client);
  get diagnostics offline_notifications_deleted = row_count;

  delete from expiry_notifications e where not exists (select 1 from clients c where c.uuid = e.client);
  get diagnostics expiry_notifications_deleted = row_count;

  delete from records r where not exists (select 1 from clients c where c.uuid = r.client);
  get diagnostics records_deleted = row_count;

  delete from gpu_records g where not exists (select 1 from clients c where c.uuid = g.client);
  get diagnostics gpu_records_deleted = row_count;

  delete from gpu_snapshots g where not exists (select 1 from clients c where c.uuid = g.client);
  get diagnostics gpu_snapshots_deleted = row_count;

  delete from ping_records p where not exists (select 1 from clients c where c.uuid = p.client);
  get diagnostics ping_records_deleted = row_count;

  delete from ping_snapshots p where not exists (select 1 from clients c where c.uuid = p.client);
  get diagnostics ping_snapshots_deleted = row_count;

  return jsonb_build_object(
    'ping_tasks_updated', ping_tasks_updated,
    'load_notifications_updated', load_notifications_updated,
    'load_notifications_deleted', load_notifications_deleted,
    'expiry_notifications_deleted', expiry_notifications_deleted,
    'offline_notifications_deleted', offline_notifications_deleted,
    'records_deleted', records_deleted,
    'gpu_records_deleted', gpu_records_deleted,
    'gpu_snapshots_deleted', gpu_snapshots_deleted,
    'ping_records_deleted', ping_records_deleted,
    'ping_snapshots_deleted', ping_snapshots_deleted
  );
end;
$$;

create or replace function public.cfm_update_clients_hidden(input_uuids jsonb, input_hidden boolean)
returns integer
language sql
set search_path = public
as $$
  with
    ids as (
      select distinct uuid
      from jsonb_array_elements_text(coalesce(input_uuids, '[]'::jsonb)) as item(uuid)
      where trim(uuid) <> ''
    ),
    updated as (
      update clients
      set hidden = case when input_hidden then 1 else 0 end,
          updated_at = now()
      where uuid in (select uuid from ids)
        and hidden is distinct from case when input_hidden then 1 else 0 end
      returning uuid
    )
  select count(*)::integer from updated;
$$;

create or replace function public.cfm_reorder_clients(input_uuids jsonb)
returns integer
language plpgsql
set search_path = public
as $$
declare
  input_count integer;
  existing_count integer;
  updated_count integer;
begin
  with input_order as (
    select uuid, min(ord)::integer as ord
    from jsonb_array_elements_text(coalesce(input_uuids, '[]'::jsonb)) with ordinality as item(uuid, ord)
    where trim(uuid) <> ''
    group by uuid
  )
  select count(*) into input_count from input_order;
  if input_count = 0 then
    return 0;
  end if;

  with input_order as (
    select uuid, min(ord)::integer as ord
    from jsonb_array_elements_text(coalesce(input_uuids, '[]'::jsonb)) with ordinality as item(uuid, ord)
    where trim(uuid) <> ''
    group by uuid
  )
  select count(*) into existing_count
  from clients c
  join input_order i on i.uuid = c.uuid;
  if existing_count <> input_count then
    raise exception 'Client uuid does not exist';
  end if;

  with input_order as (
    select uuid, min(ord)::integer as ord
    from jsonb_array_elements_text(coalesce(input_uuids, '[]'::jsonb)) with ordinality as item(uuid, ord)
    where trim(uuid) <> ''
    group by uuid
  ),
  final_order as (
    select uuid, ord as sort_order
    from input_order
    union all
    select c.uuid, (input_count + row_number() over (order by c.sort_order asc, lower(c.name) asc, c.created_at asc))::integer
    from clients c
    where not exists (select 1 from input_order i where i.uuid = c.uuid)
  ),
  updated as (
    update clients c
    set sort_order = f.sort_order,
        updated_at = now()
    from final_order f
    where c.uuid = f.uuid
      and c.sort_order is distinct from f.sort_order
    returning c.uuid
  )
  select count(*) into updated_count from updated;

  return updated_count;
end;
$$;

create or replace function public.cfm_client_capacity_counts()
returns jsonb
language sql
stable
set search_path = public
as $$
  select jsonb_build_object(
    'clients', count(*)::integer,
    'gpu_clients', coalesce(sum(case when trim(coalesce(gpu_name, '')) <> '' then 1 else 0 end), 0)::integer
  )
  from clients;
$$;

create or replace function public.cfm_ping_task_estimate_rows()
returns jsonb
language sql
stable
set search_path = public
as $$
  select coalesce(jsonb_agg(to_jsonb(row_data) order by sort_order asc, id asc), '[]'::jsonb)
  from (
    select id, name, clients, all_clients, interval_sec, sort_order
    from ping_tasks
    order by sort_order asc, id asc
  ) row_data;
$$;

create or replace function public.cfm_ping_task(input_id integer)
returns jsonb
language sql
stable
set search_path = public
as $$
  select to_jsonb(row_data)
  from (
    select *
    from ping_tasks
    where id = input_id
    limit 1
  ) row_data;
$$;

create or replace function public.cfm_create_ping_task(input_task jsonb)
returns jsonb
language sql
set search_path = public
as $$
  insert into ping_tasks (name, clients, all_clients, type, target, interval_sec, sort_order)
  values (
    coalesce(input_task->>'name', ''),
    case when jsonb_typeof(input_task->'clients') = 'array' then input_task->'clients' else '[]'::jsonb end,
    case when coalesce((input_task->>'all_clients')::boolean, false) then 1 else 0 end,
    coalesce(input_task->>'type', 'icmp'),
    coalesce(input_task->>'target', ''),
    coalesce((input_task->>'interval_sec')::integer, 60),
    coalesce(nullif((input_task->>'sort_order')::integer, 0), (select coalesce(max(sort_order), 0) + 1 from ping_tasks))
  )
  returning to_jsonb(ping_tasks.*);
$$;

create or replace function public.cfm_update_ping_task(input_id integer, input_task jsonb)
returns jsonb
language sql
set search_path = public
as $$
  update ping_tasks
  set
    name = coalesce(input_task->>'name', name),
    clients = case when jsonb_typeof(input_task->'clients') = 'array' then input_task->'clients' else clients end,
    all_clients = case when input_task ? 'all_clients' then case when coalesce((input_task->>'all_clients')::boolean, false) then 1 else 0 end else all_clients end,
    type = coalesce(input_task->>'type', type),
    target = coalesce(input_task->>'target', target),
    interval_sec = coalesce((input_task->>'interval_sec')::integer, interval_sec)
  where id = input_id
  returning to_jsonb(ping_tasks.*);
$$;

create or replace function public.cfm_reorder_ping_tasks(input_ids jsonb)
returns integer
language plpgsql
set search_path = public
as $$
declare
  input_id integer;
  final_id integer;
  final_ids integer[] := '{}';
  changed_count integer := 0;
  next_order integer := 1;
  old_order integer;
begin
  for input_id in
    select distinct value::integer
    from jsonb_array_elements_text(case when jsonb_typeof(input_ids) = 'array' then input_ids else '[]'::jsonb end) as value
    where value ~ '^[0-9]+$' and value::integer > 0
  loop
    final_ids := array_append(final_ids, input_id);
  end loop;

  if cardinality(final_ids) = 0 then
    return 0;
  end if;

  if exists (
    select 1
    from unnest(final_ids) id
    where not exists (select 1 from ping_tasks where ping_tasks.id = id)
  ) then
    raise exception 'Ping task id does not exist';
  end if;

  for final_id in
    select id
    from ping_tasks
    where not (id = any(final_ids))
    order by sort_order asc, id asc
  loop
    final_ids := array_append(final_ids, final_id);
  end loop;

  foreach final_id in array final_ids loop
    select sort_order into old_order from ping_tasks where id = final_id;
    if old_order is distinct from next_order then
      update ping_tasks set sort_order = next_order where id = final_id;
      changed_count := changed_count + 1;
    end if;
    next_order := next_order + 1;
  end loop;

  return changed_count;
end;
$$;

create or replace function public.cfm_delete_ping_task(input_id integer)
returns jsonb
language sql
set search_path = public
as $$
  delete from ping_tasks
  where id = input_id
  returning to_jsonb(ping_tasks.*);
$$;

create or replace function public.cfm_delete_old_records(input_before_time text, input_max_batches integer default 200)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  delete_limit integer := least(greatest(coalesce(input_max_batches, 200), 1), 1000) * 100;
  records_deleted integer;
  gpu_records_deleted integer;
  gpu_snapshots_deleted integer;
begin
  with doomed as (
    select id from records where time < input_before_time::timestamptz order by time, id limit delete_limit
  ), deleted as (
    delete from records where id in (select id from doomed) returning 1
  )
  select count(*)::integer into records_deleted from deleted;

  with doomed as (
    select id from gpu_records where time < input_before_time::timestamptz order by time, id limit delete_limit
  ), deleted as (
    delete from gpu_records where id in (select id from doomed) returning 1
  )
  select count(*)::integer into gpu_records_deleted from deleted;

  with doomed as (
    select id from gpu_snapshots where time < input_before_time::timestamptz order by time, id limit delete_limit
  ), deleted as (
    delete from gpu_snapshots where id in (select id from doomed) returning 1
  )
  select count(*)::integer into gpu_snapshots_deleted from deleted;

  return jsonb_build_object(
    'records', records_deleted,
    'gpu_records', gpu_records_deleted,
    'gpu_snapshots', gpu_snapshots_deleted
  );
end;
$$;

create or replace function public.cfm_delete_old_website_checks(input_before_time text, input_max_batches integer default 200)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  delete_limit integer := least(greatest(coalesce(input_max_batches, 200), 1), 1000) * 100;
  website_checks_deleted integer;
begin
  with doomed as (
    select id from website_checks where checked_at < input_before_time::timestamptz order by id limit delete_limit
  ), deleted as (
    delete from website_checks where id in (select id from doomed) returning 1
  )
  select count(*)::integer into website_checks_deleted from deleted;

  return jsonb_build_object('website_checks', website_checks_deleted);
end;
$$;

create or replace function public.cfm_delete_old_ping_records(input_before_time text, input_max_batches integer default 200)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  delete_limit integer := least(greatest(coalesce(input_max_batches, 200), 1), 1000) * 100;
  ping_records_deleted integer;
  ping_snapshots_deleted integer;
begin
  with doomed as (
    select id from ping_records where time < input_before_time::timestamptz order by time, id limit delete_limit
  ), deleted as (
    delete from ping_records where id in (select id from doomed) returning 1
  )
  select count(*)::integer into ping_records_deleted from deleted;

  with doomed as (
    select id from ping_snapshots where time < input_before_time::timestamptz order by time, id limit delete_limit
  ), deleted as (
    delete from ping_snapshots where id in (select id from doomed) returning 1
  )
  select count(*)::integer into ping_snapshots_deleted from deleted;

  return jsonb_build_object(
    'ping_records', ping_records_deleted,
    'ping_snapshots', ping_snapshots_deleted
  );
end;
$$;

create or replace function public.cfm_delete_old_audit_logs(input_before_time text, input_max_batches integer default 200)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  delete_limit integer := least(greatest(coalesce(input_max_batches, 200), 1), 1000) * 100;
  audit_logs_deleted integer;
begin
  with doomed as (
    select id from audit_logs where time < input_before_time::timestamptz order by time, id limit delete_limit
  ), deleted as (
    delete from audit_logs where id in (select id from doomed) returning 1
  )
  select count(*)::integer into audit_logs_deleted from deleted;

  return jsonb_build_object('audit_logs', audit_logs_deleted);
end;
$$;

create or replace function public.cfm_offline_notification(input_client text)
returns jsonb
language sql
stable
set search_path = public
as $$
  select to_jsonb(row_data)
  from (
    select client, enable <> 0 as enable, grace_period, last_notified
    from offline_notifications
    where client = input_client
    limit 1
  ) row_data;
$$;

create or replace function public.cfm_offline_notifications()
returns jsonb
language sql
stable
set search_path = public
as $$
  select coalesce(jsonb_agg(to_jsonb(row_data) order by client), '[]'::jsonb)
  from (
    select client, enable <> 0 as enable, grace_period, last_notified
    from offline_notifications
  ) row_data;
$$;

create or replace function public.cfm_set_offline_notifications(input_items jsonb)
returns integer
language sql
set search_path = public
as $$
  with parsed as (
    select distinct on (client)
      client,
      case when lower(coalesce(item->>'enable', 'false')) in ('true', '1') then 1 else 0 end as enable,
      coalesce(nullif(item->>'grace_period', '')::integer, 180) as grace_period,
      ord
    from jsonb_array_elements(coalesce(input_items, '[]'::jsonb)) with ordinality as value(item, ord)
    cross join lateral (select trim(item->>'client') as client) normalized
    where client <> ''
    order by client, ord desc
  ),
  upserted as (
    insert into offline_notifications (client, enable, grace_period)
    select client, enable, grace_period
    from parsed
    on conflict (client) do update set
      enable = excluded.enable,
      grace_period = excluded.grace_period,
      last_notified = case
        when excluded.enable = 0 then null
        else offline_notifications.last_notified
      end
    where offline_notifications.enable is distinct from excluded.enable
       or offline_notifications.grace_period is distinct from excluded.grace_period
       or (excluded.enable = 0 and offline_notifications.last_notified is not null)
    returning client
  )
  select count(*)::integer from upserted;
$$;

create or replace function public.cfm_mark_offline_notification_sent(input_client text, input_time text)
returns void
language sql
set search_path = public
as $$
  update offline_notifications
  set last_notified = nullif(input_time, '')::timestamptz
  where client = input_client;
$$;

create or replace function public.cfm_expiry_notification(input_client text)
returns jsonb
language sql
stable
set search_path = public
as $$
  select to_jsonb(row_data)
  from (
    select client, enable <> 0 as enable, advance_days, last_notified
    from expiry_notifications
    where client = input_client
    limit 1
  ) row_data;
$$;

create or replace function public.cfm_expiry_notifications()
returns jsonb
language sql
stable
set search_path = public
as $$
  select coalesce(jsonb_agg(to_jsonb(row_data) order by client), '[]'::jsonb)
  from (
    select client, enable <> 0 as enable, advance_days, last_notified
    from expiry_notifications
  ) row_data;
$$;

create or replace function public.cfm_set_expiry_notifications(input_items jsonb)
returns integer
language sql
set search_path = public
as $$
  with parsed as (
    select distinct on (client)
      client,
      case when lower(coalesce(item->>'enable', 'false')) in ('true', '1') then 1 else 0 end as enable,
      coalesce(nullif(item->>'advance_days', '')::integer, 7) as advance_days,
      ord
    from jsonb_array_elements(coalesce(input_items, '[]'::jsonb)) with ordinality as value(item, ord)
    cross join lateral (select trim(item->>'client') as client) normalized
    where client <> ''
    order by client, ord desc
  ),
  upserted as (
    insert into expiry_notifications (client, enable, advance_days)
    select client, enable, advance_days
    from parsed
    on conflict (client) do update set
      enable = excluded.enable,
      advance_days = excluded.advance_days
    where expiry_notifications.enable is distinct from excluded.enable
       or expiry_notifications.advance_days is distinct from excluded.advance_days
    returning client
  )
  select count(*)::integer from upserted;
$$;

create or replace function public.cfm_mark_expiry_notification_sent(input_client text, input_time text)
returns void
language sql
set search_path = public
as $$
  update expiry_notifications
  set last_notified = input_time::timestamptz
  where client = input_client;
$$;

create or replace function public.cfm_audit_logs_paged(input_page integer default 1, input_limit integer default 50)
returns jsonb
language plpgsql
stable
set search_path = public
as $$
begin
  return (
  with args as (
    select
      greatest(coalesce(input_page, 1), 1) as safe_page,
      least(greatest(coalesce(input_limit, 50), 1), 500) as safe_limit
  ),
  rows as (
    select id, time, "user", action, detail, level
    from audit_logs, args
    order by time desc
    limit (select safe_limit + 1 from args)
    offset (select (safe_page - 1) * safe_limit from args)
  ),
  limited as (
    select *
    from rows
    limit (select safe_limit from args)
  )
  select jsonb_build_object(
    'logs', coalesce((select jsonb_agg(to_jsonb(limited) order by time desc) from limited), '[]'::jsonb),
    'total', (select (safe_page - 1) * safe_limit from args) + (select count(*) from limited) + case when (select count(*) from rows) > (select safe_limit from args) then 1 else 0 end,
    'has_more', (select count(*) from rows) > (select safe_limit from args)
  )
  );
end;
$$;

create or replace function public.cfm_themes()
returns jsonb
language sql
stable
set search_path = public
as $$
  select coalesce(jsonb_agg(to_jsonb(row_data) order by updated_at desc, name asc), '[]'::jsonb)
  from (
    select *
    from themes
    order by updated_at desc, name asc
  ) row_data;
$$;

create or replace function public.cfm_theme(input_short text)
returns jsonb
language sql
stable
set search_path = public
as $$
  select to_jsonb(row_data)
  from (
    select *
    from themes
    where short = input_short
    limit 1
  ) row_data;
$$;

create or replace function public.cfm_upsert_theme(input_theme jsonb, input_assets jsonb default '[]'::jsonb)
returns void
language plpgsql
set search_path = public
as $$
begin
  if input_theme is null or jsonb_typeof(input_theme) <> 'object' then
    return;
  end if;

  insert into themes (
    short, name, description, version, author, url, preview_path, style_path,
    manifest_json, config_json, custom_css, updated_at
  )
  values (
    input_theme->>'short',
    coalesce(input_theme->>'name', ''),
    coalesce(input_theme->>'description', ''),
    coalesce(input_theme->>'version', ''),
    coalesce(input_theme->>'author', ''),
    coalesce(input_theme->>'url', ''),
    coalesce(input_theme->>'preview_path', ''),
    coalesce(input_theme->>'style_path', ''),
    coalesce(input_theme->>'manifest_json', '{}'),
    coalesce(input_theme->>'config_json', '{}'),
    coalesce(input_theme->>'custom_css', ''),
    now()
  )
  on conflict (short) do update set
    name = excluded.name,
    description = excluded.description,
    version = excluded.version,
    author = excluded.author,
    url = excluded.url,
    preview_path = excluded.preview_path,
    style_path = excluded.style_path,
    manifest_json = excluded.manifest_json,
    config_json = excluded.config_json,
    updated_at = now();

  delete from theme_assets where theme_short = input_theme->>'short';

  insert into theme_assets (theme_short, path, content_type, content_base64, size_bytes)
  select
    input_theme->>'short',
    asset->>'path',
    coalesce(asset->>'content_type', ''),
    coalesce(asset->>'content_base64', ''),
    coalesce(nullif(asset->>'size_bytes', '')::integer, 0)
  from jsonb_array_elements(
    case when jsonb_typeof(input_assets) = 'array' then input_assets else '[]'::jsonb end
  ) asset;
end;
$$;

create or replace function public.cfm_update_theme_settings(
  input_short text,
  input_config_json text,
  input_custom_css text
)
returns boolean
language plpgsql
set search_path = public
as $$
declare
  updated_count integer;
begin
  update themes
  set config_json = input_config_json, custom_css = input_custom_css, updated_at = now()
  where short = input_short;

  get diagnostics updated_count = row_count;
  return updated_count > 0;
end;
$$;

create or replace function public.cfm_delete_theme(input_short text)
returns boolean
language plpgsql
set search_path = public
as $$
declare
  deleted_count integer;
begin
  delete from themes where short = input_short;

  get diagnostics deleted_count = row_count;
  return deleted_count > 0;
end;
$$;

create or replace function public.cfm_theme_asset(input_short text, input_path text)
returns jsonb
language sql
stable
set search_path = public
as $$
  select to_jsonb(row_data)
  from (
    select *
    from theme_assets
    where theme_short = input_short
      and path = input_path
    limit 1
  ) row_data;
$$;

create or replace function public.cfm_load_notifications()
returns jsonb
language sql
stable
set search_path = public
as $$
  select coalesce(jsonb_agg(to_jsonb(row_data) order by id), '[]'::jsonb)
  from (
    select id, name, clients, metric, threshold, ratio, interval_min, last_notified
    from load_notifications
    order by id asc
  ) row_data;
$$;

create or replace function public.cfm_load_notification(input_id integer)
returns jsonb
language sql
stable
set search_path = public
as $$
  select to_jsonb(row_data)
  from (
    select id, name, clients, metric, threshold, ratio, interval_min, last_notified
    from load_notifications
    where id = input_id
    limit 1
  ) row_data;
$$;

create or replace function public.cfm_create_load_notification(input_item jsonb)
returns void
language sql
set search_path = public
as $$
  insert into load_notifications (name, clients, metric, threshold, ratio, interval_min)
  values (
    coalesce(input_item->>'name', ''),
    case when jsonb_typeof(input_item->'clients') = 'array' then input_item->'clients' else '[]'::jsonb end,
    coalesce(input_item->>'metric', 'cpu'),
    coalesce((input_item->>'threshold')::double precision, 80),
    coalesce((input_item->>'ratio')::double precision, 0.8),
    coalesce((input_item->>'interval_min')::integer, 15)
  );
$$;

create or replace function public.cfm_load_metric_window_stats(
  input_clients jsonb,
  input_start text,
  input_end text,
  input_metric text,
  input_threshold double precision
)
returns jsonb
language sql
stable
set search_path = public
as $$
  with ids as (
    select distinct trim(value) as client
    from jsonb_array_elements_text(coalesce(input_clients, '[]'::jsonb)) as item(value)
    where trim(value) <> ''
  ),
  samples as (
    select
      records.client,
      case
        when input_metric = 'ram' then case when ram_total > 0 then (ram::double precision / ram_total) * 100 else 0 end
        when input_metric = 'load' then coalesce(load, 0)
        when input_metric = 'disk' then case when disk_total > 0 then (disk::double precision / disk_total) * 100 else 0 end
        when input_metric = 'temp' then coalesce(temp, 0)
        else coalesce(cpu, 0)
      end as metric_value
    from records
    join ids on ids.client = records.client
    where records.time >= input_start::timestamptz
      and records.time <= input_end::timestamptz
  )
  select coalesce(jsonb_agg(to_jsonb(row_data) order by client), '[]'::jsonb)
  from (
    select
      client,
      count(*)::integer as samples,
      coalesce(sum(case when metric_value >= input_threshold then 1 else 0 end), 0)::integer as exceeded,
      coalesce(avg(metric_value), 0)::double precision as avg_value
    from samples
    group by client
  ) row_data;
$$;

create or replace function public.cfm_update_load_notification(input_id integer, input_patch jsonb)
returns boolean
language plpgsql
set search_path = public
as $$
declare
  updated_count integer;
begin
  if input_patch is null or jsonb_typeof(input_patch) <> 'object' then
    return false;
  end if;

  update load_notifications
  set
    name = case when input_patch ? 'name' then coalesce(input_patch->>'name', '') else name end,
    clients = case when input_patch ? 'clients' and jsonb_typeof(input_patch->'clients') = 'array' then input_patch->'clients' else clients end,
    metric = case when input_patch ? 'metric' and input_patch->>'metric' in ('cpu', 'ram', 'load', 'disk', 'temp') then input_patch->>'metric' else metric end,
    threshold = case when input_patch ? 'threshold' then coalesce((input_patch->>'threshold')::double precision, threshold) else threshold end,
    ratio = case when input_patch ? 'ratio' then coalesce((input_patch->>'ratio')::double precision, ratio) else ratio end,
    interval_min = case when input_patch ? 'interval_min' then coalesce((input_patch->>'interval_min')::integer, interval_min) else interval_min end,
    last_notified = case when input_patch ? 'last_notified' then nullif(input_patch->>'last_notified', '')::timestamptz else last_notified end
  where id = input_id;

  get diagnostics updated_count = row_count;
  return updated_count > 0;
end;
$$;

create or replace function public.cfm_delete_load_notification(input_id integer)
returns void
language sql
set search_path = public
as $$
  delete from load_notifications where id = input_id;
$$;

create or replace function public.cfm_due_website_monitors(input_now text, input_limit integer default 50)
returns jsonb
language plpgsql
stable
set search_path = public
as $$
begin
  return (
  select coalesce(jsonb_agg(to_jsonb(row_data)), '[]'::jsonb)
  from (
    select *
    from website_monitors
    where enabled = true
      and (
        last_checked_at is null
        or last_checked_at <= input_now::timestamptz - (greatest(interval_sec - 30, 1) * interval '1 second')
      )
    order by coalesce(last_checked_at, '1970-01-01'::timestamptz) asc, sort_order asc, id asc
    limit least(greatest(coalesce(input_limit, 50), 1), 200)
  ) row_data
  );
end;
$$;

alter table website_monitors add column if not exists agent_probe_mode text not null default 'off';
alter table website_monitors add column if not exists agent_probe_clients jsonb not null default '[]'::jsonb;
alter table website_monitors add column if not exists agent_probe_limit integer not null default 3;
alter table website_monitors add column if not exists agent_probe_status_enabled boolean not null default false;
alter table website_monitors drop constraint if exists website_monitors_agent_probe_mode_check;
alter table website_monitors add constraint website_monitors_agent_probe_mode_check check (agent_probe_mode in ('off', 'selected', 'country_auto'));
alter table website_monitors drop constraint if exists website_monitors_agent_probe_limit_check;
alter table website_monitors add constraint website_monitors_agent_probe_limit_check check (agent_probe_limit between 1 and 10);

alter table website_checks add column if not exists source_type text not null default 'worker';
alter table website_checks add column if not exists source_client text;
alter table website_checks drop constraint if exists website_checks_source_type_check;
alter table website_checks add constraint website_checks_source_type_check check (source_type in ('worker', 'agent'));
alter table website_checks drop constraint if exists website_checks_source_client_fkey;
alter table website_checks add constraint website_checks_source_client_fkey foreign key (source_client) references clients(uuid) on delete set null;
create index if not exists idx_website_checks_monitor_source_time on website_checks(monitor_id, source_type, source_client, checked_at desc);

create or replace function public.cfm_record_website_check(input_check jsonb)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  monitor_row website_monitors%rowtype;
  check_ok boolean;
  checked_time timestamptz;
  source_kind text;
  source_client_id text;
begin
  if input_check is null or jsonb_typeof(input_check) <> 'object' then
    return null;
  end if;

  check_ok := coalesce((input_check->>'ok')::boolean, false);
  checked_time := (input_check->>'checked_at')::timestamptz;
  source_kind := coalesce(nullif(input_check->>'source_type', ''), 'worker');
  if source_kind not in ('worker', 'agent') then
    source_kind := 'worker';
  end if;
  source_client_id := nullif(input_check->>'source_client', '');

  select * into monitor_row
  from website_monitors
  where id = (input_check->>'monitor_id')::integer
  limit 1;
  if not found then
    return null;
  end if;

  insert into website_checks (
    monitor_id, checked_at, ok, effective_status, effective_reason,
    status_code, raw_status_code, latency_ms, error, source_type, source_client
  )
  values (
    (input_check->>'monitor_id')::integer,
    checked_time,
    check_ok,
    case when input_check->>'effective_status' = 'up' then 'up' else 'down' end,
    input_check->>'effective_reason',
    nullif(input_check->>'status_code', '')::integer,
    nullif(input_check->>'raw_status_code', '')::integer,
    nullif(input_check->>'latency_ms', '')::integer,
    input_check->>'error',
    source_kind,
    source_client_id
  );

  if source_kind = 'agent' and monitor_row.agent_probe_status_enabled = false then
    return to_jsonb(monitor_row);
  end if;

  if check_ok then
    update website_monitors
    set status = 'up',
        last_checked_at = checked_time,
        last_success_at = checked_time,
        last_status_code = nullif(input_check->>'status_code', '')::integer,
        last_raw_status_code = nullif(input_check->>'raw_status_code', '')::integer,
        last_latency_ms = nullif(input_check->>'latency_ms', '')::integer,
        last_effective_reason = input_check->>'effective_reason',
        last_error = null,
        down_since = null,
        updated_at = now()
    where id = (input_check->>'monitor_id')::integer
    returning * into monitor_row;
  else
    update website_monitors
    set status = 'down',
        last_checked_at = checked_time,
        last_failure_at = checked_time,
        last_status_code = nullif(input_check->>'status_code', '')::integer,
        last_raw_status_code = nullif(input_check->>'raw_status_code', '')::integer,
        last_latency_ms = nullif(input_check->>'latency_ms', '')::integer,
        last_effective_reason = input_check->>'effective_reason',
        last_error = input_check->>'error',
        down_since = coalesce(down_since, checked_time),
        last_notified_at = case when status = 'down' then last_notified_at else null end,
        updated_at = now()
    where id = (input_check->>'monitor_id')::integer
    returning * into monitor_row;
  end if;

  if not found then
    return null;
  end if;
  return to_jsonb(monitor_row);
end;
$$;

create or replace function public.cfm_agent_website_probe_tasks(input_client text, input_now text, input_limit integer default 20)
returns jsonb
language sql
stable
set search_path = public
as $$
  with args as (
    select
      nullif(input_client, '') as client_id,
      least(greatest(coalesce(input_limit, 20), 1), 50) as safe_limit
  ),
  selected as (
    select id, name, url, method, expected_status_min, expected_status_max, interval_sec,
      timeout_sec, grace_period_sec, enabled, hidden, agent_probe_mode, agent_probe_clients,
      agent_probe_limit, agent_probe_status_enabled, sort_order, status, last_checked_at,
      last_success_at, last_failure_at, last_status_code, last_raw_status_code, last_latency_ms,
      last_effective_reason, last_error, down_since, last_notified_at, created_at, updated_at
    from website_monitors wm, args a
    where wm.enabled = true
      and wm.agent_probe_mode = 'selected'
      and exists (
        select 1
        from jsonb_array_elements_text(wm.agent_probe_clients) client_id
        where client_id = a.client_id
      )
  ),
  country_candidates as (
    select
      wm.id, wm.name, wm.url, wm.method, wm.expected_status_min, wm.expected_status_max, wm.interval_sec,
      wm.timeout_sec, wm.grace_period_sec, wm.enabled, wm.hidden, wm.agent_probe_mode, wm.agent_probe_clients,
      wm.agent_probe_limit, wm.agent_probe_status_enabled, wm.sort_order, wm.status, wm.last_checked_at,
      wm.last_success_at, wm.last_failure_at, wm.last_status_code, wm.last_raw_status_code, wm.last_latency_ms,
      wm.last_effective_reason, wm.last_error, wm.down_since, wm.last_notified_at, wm.created_at, wm.updated_at,
      c.uuid,
      row_number() over (
        partition by wm.id, coalesce(nullif(c.region, ''), c.uuid)
        order by c.sort_order asc, c.name asc, c.uuid asc
      ) as country_rank,
      row_number() over (
        partition by wm.id
        order by c.sort_order asc, c.name asc, c.uuid asc
      ) as monitor_rank
    from website_monitors wm
    join clients c on c.hidden = 0
    where wm.enabled = true
      and wm.agent_probe_mode = 'country_auto'
  ),
  country_selected as (
    select id, name, url, method, expected_status_min, expected_status_max, interval_sec,
      timeout_sec, grace_period_sec, enabled, hidden, agent_probe_mode, agent_probe_clients,
      agent_probe_limit, agent_probe_status_enabled, sort_order, status, last_checked_at,
      last_success_at, last_failure_at, last_status_code, last_raw_status_code, last_latency_ms,
      last_effective_reason, last_error, down_since, last_notified_at, created_at, updated_at
    from country_candidates, args a
    where uuid = a.client_id
      and country_rank = 1
      and monitor_rank <= agent_probe_limit
  ),
  all_rows as (
    select * from selected
    union
    select * from country_selected
  )
  select coalesce(jsonb_agg(to_jsonb(row_data) order by sort_order asc, id asc), '[]'::jsonb)
  from (
    select *
    from all_rows
    order by sort_order asc, id asc
    limit (select safe_limit from args)
  ) row_data;
$$;

create or replace function public.cfm_mark_website_monitor_notified(input_id integer, input_time text)
returns boolean
language sql
set search_path = public
as $$
  with updated as (
    update website_monitors
    set last_notified_at = nullif(input_time, '')::timestamptz,
        updated_at = now()
    where id = input_id
    returning id
  )
  select exists(select 1 from updated);
$$;

create or replace function public.cfm_insert_monitor_record(input_record jsonb)
returns void
language plpgsql
set search_path = public
as $$
begin
  if input_record is null or jsonb_typeof(input_record) <> 'object' then
    return;
  end if;

  insert into records (
    client, time, cpu, gpu, ram, ram_total, swap, swap_total, load, temp,
    disk, disk_total, net_in, net_out, net_total_up, net_total_down,
    process_count, connections, connections_udp, uptime
  ) values (
    input_record->>'client',
    (input_record->>'time')::timestamptz,
    coalesce((input_record->>'cpu')::double precision, 0),
    coalesce((input_record->>'gpu')::double precision, 0),
    coalesce((input_record->>'ram')::double precision, 0),
    coalesce((input_record->>'ram_total')::double precision, 0),
    coalesce((input_record->>'swap')::double precision, 0),
    coalesce((input_record->>'swap_total')::double precision, 0),
    coalesce((input_record->>'load')::double precision, 0),
    coalesce((input_record->>'temp')::double precision, 0),
    coalesce((input_record->>'disk')::double precision, 0),
    coalesce((input_record->>'disk_total')::double precision, 0),
    coalesce((input_record->>'net_in')::double precision, 0),
    coalesce((input_record->>'net_out')::double precision, 0),
    coalesce((input_record->>'net_total_up')::double precision, 0),
    coalesce((input_record->>'net_total_down')::double precision, 0),
    coalesce((input_record->>'process_count')::integer, 0),
    coalesce((input_record->>'connections')::integer, 0),
    coalesce((input_record->>'connections_udp')::integer, 0),
    coalesce((input_record->>'uptime')::double precision, 0)
  );
end;
$$;

create or replace function public.cfm_insert_gpu_snapshot(input_client text, input_time text, input_gpus jsonb)
returns void
language plpgsql
set search_path = public
as $$
begin
  if input_gpus is null or jsonb_typeof(input_gpus) <> 'array' or jsonb_array_length(input_gpus) = 0 then
    return;
  end if;

  insert into gpu_snapshots (client, time, devices_json)
  values (input_client, input_time::timestamptz, input_gpus);
end;
$$;

create or replace function public.cfm_insert_ping_snapshot(input_client text, input_time text, input_results jsonb)
returns void
language plpgsql
set search_path = public
as $$
declare
  values_json jsonb;
begin
  if input_results is null or jsonb_typeof(input_results) <> 'array' then
    return;
  end if;

  select coalesce(jsonb_object_agg(item->>'taskId', round((item->>'value')::double precision)::integer), '{}'::jsonb)
  into values_json
  from jsonb_array_elements(input_results) item
  where (item->>'taskId') ~ '^[0-9]+$'
    and (item->>'value') is not null;

  if values_json = '{}'::jsonb then
    return;
  end if;

  insert into ping_snapshots (client, time, values_json)
  values (input_client, input_time::timestamptz, values_json);
end;
$$;

create or replace function public.cfm_recent_records(input_client text, input_limit integer default 30)
returns jsonb
language plpgsql
stable
set search_path = public
as $$
begin
  return (
  select coalesce(jsonb_agg(to_jsonb(row_data) order by time asc), '[]'::jsonb)
  from (
    select *
    from records
    where client = input_client
    order by time desc
    limit least(greatest(coalesce(input_limit, 30), 1), 1000)
  ) row_data
  );
end;
$$;

create or replace function public.cfm_latest_records()
returns jsonb
language sql
stable
set search_path = public
as $$
  select coalesce(jsonb_agg(to_jsonb(row_data) order by time desc), '[]'::jsonb)
  from (
    select r.*
    from records r
    inner join (
      select client, max(time) as time
      from records
      group by client
    ) latest
      on r.client = latest.client and r.time = latest.time
  ) row_data;
$$;

create or replace function public.cfm_records_range(input_client text, input_start text, input_end text)
returns jsonb
language sql
stable
set search_path = public
as $$
  select coalesce(jsonb_agg(to_jsonb(row_data) order by time asc), '[]'::jsonb)
  from (
    select *
    from records
    where client = input_client
      and time >= input_start::timestamptz
      and time <= input_end::timestamptz
    order by time asc
  ) row_data;
$$;

create or replace function public.cfm_records_range_limited(
  input_client text,
  input_start text,
  input_end text,
  input_limit integer default 100
)
returns jsonb
language plpgsql
stable
set search_path = public
as $$
begin
  return (
  select coalesce(jsonb_agg(to_jsonb(row_data) order by time asc), '[]'::jsonb)
  from (
    select *
    from records
    where client = input_client
      and time >= input_start::timestamptz
      and time <= input_end::timestamptz
    order by time desc
    limit least(greatest(coalesce(input_limit, 100), 1), 2000)
  ) row_data
  );
end;
$$;

create or replace function public.cfm_records_range_paged(
  input_client text,
  input_start text,
  input_end text,
  input_page integer default 1,
  input_limit integer default 100
)
returns jsonb
language plpgsql
stable
set search_path = public
as $$
begin
  return (
  with
    params as (
      select
        greatest(coalesce(input_page, 1), 1)::integer as page,
        least(greatest(coalesce(input_limit, 100), 1), 500)::integer as limit_value
    ),
    raw_rows as (
      select records.*
      from records, params
      where client = input_client
        and time >= input_start::timestamptz
        and time <= input_end::timestamptz
      order by time desc
      limit (select limit_value + 1 from params)
      offset (select (page - 1) * limit_value from params)
    ),
    numbered as (
      select raw_rows.*, row_number() over (order by time asc) as rn
      from raw_rows
    ),
    data_rows as (
      select id, client, time, cpu, gpu, ram, ram_total, swap, swap_total, load, temp,
        disk, disk_total, net_in, net_out, net_total_up, net_total_down,
        process_count, connections, connections_udp, uptime
      from numbered, params
      where not ((select count(*) from raw_rows) > params.limit_value and rn = 1)
    )
  select jsonb_build_object(
    'data', coalesce((select jsonb_agg(to_jsonb(data_rows) order by time asc) from data_rows), '[]'::jsonb),
    'total', (params.page - 1) * params.limit_value + (select count(*) from data_rows) + case when (select count(*) from raw_rows) > params.limit_value then 1 else 0 end,
    'page', params.page,
    'limit', params.limit_value,
    'has_more', (select count(*) from raw_rows) > params.limit_value
  )
  from params
  );
end;
$$;

create or replace function public.cfm_records_range_cursor(
  input_client text,
  input_start text,
  input_end text,
  input_cursor text default null,
  input_limit integer default 100
)
returns jsonb
language plpgsql
stable
set search_path = public
as $$
begin
  return (
  with
    params as (
      select least(greatest(coalesce(input_limit, 100), 1), 500)::integer as limit_value
    ),
    raw_rows as (
      select *
      from records, params
      where client = input_client
        and time >= input_start::timestamptz
        and time <= input_end::timestamptz
        and (input_cursor is null or time < input_cursor::timestamptz)
      order by time desc
      limit (select limit_value + 1 from params)
    ),
    numbered as (
      select raw_rows.*, row_number() over (order by time asc) as rn
      from raw_rows
    ),
    data_rows as (
      select id, client, time, cpu, gpu, ram, ram_total, swap, swap_total, load, temp,
        disk, disk_total, net_in, net_out, net_total_up, net_total_down,
        process_count, connections, connections_udp, uptime
      from numbered, params
      where not ((select count(*) from raw_rows) > params.limit_value and rn = 1)
    )
  select jsonb_strip_nulls(jsonb_build_object(
    'data', coalesce((select jsonb_agg(to_jsonb(data_rows) order by time asc) from data_rows), '[]'::jsonb),
    'total', (select count(*) from data_rows) + case when (select count(*) from raw_rows) > params.limit_value then 1 else 0 end,
    'page', 1,
    'limit', params.limit_value,
    'has_more', (select count(*) from raw_rows) > params.limit_value,
    'next_cursor', case when (select count(*) from raw_rows) > params.limit_value then (select min(time) from data_rows) else null end
  ))
  from params
  );
end;
$$;

create or replace function public.cfm_latest_record_times()
returns jsonb
language sql
stable
set search_path = public
as $$
  select coalesce(jsonb_agg(to_jsonb(row_data) order by client), '[]'::jsonb)
  from (
    select client, max(time) as last_time
    from records
    group by client
  ) row_data;
$$;

create or replace function public.cfm_latest_record_times_for_clients(input_clients jsonb)
returns jsonb
language sql
stable
set search_path = public
as $$
  with requested as (
    select distinct value as client
    from jsonb_array_elements_text(coalesce(input_clients, '[]'::jsonb)) as value
    where trim(value) <> ''
  )
  select coalesce(jsonb_agg(to_jsonb(row_data) order by client), '[]'::jsonb)
  from (
    select r.client, max(r.time) as last_time
    from records r
    join requested on requested.client = r.client
    group by r.client
  ) row_data;
$$;

create or replace function public.cfm_gpu_records(
  input_client text,
  input_start text default null,
  input_end text default null,
  input_limit integer default 100
)
returns jsonb
language plpgsql
stable
set search_path = public
as $$
begin
  return (
  with snapshot_rows as (
    select id, client, time, devices_json
    from gpu_snapshots
    where client = input_client
      and (input_start is null or input_end is null or time >= input_start::timestamptz)
      and (input_start is null or input_end is null or time <= input_end::timestamptz)
    order by time desc
    limit least(greatest(coalesce(input_limit, 100), 1), 1000)
  ),
  flat_rows as (
    select
      s.id,
      s.client,
      s.time,
      coalesce((device->>'device_index')::integer, 0) as device_index,
      coalesce(device->>'device_name', '') as device_name,
      coalesce((device->>'mem_total')::double precision, 0) as mem_total,
      coalesce((device->>'mem_used')::double precision, 0) as mem_used,
      coalesce((device->>'utilization')::double precision, 0) as utilization,
      coalesce((device->>'temperature')::double precision, 0) as temperature
    from snapshot_rows s
    cross join lateral jsonb_array_elements(case when jsonb_typeof(s.devices_json) = 'array' then s.devices_json else '[]'::jsonb end) device
  )
  select coalesce(jsonb_agg(to_jsonb(flat_rows) order by time asc, device_index asc), '[]'::jsonb)
  from flat_rows
  );
end;
$$;

create or replace function public.cfm_gpu_records_paged(
  input_client text,
  input_start text default null,
  input_end text default null,
  input_page integer default 1,
  input_limit integer default 100
)
returns jsonb
language plpgsql
stable
set search_path = public
as $$
begin
  return (
  with
    params as (
      select
        greatest(coalesce(input_page, 1), 1)::integer as page,
        least(greatest(coalesce(input_limit, 100), 1), 500)::integer as limit_value
    ),
    flat_rows as (
      select
        s.id,
        s.client,
        s.time,
        coalesce((device->>'device_index')::integer, 0) as device_index,
        coalesce(device->>'device_name', '') as device_name,
        coalesce((device->>'mem_total')::double precision, 0) as mem_total,
        coalesce((device->>'mem_used')::double precision, 0) as mem_used,
        coalesce((device->>'utilization')::double precision, 0) as utilization,
        coalesce((device->>'temperature')::double precision, 0) as temperature
      from gpu_snapshots s
      cross join lateral jsonb_array_elements(case when jsonb_typeof(s.devices_json) = 'array' then s.devices_json else '[]'::jsonb end) device
      where s.client = input_client
        and (input_start is null or s.time >= input_start::timestamptz)
        and (input_end is null or s.time <= input_end::timestamptz)
      order by s.time desc, device_index asc
      limit (select limit_value + 1 from params)
      offset (select (page - 1) * limit_value from params)
    ),
    numbered as (
      select flat_rows.*, row_number() over (order by time asc, device_index asc) as rn
      from flat_rows
    ),
    data_rows as (
      select id, client, time, device_index, device_name, mem_total, mem_used, utilization, temperature
      from numbered, params
      where not ((select count(*) from flat_rows) > params.limit_value and rn = 1)
    )
  select jsonb_build_object(
    'data', coalesce((select jsonb_agg(to_jsonb(data_rows) order by time asc, device_index asc) from data_rows), '[]'::jsonb),
    'total', (params.page - 1) * params.limit_value + (select count(*) from data_rows) + case when (select count(*) from flat_rows) > params.limit_value then 1 else 0 end,
    'page', params.page,
    'limit', params.limit_value,
    'has_more', (select count(*) from flat_rows) > params.limit_value
  )
  from params
  );
end;
$$;

create or replace function public.cfm_gpu_records_cursor(
  input_client text,
  input_start text default null,
  input_end text default null,
  input_cursor text default null,
  input_limit integer default 100
)
returns jsonb
language plpgsql
stable
set search_path = public
as $$
begin
  return (
  with
    params as (
      select least(greatest(coalesce(input_limit, 100), 1), 500)::integer as limit_value
    ),
    flat_rows as (
      select
        s.id,
        s.client,
        s.time,
        coalesce((device->>'device_index')::integer, 0) as device_index,
        coalesce(device->>'device_name', '') as device_name,
        coalesce((device->>'mem_total')::double precision, 0) as mem_total,
        coalesce((device->>'mem_used')::double precision, 0) as mem_used,
        coalesce((device->>'utilization')::double precision, 0) as utilization,
        coalesce((device->>'temperature')::double precision, 0) as temperature
      from gpu_snapshots s
      cross join lateral jsonb_array_elements(case when jsonb_typeof(s.devices_json) = 'array' then s.devices_json else '[]'::jsonb end) device
      where s.client = input_client
        and (input_start is null or s.time >= input_start::timestamptz)
        and (input_end is null or s.time <= input_end::timestamptz)
        and (input_cursor is null or s.time < input_cursor::timestamptz)
      order by s.time desc, device_index asc
      limit (select limit_value + 1 from params)
    ),
    numbered as (
      select flat_rows.*, row_number() over (order by time asc, device_index asc) as rn
      from flat_rows
    ),
    data_rows as (
      select id, client, time, device_index, device_name, mem_total, mem_used, utilization, temperature
      from numbered, params
      where not ((select count(*) from flat_rows) > params.limit_value and rn = 1)
    )
  select jsonb_strip_nulls(jsonb_build_object(
    'data', coalesce((select jsonb_agg(to_jsonb(data_rows) order by time asc, device_index asc) from data_rows), '[]'::jsonb),
    'total', (select count(*) from data_rows) + case when (select count(*) from flat_rows) > params.limit_value then 1 else 0 end,
    'page', 1,
    'limit', params.limit_value,
    'has_more', (select count(*) from flat_rows) > params.limit_value,
    'next_cursor', case when (select count(*) from flat_rows) > params.limit_value then (select min(time) from data_rows) else null end
  ))
  from params
  );
end;
$$;

create or replace function public.cfm_ping_records(input_client text, input_task_id integer, input_limit integer default 120)
returns jsonb
language plpgsql
stable
set search_path = public
as $$
begin
  return (
  select coalesce(jsonb_agg(to_jsonb(row_data) order by time asc), '[]'::jsonb)
  from (
    select
      id,
      client,
      input_task_id as task_id,
      time,
      (values_json ->> input_task_id::text)::integer as value
    from ping_snapshots
    where client = input_client
      and values_json ? input_task_id::text
    order by time desc
    limit least(greatest(coalesce(input_limit, 120), 1), 1000)
  ) row_data
  );
end;
$$;

create or replace function public.cfm_ping_records_paged(
  input_client text,
  input_task_id integer,
  input_page integer default 1,
  input_limit integer default 120
)
returns jsonb
language plpgsql
stable
set search_path = public
as $$
begin
  return (
  with
    params as (
      select
        greatest(coalesce(input_page, 1), 1)::integer as page,
        least(greatest(coalesce(input_limit, 120), 1), 500)::integer as limit_value
    ),
    raw_rows as (
      select
        id,
        client,
        input_task_id as task_id,
        time,
        (values_json ->> input_task_id::text)::integer as value
      from ping_snapshots, params
      where client = input_client
        and values_json ? input_task_id::text
      order by time desc
      limit (select limit_value + 1 from params)
      offset (select (page - 1) * limit_value from params)
    ),
    numbered as (
      select raw_rows.*, row_number() over (order by time asc) as rn
      from raw_rows
    ),
    data_rows as (
      select id, client, task_id, time, value
      from numbered, params
      where not ((select count(*) from raw_rows) > params.limit_value and rn = 1)
    )
  select jsonb_build_object(
    'data', coalesce((select jsonb_agg(to_jsonb(data_rows) order by time asc) from data_rows), '[]'::jsonb),
    'total', (params.page - 1) * params.limit_value + (select count(*) from data_rows) + case when (select count(*) from raw_rows) > params.limit_value then 1 else 0 end,
    'page', params.page,
    'limit', params.limit_value,
    'has_more', (select count(*) from raw_rows) > params.limit_value
  )
  from params
  );
end;
$$;

create or replace function public.cfm_ping_records_cursor(
  input_client text,
  input_task_id integer,
  input_cursor text default null,
  input_limit integer default 120
)
returns jsonb
language plpgsql
stable
set search_path = public
as $$
begin
  return (
  with
    params as (
      select least(greatest(coalesce(input_limit, 120), 1), 500)::integer as limit_value
    ),
    raw_rows as (
      select
        id,
        client,
        input_task_id as task_id,
        time,
        (values_json ->> input_task_id::text)::integer as value
      from ping_snapshots, params
      where client = input_client
        and values_json ? input_task_id::text
        and (input_cursor is null or time < input_cursor::timestamptz)
      order by time desc
      limit (select limit_value + 1 from params)
    ),
    numbered as (
      select raw_rows.*, row_number() over (order by time asc) as rn
      from raw_rows
    ),
    data_rows as (
      select id, client, task_id, time, value
      from numbered, params
      where not ((select count(*) from raw_rows) > params.limit_value and rn = 1)
    )
  select jsonb_strip_nulls(jsonb_build_object(
    'data', coalesce((select jsonb_agg(to_jsonb(data_rows) order by time asc) from data_rows), '[]'::jsonb),
    'total', (select count(*) from data_rows) + case when (select count(*) from raw_rows) > params.limit_value then 1 else 0 end,
    'page', 1,
    'limit', params.limit_value,
    'has_more', (select count(*) from raw_rows) > params.limit_value,
    'next_cursor', case when (select count(*) from raw_rows) > params.limit_value then (select min(time) from data_rows) else null end
  ))
  from params
  );
end;
$$;

create or replace function public.cfm_ping_records_for_tasks(
  input_client text,
  input_task_ids jsonb,
  input_limit integer default 120,
  input_cursor text default null
)
returns jsonb
language plpgsql
stable
set search_path = public
as $$
declare
  task_id integer;
  safe_limit integer := least(greatest(coalesce(input_limit, 120), 1), 1000);
  result jsonb := '{}'::jsonb;
begin
  for task_id in
    select distinct value::integer
    from jsonb_array_elements_text(case when jsonb_typeof(input_task_ids) = 'array' then input_task_ids else '[]'::jsonb end) as value
    where value ~ '^[0-9]+$' and value::integer > 0
  loop
    result := result || jsonb_build_object(
      task_id::text,
      coalesce((
        select jsonb_agg(to_jsonb(row_data) order by time asc)
        from (
          select
            id,
            client,
            task_id as task_id,
            time,
            (values_json ->> task_id::text)::integer as value
          from ping_snapshots
          where client = input_client
            and values_json ? task_id::text
            and (input_cursor is null or time < input_cursor::timestamptz)
          order by time desc
          limit safe_limit
        ) row_data
      ), '[]'::jsonb)
    );
  end loop;

  return result;
end;
$$;

create or replace function public.cfm_history_storage_counts()
returns jsonb
language sql
stable
set search_path = public
as $$
  select jsonb_build_object(
    'records', (select count(*) from records),
    'gpu_records', (select count(*) from gpu_records),
    'gpu_snapshots', (select count(*) from gpu_snapshots),
    'ping_records', (select count(*) from ping_records),
    'ping_snapshots', (select count(*) from ping_snapshots)
  );
$$;

create or replace function public.cfm_storage_row_counts()
returns jsonb
language sql
stable
set search_path = public
as $$
  select jsonb_build_object(
    'records', (select count(*) from records),
    'gpu_records', (select count(*) from gpu_records),
    'gpu_snapshots', (select count(*) from gpu_snapshots),
    'ping_records', (select count(*) from ping_records),
    'ping_snapshots', (select count(*) from ping_snapshots),
    'audit_logs', (select count(*) from audit_logs)
  );
$$;

create or replace function public.cfm_bounded_storage_row_counts(input_limit integer default 100000)
returns jsonb
language plpgsql
stable
set search_path = public
as $$
begin
  return (
  with
    args as (
      select greatest(coalesce(input_limit, 100000), 1)::integer as safe_limit
    ),
    raw_counts as (
      select
        (select count(*) from (select 1 from records limit (select safe_limit + 1 from args)) s)::integer as records,
        (select count(*) from (select 1 from gpu_records limit (select safe_limit + 1 from args)) s)::integer as gpu_records,
        (select count(*) from (select 1 from gpu_snapshots limit (select safe_limit + 1 from args)) s)::integer as gpu_snapshots,
        (select count(*) from (select 1 from ping_records limit (select safe_limit + 1 from args)) s)::integer as ping_records,
        (select count(*) from (select 1 from ping_snapshots limit (select safe_limit + 1 from args)) s)::integer as ping_snapshots,
        (select count(*) from (select 1 from audit_logs limit (select safe_limit + 1 from args)) s)::integer as audit_logs
    )
  select jsonb_build_object(
    'counts', jsonb_build_object(
      'records', least(raw_counts.records, args.safe_limit),
      'gpu_records', least(raw_counts.gpu_records, args.safe_limit),
      'gpu_snapshots', least(raw_counts.gpu_snapshots, args.safe_limit),
      'ping_records', least(raw_counts.ping_records, args.safe_limit),
      'ping_snapshots', least(raw_counts.ping_snapshots, args.safe_limit),
      'audit_logs', least(raw_counts.audit_logs, args.safe_limit)
    ),
    'capped', jsonb_strip_nulls(jsonb_build_object(
      'records', case when raw_counts.records > args.safe_limit then true end,
      'gpu_records', case when raw_counts.gpu_records > args.safe_limit then true end,
      'gpu_snapshots', case when raw_counts.gpu_snapshots > args.safe_limit then true end,
      'ping_records', case when raw_counts.ping_records > args.safe_limit then true end,
      'ping_snapshots', case when raw_counts.ping_snapshots > args.safe_limit then true end,
      'audit_logs', case when raw_counts.audit_logs > args.safe_limit then true end
    )),
    'limit', args.safe_limit
  )
  from args, raw_counts
  );
end;
$$;

create or replace function public.cfm_expired_row_counts(
  input_records_before text,
  input_ping_records_before text,
  input_audit_logs_before text
)
returns jsonb
language sql
stable
set search_path = public
as $$
  select jsonb_build_object(
    'records', (select count(*) from records where time < input_records_before::timestamptz),
    'gpu_records', (select count(*) from gpu_records where time < input_records_before::timestamptz),
    'gpu_snapshots', (select count(*) from gpu_snapshots where time < input_records_before::timestamptz),
    'ping_records', (select count(*) from ping_records where time < input_ping_records_before::timestamptz),
    'ping_snapshots', (select count(*) from ping_snapshots where time < input_ping_records_before::timestamptz),
    'audit_logs', (select count(*) from audit_logs where time < input_audit_logs_before::timestamptz)
  );
$$;

create or replace function public.cfm_public_ping_tasks()
returns jsonb
language sql
stable
set search_path = public
as $$
  select coalesce(jsonb_agg(to_jsonb(row_data)), '[]'::jsonb)
  from (
    select id, name, clients, all_clients, type, target, interval_sec, sort_order
    from ping_tasks
    order by sort_order asc, id asc
  ) row_data;
$$;

create or replace function public.cfm_public_websites(period_hours int default 24, check_limit int default 120)
returns jsonb
language sql
stable
set search_path = public
as $$
  with args as (
    select
      least(greatest(coalesce(period_hours, 24), 1), 72) as safe_hours,
      least(greatest(coalesce(check_limit, 120), 1), 120) as safe_limit
  ),
  monitor_rows as (
    select
      id, name, url, interval_sec, status, last_checked_at,
      last_status_code, last_raw_status_code, last_latency_ms, last_effective_reason
    from website_monitors
    where hidden = false
    order by sort_order asc, id asc
  ),
  check_rows as (
    select *
    from (
      select
        wc.monitor_id, wc.checked_at, wc.ok, wc.effective_status, wc.effective_reason,
        wc.status_code, wc.raw_status_code, wc.latency_ms, wc.source_type, wc.source_client,
        row_number() over (
          partition by wc.monitor_id,
          floor(extract(epoch from (now() - wc.checked_at)) / greatest(60, floor((a.safe_hours * 60 * 60) / a.safe_limit)))
          order by wc.checked_at desc, wc.id desc
        ) as rn
      from website_checks wc
      cross join args a
      where wc.checked_at >= now() - (a.safe_hours * interval '1 hour')
        and wc.source_type = 'worker'
    ) ranked
    where rn = 1
  )
  select coalesce(jsonb_agg(
    to_jsonb(m) || jsonb_build_object(
      'checks',
      coalesce((
        select jsonb_agg(to_jsonb(c) - 'monitor_id' - 'rn' order by c.checked_at desc)
        from check_rows c
        where c.monitor_id = m.id
      ), '[]'::jsonb)
    )
  ), '[]'::jsonb)
  from monitor_rows m;
$$;

create or replace function public.cfm_public_website_monitor(input_id integer, input_check_limit integer default 120, input_include_hidden boolean default false)
returns jsonb
language plpgsql
stable
set search_path = public
as $$
begin
  return (
  with
    args as (
      select least(greatest(coalesce(input_check_limit, 120), 1), 500) as safe_limit
    ),
    monitor_row as (
      select
        id, name, url, interval_sec, status, last_checked_at,
        last_status_code, last_raw_status_code, last_latency_ms, last_effective_reason
      from website_monitors
      where id = input_id
        and (input_include_hidden or hidden = false)
      limit 1
    ),
    check_rows as (
      select checked_at, ok, effective_status, effective_reason, status_code, raw_status_code, latency_ms, source_type, source_client
      from website_checks, args
      where monitor_id = input_id
      order by checked_at desc, id desc
      limit args.safe_limit
    )
  select to_jsonb(m) || jsonb_build_object(
    'checks',
    coalesce((select jsonb_agg(to_jsonb(c) order by c.checked_at desc) from check_rows c), '[]'::jsonb)
  )
  from monitor_row m
  );
end;
$$;

create or replace function public.cfm_website_monitors()
returns jsonb
language sql
stable
set search_path = public
as $$
  select coalesce(jsonb_agg(to_jsonb(row_data) order by sort_order asc, id asc), '[]'::jsonb)
  from (
    select *
    from website_monitors
    order by sort_order asc, id asc
  ) row_data;
$$;

create or replace function public.cfm_website_monitor(input_id integer)
returns jsonb
language sql
stable
set search_path = public
as $$
  select to_jsonb(row_data)
  from (
    select *
    from website_monitors
    where id = input_id
    limit 1
  ) row_data;
$$;

create or replace function public.cfm_website_checks(input_monitor_id integer, input_limit integer default 60)
returns jsonb
language plpgsql
stable
set search_path = public
as $$
begin
  return (
  select coalesce(jsonb_agg(to_jsonb(row_data) order by checked_at desc, id desc), '[]'::jsonb)
  from (
    select *
    from website_checks
    where monitor_id = input_monitor_id
    order by checked_at desc, id desc
    limit least(greatest(coalesce(input_limit, 60), 1), 500)
  ) row_data
  );
end;
$$;

create or replace function public.cfm_create_website_monitor(input_monitor jsonb)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  created_row website_monitors%rowtype;
begin
  insert into website_monitors (
    name, url, method, expected_status_min, expected_status_max,
    interval_sec, timeout_sec, grace_period_sec, enabled, hidden,
    agent_probe_mode, agent_probe_clients, agent_probe_limit, agent_probe_status_enabled,
    sort_order
  ) values (
    coalesce(input_monitor->>'name', ''),
    coalesce(input_monitor->>'url', ''),
    coalesce(input_monitor->>'method', 'GET'),
    coalesce((input_monitor->>'expected_status_min')::integer, 200),
    coalesce((input_monitor->>'expected_status_max')::integer, 399),
    coalesce((input_monitor->>'interval_sec')::integer, 120),
    coalesce((input_monitor->>'timeout_sec')::integer, 10),
    coalesce((input_monitor->>'grace_period_sec')::integer, 180),
    coalesce((input_monitor->>'enabled')::boolean, true),
    coalesce((input_monitor->>'hidden')::boolean, false),
    case when input_monitor->>'agent_probe_mode' in ('off', 'selected', 'country_auto') then input_monitor->>'agent_probe_mode' else 'off' end,
    case when input_monitor ? 'agent_probe_clients' and jsonb_typeof(input_monitor->'agent_probe_clients') = 'array' then input_monitor->'agent_probe_clients' else '[]'::jsonb end,
    least(greatest(coalesce((input_monitor->>'agent_probe_limit')::integer, 3), 1), 10),
    coalesce((input_monitor->>'agent_probe_status_enabled')::boolean, false),
    (select coalesce(max(sort_order), 0) + 1 from website_monitors)
  )
  returning * into created_row;

  return to_jsonb(created_row);
end;
$$;

create or replace function public.cfm_update_website_monitor(input_id integer, input_monitor jsonb)
returns jsonb
language sql
set search_path = public
as $$
  update website_monitors
  set
    name = coalesce(input_monitor->>'name', name),
    url = coalesce(input_monitor->>'url', url),
    method = coalesce(input_monitor->>'method', method),
    expected_status_min = coalesce((input_monitor->>'expected_status_min')::integer, expected_status_min),
    expected_status_max = coalesce((input_monitor->>'expected_status_max')::integer, expected_status_max),
    interval_sec = coalesce((input_monitor->>'interval_sec')::integer, interval_sec),
    timeout_sec = coalesce((input_monitor->>'timeout_sec')::integer, timeout_sec),
    grace_period_sec = coalesce((input_monitor->>'grace_period_sec')::integer, grace_period_sec),
    enabled = case when input_monitor ? 'enabled' then coalesce((input_monitor->>'enabled')::boolean, enabled) else enabled end,
    hidden = case when input_monitor ? 'hidden' then coalesce((input_monitor->>'hidden')::boolean, hidden) else hidden end,
    agent_probe_mode = case when input_monitor->>'agent_probe_mode' in ('off', 'selected', 'country_auto') then input_monitor->>'agent_probe_mode' else agent_probe_mode end,
    agent_probe_clients = case when input_monitor ? 'agent_probe_clients' and jsonb_typeof(input_monitor->'agent_probe_clients') = 'array' then input_monitor->'agent_probe_clients' else agent_probe_clients end,
    agent_probe_limit = case when input_monitor ? 'agent_probe_limit' then least(greatest(coalesce((input_monitor->>'agent_probe_limit')::integer, agent_probe_limit), 1), 10) else agent_probe_limit end,
    agent_probe_status_enabled = case when input_monitor ? 'agent_probe_status_enabled' then coalesce((input_monitor->>'agent_probe_status_enabled')::boolean, agent_probe_status_enabled) else agent_probe_status_enabled end,
    updated_at = now()
  where id = input_id
  returning to_jsonb(website_monitors.*);
$$;

create or replace function public.cfm_delete_website_monitor(input_id integer)
returns void
language sql
set search_path = public
as $$
  delete from website_monitors where id = input_id;
$$;

create or replace function public.cfm_reorder_website_monitors(input_ids jsonb)
returns integer
language plpgsql
set search_path = public
as $$
declare
  input_id integer;
  final_id integer;
  final_ids integer[] := '{}';
  changed_count integer := 0;
  next_order integer := 1;
  old_order integer;
begin
  for input_id in
    select distinct value::integer
    from jsonb_array_elements_text(case when jsonb_typeof(input_ids) = 'array' then input_ids else '[]'::jsonb end) as value
    where value ~ '^[0-9]+$' and value::integer > 0
  loop
    final_ids := array_append(final_ids, input_id);
  end loop;

  if cardinality(final_ids) = 0 then
    return 0;
  end if;

  if exists (
    select 1
    from unnest(final_ids) id
    where not exists (select 1 from website_monitors where website_monitors.id = id)
  ) then
    raise exception 'Website monitor id does not exist';
  end if;

  for final_id in
    select id
    from website_monitors
    where not (id = any(final_ids))
    order by sort_order asc, id asc
  loop
    final_ids := array_append(final_ids, final_id);
  end loop;

  foreach final_id in array final_ids loop
    select sort_order into old_order from website_monitors where id = final_id;
    if old_order is distinct from next_order then
      update website_monitors set sort_order = next_order, updated_at = now() where id = final_id;
      changed_count := changed_count + 1;
    end if;
    next_order := next_order + 1;
  end loop;

  return changed_count;
end;
$$;

create or replace function public.cfm_set_website_monitor_visibility(input_id integer, input_hidden boolean)
returns boolean
language plpgsql
set search_path = public
as $$
declare
  updated_count integer;
begin
  update website_monitors
  set hidden = input_hidden, updated_at = now()
  where id = input_id and hidden is distinct from input_hidden;

  get diagnostics updated_count = row_count;
  return updated_count > 0;
end;
$$;

create or replace function public.cfm_set_website_monitor_enabled(input_id integer, input_enabled boolean)
returns boolean
language plpgsql
set search_path = public
as $$
declare
  updated_count integer;
begin
  update website_monitors
  set
    enabled = input_enabled,
    status = case when input_enabled then status else 'paused' end,
    updated_at = now()
  where id = input_id
    and (enabled is distinct from input_enabled or (not input_enabled and status is distinct from 'paused'));

  get diagnostics updated_count = row_count;
  return updated_count > 0;
end;
$$;

create or replace function public.cfm_login_user(input_username text)
returns jsonb
language sql
stable
set search_path = public
as $$
  select to_jsonb(row_data)
  from (
    select uuid, username, passwd, session_version, password_changed_at, created_at, updated_at
    from users
    where username = input_username
    limit 1
  ) row_data;
$$;

create or replace function public.cfm_users_count()
returns integer
language sql
stable
set search_path = public
as $$
  select count(*)::integer
  from users;
$$;

create or replace function public.cfm_user_by_uuid(input_uuid text)
returns jsonb
language sql
stable
set search_path = public
as $$
  select to_jsonb(row_data)
  from (
    select uuid, username, passwd, session_version, password_changed_at, created_at, updated_at
    from users
    where uuid = input_uuid
    limit 1
  ) row_data;
$$;

create or replace function public.cfm_update_user_username(input_uuid text, input_username text)
returns void
language plpgsql
set search_path = public
as $$
begin
  update users
  set username = input_username,
      updated_at = now()
  where uuid = input_uuid;
end;
$$;

create or replace function public.cfm_update_user_password(input_uuid text, input_passwd text)
returns void
language plpgsql
set search_path = public
as $$
begin
  update users
  set passwd = input_passwd,
      updated_at = now()
  where uuid = input_uuid;
end;
$$;

create or replace function public.cfm_update_user_password_rotate_session(input_uuid text, input_passwd text)
returns jsonb
language sql
set search_path = public
as $$
  update users
  set passwd = input_passwd,
      session_version = session_version + 1,
      password_changed_at = now(),
      updated_at = now()
  where uuid = input_uuid
  returning to_jsonb(users);
$$;

create or replace function public.cfm_validate_admin_session(user_uuid text, expected_session_version int)
returns jsonb
language sql
stable
set search_path = public
as $$
  select to_jsonb(row_data)
  from (
    select uuid, username, session_version
    from users
    where uuid = user_uuid
      and session_version = expected_session_version
    limit 1
  ) row_data;
$$;

drop function if exists public.cfm_ensure_initial_admin(text, text);

create or replace function public.cfm_ensure_initial_admin(input_uuid text, input_username text, input_passwd text)
returns void
language plpgsql
set search_path = public
as $$
begin
  if exists (select 1 from users limit 1) then
    return;
  end if;

  insert into users (uuid, username, passwd)
  values (input_uuid, input_username, input_passwd);
end;
$$;

revoke all on function public.cfm_public_settings() from public;
revoke all on function public.cfm_public_settings() from anon;
revoke all on function public.cfm_public_settings() from authenticated;
grant execute on function public.cfm_public_settings() to service_role;

revoke all on function public.cfm_set_settings(jsonb) from public;
revoke all on function public.cfm_set_settings(jsonb) from anon;
revoke all on function public.cfm_set_settings(jsonb) from authenticated;
grant execute on function public.cfm_set_settings(jsonb) to service_role;

revoke all on function public.cfm_public_clients() from public;
revoke all on function public.cfm_public_clients() from anon;
revoke all on function public.cfm_public_clients() from authenticated;
grant execute on function public.cfm_public_clients() to service_role;

revoke all on function public.cfm_admin_clients() from public;
revoke all on function public.cfm_admin_clients() from anon;
revoke all on function public.cfm_admin_clients() from authenticated;
grant execute on function public.cfm_admin_clients() to service_role;

revoke all on function public.cfm_client_exists(text) from public;
revoke all on function public.cfm_client_exists(text) from anon;
revoke all on function public.cfm_client_exists(text) from authenticated;
grant execute on function public.cfm_client_exists(text) to service_role;

revoke all on function public.cfm_client_visibility(text) from public;
revoke all on function public.cfm_client_visibility(text) from anon;
revoke all on function public.cfm_client_visibility(text) from authenticated;
grant execute on function public.cfm_client_visibility(text) to service_role;

revoke all on function public.cfm_scheduled_clients() from public;
revoke all on function public.cfm_scheduled_clients() from anon;
revoke all on function public.cfm_scheduled_clients() from authenticated;
grant execute on function public.cfm_scheduled_clients() to service_role;

revoke all on function public.cfm_scheduled_clients_by_ids(jsonb) from public;
revoke all on function public.cfm_scheduled_clients_by_ids(jsonb) from anon;
revoke all on function public.cfm_scheduled_clients_by_ids(jsonb) from authenticated;
grant execute on function public.cfm_scheduled_clients_by_ids(jsonb) to service_role;

revoke all on function public.cfm_client(text) from public;
revoke all on function public.cfm_client(text) from anon;
revoke all on function public.cfm_client(text) from authenticated;
grant execute on function public.cfm_client(text) to service_role;

revoke all on function public.cfm_client_token_meta(text) from public;
revoke all on function public.cfm_client_token_meta(text) from anon;
revoke all on function public.cfm_client_token_meta(text) from authenticated;
grant execute on function public.cfm_client_token_meta(text) to service_role;

revoke all on function public.cfm_clients_by_ids(jsonb) from public;
revoke all on function public.cfm_clients_by_ids(jsonb) from anon;
revoke all on function public.cfm_clients_by_ids(jsonb) from authenticated;
grant execute on function public.cfm_clients_by_ids(jsonb) to service_role;

revoke all on function public.cfm_client_ids() from public;
revoke all on function public.cfm_client_ids() from anon;
revoke all on function public.cfm_client_ids() from authenticated;
grant execute on function public.cfm_client_ids() to service_role;

revoke all on function public.cfm_agent_client_by_token(text, text) from public;
revoke all on function public.cfm_agent_client_by_token(text, text) from anon;
revoke all on function public.cfm_agent_client_by_token(text, text) from authenticated;
grant execute on function public.cfm_agent_client_by_token(text, text) to service_role;

revoke all on function public.cfm_agent_client_identity_by_token(text, text) from public;
revoke all on function public.cfm_agent_client_identity_by_token(text, text) from anon;
revoke all on function public.cfm_agent_client_identity_by_token(text, text) from authenticated;
grant execute on function public.cfm_agent_client_identity_by_token(text, text) to service_role;

revoke all on function public.cfm_client_token_exists(text, text) from public;
revoke all on function public.cfm_client_token_exists(text, text) from anon;
revoke all on function public.cfm_client_token_exists(text, text) from authenticated;
grant execute on function public.cfm_client_token_exists(text, text) to service_role;

revoke all on function public.cfm_client_create_conflict(text, text, text) from public;
revoke all on function public.cfm_client_create_conflict(text, text, text) from anon;
revoke all on function public.cfm_client_create_conflict(text, text, text) from authenticated;
grant execute on function public.cfm_client_create_conflict(text, text, text) to service_role;

revoke all on function public.cfm_create_client(jsonb) from public;
revoke all on function public.cfm_create_client(jsonb) from anon;
revoke all on function public.cfm_create_client(jsonb) from authenticated;
grant execute on function public.cfm_create_client(jsonb) to service_role;

revoke all on function public.cfm_mark_client_token_used(text, text) from public;
revoke all on function public.cfm_mark_client_token_used(text, text) from anon;
revoke all on function public.cfm_mark_client_token_used(text, text) from authenticated;
grant execute on function public.cfm_mark_client_token_used(text, text) to service_role;

drop function if exists public.cfm_rotate_client_token(text, text);
drop function if exists public.cfm_set_client_install_token(text, text);

revoke all on function public.cfm_rotate_client_token(text, text, text) from public;
revoke all on function public.cfm_rotate_client_token(text, text, text) from anon;
revoke all on function public.cfm_rotate_client_token(text, text, text) from authenticated;
grant execute on function public.cfm_rotate_client_token(text, text, text) to service_role;

revoke all on function public.cfm_update_client(text, jsonb) from public;
revoke all on function public.cfm_update_client(text, jsonb) from anon;
revoke all on function public.cfm_update_client(text, jsonb) from authenticated;
grant execute on function public.cfm_update_client(text, jsonb) to service_role;

revoke all on function public.cfm_update_client_returning(text, jsonb) from public;
revoke all on function public.cfm_update_client_returning(text, jsonb) from anon;
revoke all on function public.cfm_update_client_returning(text, jsonb) from authenticated;
grant execute on function public.cfm_update_client_returning(text, jsonb) to service_role;

revoke all on function public.cfm_delete_clients(jsonb) from public;
revoke all on function public.cfm_delete_clients(jsonb) from anon;
revoke all on function public.cfm_delete_clients(jsonb) from authenticated;
grant execute on function public.cfm_delete_clients(jsonb) to service_role;

revoke all on function public.cfm_prune_client_references(jsonb) from public;
revoke all on function public.cfm_prune_client_references(jsonb) from anon;
revoke all on function public.cfm_prune_client_references(jsonb) from authenticated;
grant execute on function public.cfm_prune_client_references(jsonb) to service_role;

revoke all on function public.cfm_cleanup_orphan_client_data() from public;
revoke all on function public.cfm_cleanup_orphan_client_data() from anon;
revoke all on function public.cfm_cleanup_orphan_client_data() from authenticated;
grant execute on function public.cfm_cleanup_orphan_client_data() to service_role;

revoke all on function public.cfm_update_clients_hidden(jsonb, boolean) from public;
revoke all on function public.cfm_update_clients_hidden(jsonb, boolean) from anon;
revoke all on function public.cfm_update_clients_hidden(jsonb, boolean) from authenticated;
grant execute on function public.cfm_update_clients_hidden(jsonb, boolean) to service_role;

revoke all on function public.cfm_reorder_clients(jsonb) from public;
revoke all on function public.cfm_reorder_clients(jsonb) from anon;
revoke all on function public.cfm_reorder_clients(jsonb) from authenticated;
grant execute on function public.cfm_reorder_clients(jsonb) to service_role;

revoke all on function public.cfm_client_capacity_counts() from public;
revoke all on function public.cfm_client_capacity_counts() from anon;
revoke all on function public.cfm_client_capacity_counts() from authenticated;
grant execute on function public.cfm_client_capacity_counts() to service_role;

revoke all on function public.cfm_ping_task_estimate_rows() from public;
revoke all on function public.cfm_ping_task_estimate_rows() from anon;
revoke all on function public.cfm_ping_task_estimate_rows() from authenticated;
grant execute on function public.cfm_ping_task_estimate_rows() to service_role;

revoke all on function public.cfm_ping_task(integer) from public;
revoke all on function public.cfm_ping_task(integer) from anon;
revoke all on function public.cfm_ping_task(integer) from authenticated;
grant execute on function public.cfm_ping_task(integer) to service_role;

revoke all on function public.cfm_create_ping_task(jsonb) from public;
revoke all on function public.cfm_create_ping_task(jsonb) from anon;
revoke all on function public.cfm_create_ping_task(jsonb) from authenticated;
grant execute on function public.cfm_create_ping_task(jsonb) to service_role;

revoke all on function public.cfm_update_ping_task(integer, jsonb) from public;
revoke all on function public.cfm_update_ping_task(integer, jsonb) from anon;
revoke all on function public.cfm_update_ping_task(integer, jsonb) from authenticated;
grant execute on function public.cfm_update_ping_task(integer, jsonb) to service_role;

revoke all on function public.cfm_reorder_ping_tasks(jsonb) from public;
revoke all on function public.cfm_reorder_ping_tasks(jsonb) from anon;
revoke all on function public.cfm_reorder_ping_tasks(jsonb) from authenticated;
grant execute on function public.cfm_reorder_ping_tasks(jsonb) to service_role;

revoke all on function public.cfm_delete_ping_task(integer) from public;
revoke all on function public.cfm_delete_ping_task(integer) from anon;
revoke all on function public.cfm_delete_ping_task(integer) from authenticated;
grant execute on function public.cfm_delete_ping_task(integer) to service_role;

revoke all on function public.cfm_delete_old_records(text, integer) from public;
revoke all on function public.cfm_delete_old_records(text, integer) from anon;
revoke all on function public.cfm_delete_old_records(text, integer) from authenticated;
grant execute on function public.cfm_delete_old_records(text, integer) to service_role;

revoke all on function public.cfm_delete_old_website_checks(text, integer) from public;
revoke all on function public.cfm_delete_old_website_checks(text, integer) from anon;
revoke all on function public.cfm_delete_old_website_checks(text, integer) from authenticated;
grant execute on function public.cfm_delete_old_website_checks(text, integer) to service_role;

revoke all on function public.cfm_delete_old_ping_records(text, integer) from public;
revoke all on function public.cfm_delete_old_ping_records(text, integer) from anon;
revoke all on function public.cfm_delete_old_ping_records(text, integer) from authenticated;
grant execute on function public.cfm_delete_old_ping_records(text, integer) to service_role;

revoke all on function public.cfm_delete_old_audit_logs(text, integer) from public;
revoke all on function public.cfm_delete_old_audit_logs(text, integer) from anon;
revoke all on function public.cfm_delete_old_audit_logs(text, integer) from authenticated;
grant execute on function public.cfm_delete_old_audit_logs(text, integer) to service_role;

revoke all on function public.cfm_offline_notification(text) from public;
revoke all on function public.cfm_offline_notification(text) from anon;
revoke all on function public.cfm_offline_notification(text) from authenticated;
grant execute on function public.cfm_offline_notification(text) to service_role;

revoke all on function public.cfm_offline_notifications() from public;
revoke all on function public.cfm_offline_notifications() from anon;
revoke all on function public.cfm_offline_notifications() from authenticated;
grant execute on function public.cfm_offline_notifications() to service_role;

revoke all on function public.cfm_set_offline_notifications(jsonb) from public;
revoke all on function public.cfm_set_offline_notifications(jsonb) from anon;
revoke all on function public.cfm_set_offline_notifications(jsonb) from authenticated;
grant execute on function public.cfm_set_offline_notifications(jsonb) to service_role;

revoke all on function public.cfm_mark_offline_notification_sent(text, text) from public;
revoke all on function public.cfm_mark_offline_notification_sent(text, text) from anon;
revoke all on function public.cfm_mark_offline_notification_sent(text, text) from authenticated;
grant execute on function public.cfm_mark_offline_notification_sent(text, text) to service_role;

revoke all on function public.cfm_expiry_notification(text) from public;
revoke all on function public.cfm_expiry_notification(text) from anon;
revoke all on function public.cfm_expiry_notification(text) from authenticated;
grant execute on function public.cfm_expiry_notification(text) to service_role;

revoke all on function public.cfm_expiry_notifications() from public;
revoke all on function public.cfm_expiry_notifications() from anon;
revoke all on function public.cfm_expiry_notifications() from authenticated;
grant execute on function public.cfm_expiry_notifications() to service_role;

revoke all on function public.cfm_set_expiry_notifications(jsonb) from public;
revoke all on function public.cfm_set_expiry_notifications(jsonb) from anon;
revoke all on function public.cfm_set_expiry_notifications(jsonb) from authenticated;
grant execute on function public.cfm_set_expiry_notifications(jsonb) to service_role;

revoke all on function public.cfm_mark_expiry_notification_sent(text, text) from public;
revoke all on function public.cfm_mark_expiry_notification_sent(text, text) from anon;
revoke all on function public.cfm_mark_expiry_notification_sent(text, text) from authenticated;
grant execute on function public.cfm_mark_expiry_notification_sent(text, text) to service_role;

revoke all on function public.cfm_audit_logs_paged(integer, integer) from public;
revoke all on function public.cfm_audit_logs_paged(integer, integer) from anon;
revoke all on function public.cfm_audit_logs_paged(integer, integer) from authenticated;
grant execute on function public.cfm_audit_logs_paged(integer, integer) to service_role;

revoke all on function public.cfm_themes() from public;
revoke all on function public.cfm_themes() from anon;
revoke all on function public.cfm_themes() from authenticated;
grant execute on function public.cfm_themes() to service_role;

revoke all on function public.cfm_theme(text) from public;
revoke all on function public.cfm_theme(text) from anon;
revoke all on function public.cfm_theme(text) from authenticated;
grant execute on function public.cfm_theme(text) to service_role;

revoke all on function public.cfm_upsert_theme(jsonb, jsonb) from public;
revoke all on function public.cfm_upsert_theme(jsonb, jsonb) from anon;
revoke all on function public.cfm_upsert_theme(jsonb, jsonb) from authenticated;
grant execute on function public.cfm_upsert_theme(jsonb, jsonb) to service_role;

revoke all on function public.cfm_update_theme_settings(text, text, text) from public;
revoke all on function public.cfm_update_theme_settings(text, text, text) from anon;
revoke all on function public.cfm_update_theme_settings(text, text, text) from authenticated;
grant execute on function public.cfm_update_theme_settings(text, text, text) to service_role;

revoke all on function public.cfm_delete_theme(text) from public;
revoke all on function public.cfm_delete_theme(text) from anon;
revoke all on function public.cfm_delete_theme(text) from authenticated;
grant execute on function public.cfm_delete_theme(text) to service_role;

revoke all on function public.cfm_theme_asset(text, text) from public;
revoke all on function public.cfm_theme_asset(text, text) from anon;
revoke all on function public.cfm_theme_asset(text, text) from authenticated;
grant execute on function public.cfm_theme_asset(text, text) to service_role;

revoke all on function public.cfm_load_notifications() from public;
revoke all on function public.cfm_load_notifications() from anon;
revoke all on function public.cfm_load_notifications() from authenticated;
grant execute on function public.cfm_load_notifications() to service_role;

revoke all on function public.cfm_load_notification(integer) from public;
revoke all on function public.cfm_load_notification(integer) from anon;
revoke all on function public.cfm_load_notification(integer) from authenticated;
grant execute on function public.cfm_load_notification(integer) to service_role;

revoke all on function public.cfm_create_load_notification(jsonb) from public;
revoke all on function public.cfm_create_load_notification(jsonb) from anon;
revoke all on function public.cfm_create_load_notification(jsonb) from authenticated;
grant execute on function public.cfm_create_load_notification(jsonb) to service_role;

revoke all on function public.cfm_load_metric_window_stats(jsonb, text, text, text, double precision) from public;
revoke all on function public.cfm_load_metric_window_stats(jsonb, text, text, text, double precision) from anon;
revoke all on function public.cfm_load_metric_window_stats(jsonb, text, text, text, double precision) from authenticated;
grant execute on function public.cfm_load_metric_window_stats(jsonb, text, text, text, double precision) to service_role;

revoke all on function public.cfm_update_load_notification(integer, jsonb) from public;
revoke all on function public.cfm_update_load_notification(integer, jsonb) from anon;
revoke all on function public.cfm_update_load_notification(integer, jsonb) from authenticated;
grant execute on function public.cfm_update_load_notification(integer, jsonb) to service_role;

revoke all on function public.cfm_delete_load_notification(integer) from public;
revoke all on function public.cfm_delete_load_notification(integer) from anon;
revoke all on function public.cfm_delete_load_notification(integer) from authenticated;
grant execute on function public.cfm_delete_load_notification(integer) to service_role;

revoke all on function public.cfm_due_website_monitors(text, integer) from public;
revoke all on function public.cfm_due_website_monitors(text, integer) from anon;
revoke all on function public.cfm_due_website_monitors(text, integer) from authenticated;
grant execute on function public.cfm_due_website_monitors(text, integer) to service_role;

revoke all on function public.cfm_record_website_check(jsonb) from public;
revoke all on function public.cfm_record_website_check(jsonb) from anon;
revoke all on function public.cfm_record_website_check(jsonb) from authenticated;
grant execute on function public.cfm_record_website_check(jsonb) to service_role;

revoke all on function public.cfm_agent_website_probe_tasks(text, text, integer) from public;
revoke all on function public.cfm_agent_website_probe_tasks(text, text, integer) from anon;
revoke all on function public.cfm_agent_website_probe_tasks(text, text, integer) from authenticated;
grant execute on function public.cfm_agent_website_probe_tasks(text, text, integer) to service_role;

revoke all on function public.cfm_mark_website_monitor_notified(integer, text) from public;
revoke all on function public.cfm_mark_website_monitor_notified(integer, text) from anon;
revoke all on function public.cfm_mark_website_monitor_notified(integer, text) from authenticated;
grant execute on function public.cfm_mark_website_monitor_notified(integer, text) to service_role;

revoke all on function public.cfm_insert_monitor_record(jsonb) from public;
revoke all on function public.cfm_insert_monitor_record(jsonb) from anon;
revoke all on function public.cfm_insert_monitor_record(jsonb) from authenticated;
grant execute on function public.cfm_insert_monitor_record(jsonb) to service_role;

revoke all on function public.cfm_insert_gpu_snapshot(text, text, jsonb) from public;
revoke all on function public.cfm_insert_gpu_snapshot(text, text, jsonb) from anon;
revoke all on function public.cfm_insert_gpu_snapshot(text, text, jsonb) from authenticated;
grant execute on function public.cfm_insert_gpu_snapshot(text, text, jsonb) to service_role;

revoke all on function public.cfm_insert_ping_snapshot(text, text, jsonb) from public;
revoke all on function public.cfm_insert_ping_snapshot(text, text, jsonb) from anon;
revoke all on function public.cfm_insert_ping_snapshot(text, text, jsonb) from authenticated;
grant execute on function public.cfm_insert_ping_snapshot(text, text, jsonb) to service_role;

revoke all on function public.cfm_recent_records(text, integer) from public;
revoke all on function public.cfm_recent_records(text, integer) from anon;
revoke all on function public.cfm_recent_records(text, integer) from authenticated;
grant execute on function public.cfm_recent_records(text, integer) to service_role;

revoke all on function public.cfm_latest_records() from public;
revoke all on function public.cfm_latest_records() from anon;
revoke all on function public.cfm_latest_records() from authenticated;
grant execute on function public.cfm_latest_records() to service_role;

revoke all on function public.cfm_records_range(text, text, text) from public;
revoke all on function public.cfm_records_range(text, text, text) from anon;
revoke all on function public.cfm_records_range(text, text, text) from authenticated;
grant execute on function public.cfm_records_range(text, text, text) to service_role;

revoke all on function public.cfm_records_range_limited(text, text, text, integer) from public;
revoke all on function public.cfm_records_range_limited(text, text, text, integer) from anon;
revoke all on function public.cfm_records_range_limited(text, text, text, integer) from authenticated;
grant execute on function public.cfm_records_range_limited(text, text, text, integer) to service_role;

revoke all on function public.cfm_records_range_paged(text, text, text, integer, integer) from public;
revoke all on function public.cfm_records_range_paged(text, text, text, integer, integer) from anon;
revoke all on function public.cfm_records_range_paged(text, text, text, integer, integer) from authenticated;
grant execute on function public.cfm_records_range_paged(text, text, text, integer, integer) to service_role;

revoke all on function public.cfm_records_range_cursor(text, text, text, text, integer) from public;
revoke all on function public.cfm_records_range_cursor(text, text, text, text, integer) from anon;
revoke all on function public.cfm_records_range_cursor(text, text, text, text, integer) from authenticated;
grant execute on function public.cfm_records_range_cursor(text, text, text, text, integer) to service_role;

revoke all on function public.cfm_latest_record_times() from public;
revoke all on function public.cfm_latest_record_times() from anon;
revoke all on function public.cfm_latest_record_times() from authenticated;
grant execute on function public.cfm_latest_record_times() to service_role;

revoke all on function public.cfm_latest_record_times_for_clients(jsonb) from public;
revoke all on function public.cfm_latest_record_times_for_clients(jsonb) from anon;
revoke all on function public.cfm_latest_record_times_for_clients(jsonb) from authenticated;
grant execute on function public.cfm_latest_record_times_for_clients(jsonb) to service_role;

revoke all on function public.cfm_gpu_records(text, text, text, integer) from public;
revoke all on function public.cfm_gpu_records(text, text, text, integer) from anon;
revoke all on function public.cfm_gpu_records(text, text, text, integer) from authenticated;
grant execute on function public.cfm_gpu_records(text, text, text, integer) to service_role;

revoke all on function public.cfm_gpu_records_paged(text, text, text, integer, integer) from public;
revoke all on function public.cfm_gpu_records_paged(text, text, text, integer, integer) from anon;
revoke all on function public.cfm_gpu_records_paged(text, text, text, integer, integer) from authenticated;
grant execute on function public.cfm_gpu_records_paged(text, text, text, integer, integer) to service_role;

revoke all on function public.cfm_gpu_records_cursor(text, text, text, text, integer) from public;
revoke all on function public.cfm_gpu_records_cursor(text, text, text, text, integer) from anon;
revoke all on function public.cfm_gpu_records_cursor(text, text, text, text, integer) from authenticated;
grant execute on function public.cfm_gpu_records_cursor(text, text, text, text, integer) to service_role;

revoke all on function public.cfm_ping_records(text, integer, integer) from public;
revoke all on function public.cfm_ping_records(text, integer, integer) from anon;
revoke all on function public.cfm_ping_records(text, integer, integer) from authenticated;
grant execute on function public.cfm_ping_records(text, integer, integer) to service_role;

revoke all on function public.cfm_ping_records_paged(text, integer, integer, integer) from public;
revoke all on function public.cfm_ping_records_paged(text, integer, integer, integer) from anon;
revoke all on function public.cfm_ping_records_paged(text, integer, integer, integer) from authenticated;
grant execute on function public.cfm_ping_records_paged(text, integer, integer, integer) to service_role;

revoke all on function public.cfm_ping_records_cursor(text, integer, text, integer) from public;
revoke all on function public.cfm_ping_records_cursor(text, integer, text, integer) from anon;
revoke all on function public.cfm_ping_records_cursor(text, integer, text, integer) from authenticated;
grant execute on function public.cfm_ping_records_cursor(text, integer, text, integer) to service_role;

revoke all on function public.cfm_ping_records_for_tasks(text, jsonb, integer, text) from public;
revoke all on function public.cfm_ping_records_for_tasks(text, jsonb, integer, text) from anon;
revoke all on function public.cfm_ping_records_for_tasks(text, jsonb, integer, text) from authenticated;
grant execute on function public.cfm_ping_records_for_tasks(text, jsonb, integer, text) to service_role;

revoke all on function public.cfm_history_storage_counts() from public;
revoke all on function public.cfm_history_storage_counts() from anon;
revoke all on function public.cfm_history_storage_counts() from authenticated;
grant execute on function public.cfm_history_storage_counts() to service_role;

revoke all on function public.cfm_storage_row_counts() from public;
revoke all on function public.cfm_storage_row_counts() from anon;
revoke all on function public.cfm_storage_row_counts() from authenticated;
grant execute on function public.cfm_storage_row_counts() to service_role;

revoke all on function public.cfm_bounded_storage_row_counts(integer) from public;
revoke all on function public.cfm_bounded_storage_row_counts(integer) from anon;
revoke all on function public.cfm_bounded_storage_row_counts(integer) from authenticated;
grant execute on function public.cfm_bounded_storage_row_counts(integer) to service_role;

revoke all on function public.cfm_expired_row_counts(text, text, text) from public;
revoke all on function public.cfm_expired_row_counts(text, text, text) from anon;
revoke all on function public.cfm_expired_row_counts(text, text, text) from authenticated;
grant execute on function public.cfm_expired_row_counts(text, text, text) to service_role;

revoke all on function public.cfm_public_ping_tasks() from public;
revoke all on function public.cfm_public_ping_tasks() from anon;
revoke all on function public.cfm_public_ping_tasks() from authenticated;
grant execute on function public.cfm_public_ping_tasks() to service_role;

revoke all on function public.cfm_public_websites(integer, integer) from public;
revoke all on function public.cfm_public_websites(integer, integer) from anon;
revoke all on function public.cfm_public_websites(integer, integer) from authenticated;
grant execute on function public.cfm_public_websites(integer, integer) to service_role;

drop function if exists public.cfm_public_website_monitor(integer, integer);

revoke all on function public.cfm_public_website_monitor(integer, integer, boolean) from public;
revoke all on function public.cfm_public_website_monitor(integer, integer, boolean) from anon;
revoke all on function public.cfm_public_website_monitor(integer, integer, boolean) from authenticated;
grant execute on function public.cfm_public_website_monitor(integer, integer, boolean) to service_role;

revoke all on function public.cfm_website_monitors() from public;
revoke all on function public.cfm_website_monitors() from anon;
revoke all on function public.cfm_website_monitors() from authenticated;
grant execute on function public.cfm_website_monitors() to service_role;

revoke all on function public.cfm_website_monitor(integer) from public;
revoke all on function public.cfm_website_monitor(integer) from anon;
revoke all on function public.cfm_website_monitor(integer) from authenticated;
grant execute on function public.cfm_website_monitor(integer) to service_role;

revoke all on function public.cfm_website_checks(integer, integer) from public;
revoke all on function public.cfm_website_checks(integer, integer) from anon;
revoke all on function public.cfm_website_checks(integer, integer) from authenticated;
grant execute on function public.cfm_website_checks(integer, integer) to service_role;

revoke all on function public.cfm_create_website_monitor(jsonb) from public;
revoke all on function public.cfm_create_website_monitor(jsonb) from anon;
revoke all on function public.cfm_create_website_monitor(jsonb) from authenticated;
grant execute on function public.cfm_create_website_monitor(jsonb) to service_role;

revoke all on function public.cfm_update_website_monitor(integer, jsonb) from public;
revoke all on function public.cfm_update_website_monitor(integer, jsonb) from anon;
revoke all on function public.cfm_update_website_monitor(integer, jsonb) from authenticated;
grant execute on function public.cfm_update_website_monitor(integer, jsonb) to service_role;

revoke all on function public.cfm_delete_website_monitor(integer) from public;
revoke all on function public.cfm_delete_website_monitor(integer) from anon;
revoke all on function public.cfm_delete_website_monitor(integer) from authenticated;
grant execute on function public.cfm_delete_website_monitor(integer) to service_role;

revoke all on function public.cfm_reorder_website_monitors(jsonb) from public;
revoke all on function public.cfm_reorder_website_monitors(jsonb) from anon;
revoke all on function public.cfm_reorder_website_monitors(jsonb) from authenticated;
grant execute on function public.cfm_reorder_website_monitors(jsonb) to service_role;

revoke all on function public.cfm_set_website_monitor_visibility(integer, boolean) from public;
revoke all on function public.cfm_set_website_monitor_visibility(integer, boolean) from anon;
revoke all on function public.cfm_set_website_monitor_visibility(integer, boolean) from authenticated;
grant execute on function public.cfm_set_website_monitor_visibility(integer, boolean) to service_role;

revoke all on function public.cfm_set_website_monitor_enabled(integer, boolean) from public;
revoke all on function public.cfm_set_website_monitor_enabled(integer, boolean) from anon;
revoke all on function public.cfm_set_website_monitor_enabled(integer, boolean) from authenticated;
grant execute on function public.cfm_set_website_monitor_enabled(integer, boolean) to service_role;

revoke all on function public.cfm_login_user(text) from public;
revoke all on function public.cfm_login_user(text) from anon;
revoke all on function public.cfm_login_user(text) from authenticated;
grant execute on function public.cfm_login_user(text) to service_role;

revoke all on function public.cfm_users_count() from public;
revoke all on function public.cfm_users_count() from anon;
revoke all on function public.cfm_users_count() from authenticated;
grant execute on function public.cfm_users_count() to service_role;

revoke all on function public.cfm_user_by_uuid(text) from public;
revoke all on function public.cfm_user_by_uuid(text) from anon;
revoke all on function public.cfm_user_by_uuid(text) from authenticated;
grant execute on function public.cfm_user_by_uuid(text) to service_role;

revoke all on function public.cfm_update_user_username(text, text) from public;
revoke all on function public.cfm_update_user_username(text, text) from anon;
revoke all on function public.cfm_update_user_username(text, text) from authenticated;
grant execute on function public.cfm_update_user_username(text, text) to service_role;

revoke all on function public.cfm_update_user_password(text, text) from public;
revoke all on function public.cfm_update_user_password(text, text) from anon;
revoke all on function public.cfm_update_user_password(text, text) from authenticated;
grant execute on function public.cfm_update_user_password(text, text) to service_role;

revoke all on function public.cfm_update_user_password_rotate_session(text, text) from public;
revoke all on function public.cfm_update_user_password_rotate_session(text, text) from anon;
revoke all on function public.cfm_update_user_password_rotate_session(text, text) from authenticated;
grant execute on function public.cfm_update_user_password_rotate_session(text, text) to service_role;

revoke all on function public.cfm_validate_admin_session(text, integer) from public;
revoke all on function public.cfm_validate_admin_session(text, integer) from anon;
revoke all on function public.cfm_validate_admin_session(text, integer) from authenticated;
grant execute on function public.cfm_validate_admin_session(text, integer) to service_role;

revoke all on function public.cfm_ensure_initial_admin(text, text, text) from public;
revoke all on function public.cfm_ensure_initial_admin(text, text, text) from anon;
revoke all on function public.cfm_ensure_initial_admin(text, text, text) from authenticated;
grant execute on function public.cfm_ensure_initial_admin(text, text, text) to service_role;

insert into settings (key, value)
values ('schema_bootstrap_version', 'postgres-2026-06-15-v22')
on conflict (key) do update set value = excluded.value;

notify pgrst, 'reload schema';

-- -----------------------------------------------------------------------------

-- Source: 20260625000000_supabase_only_rpc.sql
set local search_path = public;

create or replace function public.cfm_create_user(input_uuid text, input_username text, input_passwd text)
returns boolean
language plpgsql
set search_path = public
as $$
begin
  if nullif(trim(coalesce(input_uuid, '')), '') is null
    or nullif(trim(coalesce(input_username, '')), '') is null
    or coalesce(input_passwd, '') = ''
  then
    raise exception 'user uuid, username, and password hash are required';
  end if;

  insert into users (uuid, username, passwd, password_changed_at)
  values (input_uuid, input_username, input_passwd, now());
  return true;
end;
$$;

create or replace function public.cfm_delete_user_if_matches(input_uuid text, input_username text, input_passwd text)
returns boolean
language plpgsql
set search_path = public
as $$
declare
  deleted_count integer;
begin
  delete from users
  where uuid = input_uuid
    and username = input_username
    and passwd = input_passwd;
  get diagnostics deleted_count = row_count;
  return deleted_count > 0;
end;
$$;

create or replace function public.cfm_login_rate_limit(input_bucket text)
returns jsonb
language sql
stable
set search_path = public
as $$
  select to_jsonb(row_data)
  from (
    select bucket, failures, first_failed_at, last_failed_at, locked_until
    from login_rate_limits
    where bucket = input_bucket
    limit 1
  ) row_data;
$$;

create or replace function public.cfm_login_rate_limits(input_buckets jsonb)
returns jsonb
language sql
stable
set search_path = public
as $$
  with buckets as (
    select distinct value as bucket
    from jsonb_array_elements_text(case when jsonb_typeof(input_buckets) = 'array' then input_buckets else '[]'::jsonb end)
    where trim(value) <> ''
  )
  select coalesce(jsonb_agg(to_jsonb(l) order by l.bucket), '[]'::jsonb)
  from login_rate_limits l
  join buckets b on b.bucket = l.bucket;
$$;

create or replace function public.cfm_set_login_rate_limit(input_state jsonb)
returns void
language plpgsql
set search_path = public
as $$
begin
  if input_state is null or jsonb_typeof(input_state) <> 'object' or nullif(input_state->>'bucket', '') is null then
    raise exception 'login rate limit state must include bucket';
  end if;

  insert into login_rate_limits (bucket, failures, first_failed_at, last_failed_at, locked_until)
  values (
    input_state->>'bucket',
    coalesce((input_state->>'failures')::integer, 0),
    coalesce((input_state->>'first_failed_at')::timestamptz, now()),
    coalesce((input_state->>'last_failed_at')::timestamptz, now()),
    nullif(input_state->>'locked_until', '')::timestamptz
  )
  on conflict (bucket) do update set
    failures = excluded.failures,
    first_failed_at = excluded.first_failed_at,
    last_failed_at = excluded.last_failed_at,
    locked_until = excluded.locked_until;
end;
$$;

create or replace function public.cfm_set_login_rate_limits(input_states jsonb)
returns void
language plpgsql
set search_path = public
as $$
declare
  item jsonb;
begin
  if input_states is null or jsonb_typeof(input_states) <> 'array' then
    return;
  end if;

  for item in select value from jsonb_array_elements(input_states)
  loop
    perform public.cfm_set_login_rate_limit(item);
  end loop;
end;
$$;

create or replace function public.cfm_clear_login_rate_limits(input_buckets jsonb)
returns void
language sql
set search_path = public
as $$
  delete from login_rate_limits
  where bucket in (
    select value
    from jsonb_array_elements_text(case when jsonb_typeof(input_buckets) = 'array' then input_buckets else '[]'::jsonb end)
    where trim(value) <> ''
  );
$$;

create or replace function public.cfm_delete_login_rate_limits_before(input_before_time text)
returns void
language sql
set search_path = public
as $$
  delete from login_rate_limits
  where last_failed_at < input_before_time::timestamptz
    and (locked_until is null or locked_until < now());
$$;

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
  with deleted as (delete from records returning 1)
  select count(*)::integer into deleted_records from deleted;

  with deleted as (delete from gpu_records returning 1)
  select count(*)::integer into deleted_gpu_records from deleted;

  with deleted as (delete from gpu_snapshots returning 1)
  select count(*)::integer into deleted_gpu_snapshots from deleted;

  with deleted as (delete from ping_records returning 1)
  select count(*)::integer into deleted_ping_records from deleted;

  with deleted as (delete from ping_snapshots returning 1)
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

create or replace function public.cfm_clear_client_records(input_client text)
returns void
language sql
set search_path = public
as $$
  delete from records where client = input_client;
  delete from gpu_records where client = input_client;
  delete from gpu_snapshots where client = input_client;
  delete from ping_records where client = input_client;
  delete from ping_snapshots where client = input_client;
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

create or replace function public.cfm_insert_audit_log(
  input_user text,
  input_action text,
  input_detail text,
  input_level text default 'info'
)
returns void
language sql
set search_path = public
as $$
  insert into audit_logs ("user", action, detail, level)
  values (
    coalesce(input_user, ''),
    coalesce(input_action, ''),
    coalesce(input_detail, ''),
    coalesce(nullif(input_level, ''), 'info')
  );
$$;

revoke all on function public.cfm_create_user(text, text, text) from public;
revoke all on function public.cfm_create_user(text, text, text) from anon;
revoke all on function public.cfm_create_user(text, text, text) from authenticated;
grant execute on function public.cfm_create_user(text, text, text) to service_role;

revoke all on function public.cfm_delete_user_if_matches(text, text, text) from public;
revoke all on function public.cfm_delete_user_if_matches(text, text, text) from anon;
revoke all on function public.cfm_delete_user_if_matches(text, text, text) from authenticated;
grant execute on function public.cfm_delete_user_if_matches(text, text, text) to service_role;

revoke all on function public.cfm_login_rate_limit(text) from public;
revoke all on function public.cfm_login_rate_limit(text) from anon;
revoke all on function public.cfm_login_rate_limit(text) from authenticated;
grant execute on function public.cfm_login_rate_limit(text) to service_role;

revoke all on function public.cfm_login_rate_limits(jsonb) from public;
revoke all on function public.cfm_login_rate_limits(jsonb) from anon;
revoke all on function public.cfm_login_rate_limits(jsonb) from authenticated;
grant execute on function public.cfm_login_rate_limits(jsonb) to service_role;

revoke all on function public.cfm_set_login_rate_limit(jsonb) from public;
revoke all on function public.cfm_set_login_rate_limit(jsonb) from anon;
revoke all on function public.cfm_set_login_rate_limit(jsonb) from authenticated;
grant execute on function public.cfm_set_login_rate_limit(jsonb) to service_role;

revoke all on function public.cfm_set_login_rate_limits(jsonb) from public;
revoke all on function public.cfm_set_login_rate_limits(jsonb) from anon;
revoke all on function public.cfm_set_login_rate_limits(jsonb) from authenticated;
grant execute on function public.cfm_set_login_rate_limits(jsonb) to service_role;

revoke all on function public.cfm_clear_login_rate_limits(jsonb) from public;
revoke all on function public.cfm_clear_login_rate_limits(jsonb) from anon;
revoke all on function public.cfm_clear_login_rate_limits(jsonb) from authenticated;
grant execute on function public.cfm_clear_login_rate_limits(jsonb) to service_role;

revoke all on function public.cfm_delete_login_rate_limits_before(text) from public;
revoke all on function public.cfm_delete_login_rate_limits_before(text) from anon;
revoke all on function public.cfm_delete_login_rate_limits_before(text) from authenticated;
grant execute on function public.cfm_delete_login_rate_limits_before(text) to service_role;

revoke all on function public.cfm_clear_all_records() from public;
revoke all on function public.cfm_clear_all_records() from anon;
revoke all on function public.cfm_clear_all_records() from authenticated;
grant execute on function public.cfm_clear_all_records() to service_role;

revoke all on function public.cfm_clear_client_records(text) from public;
revoke all on function public.cfm_clear_client_records(text) from anon;
revoke all on function public.cfm_clear_client_records(text) from authenticated;
grant execute on function public.cfm_clear_client_records(text) to service_role;

revoke all on function public.cfm_restore_backup_data(jsonb) from public;
revoke all on function public.cfm_restore_backup_data(jsonb) from anon;
revoke all on function public.cfm_restore_backup_data(jsonb) from authenticated;
grant execute on function public.cfm_restore_backup_data(jsonb) to service_role;

revoke all on function public.cfm_insert_audit_log(text, text, text, text) from public;
revoke all on function public.cfm_insert_audit_log(text, text, text, text) from anon;
revoke all on function public.cfm_insert_audit_log(text, text, text, text) from authenticated;
grant execute on function public.cfm_insert_audit_log(text, text, text, text) to service_role;

notify pgrst, 'reload schema';

-- -----------------------------------------------------------------------------

-- Source: 20260625061202_rotate_admin_sessions.sql
create or replace function public.cfm_rotate_user_session(input_uuid text)
returns jsonb
language sql
set search_path = public
as $$
  update users
  set session_version = session_version + 1,
      updated_at = now()
  where uuid = input_uuid
  returning to_jsonb(users);
$$;

create or replace function public.cfm_update_user_username_rotate_session(input_uuid text, input_username text)
returns jsonb
language sql
set search_path = public
as $$
  update users
  set username = input_username,
      session_version = session_version + 1,
      updated_at = now()
  where uuid = input_uuid
  returning to_jsonb(users);
$$;

revoke all on function public.cfm_rotate_user_session(text) from public;
revoke all on function public.cfm_rotate_user_session(text) from anon;
revoke all on function public.cfm_rotate_user_session(text) from authenticated;
grant execute on function public.cfm_rotate_user_session(text) to service_role;

revoke all on function public.cfm_update_user_username_rotate_session(text, text) from public;
revoke all on function public.cfm_update_user_username_rotate_session(text, text) from anon;
revoke all on function public.cfm_update_user_username_rotate_session(text, text) from authenticated;
grant execute on function public.cfm_update_user_username_rotate_session(text, text) to service_role;

-- -----------------------------------------------------------------------------

-- Source: 20260701010000_agent_website_primary_fallback.sql
set local search_path = public;

alter table website_monitors alter column agent_probe_mode set default 'country_auto';
alter table website_monitors alter column agent_probe_status_enabled set default true;

update website_monitors
set agent_probe_mode = 'country_auto',
    agent_probe_status_enabled = true,
    updated_at = now()
where enabled = true
  and agent_probe_mode = 'off'
  and agent_probe_status_enabled = false;

create or replace function public.cfm_due_website_monitors(input_now text, input_limit integer default 50)
returns jsonb
language plpgsql
stable
set search_path = public
as $$
begin
  return (
  select coalesce(jsonb_agg(to_jsonb(row_data)), '[]'::jsonb)
  from (
    select wm.*
    from website_monitors wm
    where wm.enabled = true
      and (
        wm.last_checked_at is null
        or wm.last_checked_at <= input_now::timestamptz - (greatest(wm.interval_sec - 30, 1) * interval '1 second')
      )
      and (
        wm.agent_probe_mode = 'off'
        or (
          wm.agent_probe_status_enabled = true
          and not exists (
            select 1
            from website_checks recent_agent_success
            where recent_agent_success.monitor_id = wm.id
              and recent_agent_success.source_type = 'agent'
              and recent_agent_success.effective_status = 'up'
              and recent_agent_success.checked_at >= input_now::timestamptz - (greatest(wm.interval_sec + 30, wm.grace_period_sec, 180) * interval '1 second')
          )
        )
      )
    order by coalesce(wm.last_checked_at, '1970-01-01'::timestamptz) asc, wm.sort_order asc, wm.id asc
    limit least(greatest(coalesce(input_limit, 50), 1), 200)
  ) row_data
  );
end;
$$;

create or replace function public.cfm_record_website_check(input_check jsonb)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  monitor_row website_monitors%rowtype;
  check_ok boolean;
  checked_time timestamptz;
  source_kind text;
  source_client_id text;
begin
  if input_check is null or jsonb_typeof(input_check) <> 'object' then
    return null;
  end if;

  check_ok := coalesce((input_check->>'ok')::boolean, false);
  checked_time := (input_check->>'checked_at')::timestamptz;
  source_kind := coalesce(nullif(input_check->>'source_type', ''), 'worker');
  if source_kind not in ('worker', 'agent') then
    source_kind := 'worker';
  end if;
  source_client_id := nullif(input_check->>'source_client', '');

  select * into monitor_row
  from website_monitors
  where id = (input_check->>'monitor_id')::integer
  limit 1;
  if not found then
    return null;
  end if;

  insert into website_checks (
    monitor_id, checked_at, ok, effective_status, effective_reason,
    status_code, raw_status_code, latency_ms, error, source_type, source_client
  )
  values (
    (input_check->>'monitor_id')::integer,
    checked_time,
    check_ok,
    case when input_check->>'effective_status' = 'up' then 'up' else 'down' end,
    input_check->>'effective_reason',
    nullif(input_check->>'status_code', '')::integer,
    nullif(input_check->>'raw_status_code', '')::integer,
    nullif(input_check->>'latency_ms', '')::integer,
    input_check->>'error',
    source_kind,
    source_client_id
  );

  if source_kind = 'agent' and monitor_row.agent_probe_status_enabled = true and check_ok = false then
    return to_jsonb(monitor_row);
  end if;

  if check_ok then
    update website_monitors
    set status = 'up',
        last_checked_at = checked_time,
        last_success_at = checked_time,
        last_status_code = nullif(input_check->>'status_code', '')::integer,
        last_raw_status_code = nullif(input_check->>'raw_status_code', '')::integer,
        last_latency_ms = nullif(input_check->>'latency_ms', '')::integer,
        last_effective_reason = input_check->>'effective_reason',
        last_error = null,
        down_since = null,
        updated_at = now()
    where id = (input_check->>'monitor_id')::integer
    returning * into monitor_row;
  else
    update website_monitors
    set status = 'down',
        last_checked_at = checked_time,
        last_failure_at = checked_time,
        last_status_code = nullif(input_check->>'status_code', '')::integer,
        last_raw_status_code = nullif(input_check->>'raw_status_code', '')::integer,
        last_latency_ms = nullif(input_check->>'latency_ms', '')::integer,
        last_effective_reason = input_check->>'effective_reason',
        last_error = input_check->>'error',
        down_since = coalesce(down_since, checked_time),
        last_notified_at = case when status = 'down' then last_notified_at else null end,
        updated_at = now()
    where id = (input_check->>'monitor_id')::integer
    returning * into monitor_row;
  end if;

  if not found then
    return null;
  end if;
  return to_jsonb(monitor_row);
end;
$$;

revoke all on function public.cfm_due_website_monitors(text, integer) from public;
revoke all on function public.cfm_due_website_monitors(text, integer) from anon;
revoke all on function public.cfm_due_website_monitors(text, integer) from authenticated;
grant execute on function public.cfm_due_website_monitors(text, integer) to service_role;

revoke all on function public.cfm_record_website_check(jsonb) from public;
revoke all on function public.cfm_record_website_check(jsonb) from anon;
revoke all on function public.cfm_record_website_check(jsonb) from authenticated;
grant execute on function public.cfm_record_website_check(jsonb) to service_role;

insert into settings (key, value)
values ('schema_bootstrap_version', 'postgres-2026-07-01-agent-website-primary-fallback')
on conflict (key) do update set value = excluded.value;

notify pgrst, 'reload schema';

-- -----------------------------------------------------------------------------

-- Source: 20260701020000_agent_website_public_results.sql
set local search_path = public;

alter table website_monitors add column if not exists agent_probe_mode text not null default 'country_auto';
alter table website_monitors add column if not exists agent_probe_clients jsonb not null default '[]'::jsonb;
alter table website_monitors add column if not exists agent_probe_limit integer not null default 3;
alter table website_monitors add column if not exists agent_probe_status_enabled boolean not null default true;

update website_monitors
set agent_probe_mode = case when agent_probe_mode in ('off', 'selected', 'country_auto') then agent_probe_mode else 'country_auto' end,
    agent_probe_clients = case when jsonb_typeof(agent_probe_clients) = 'array' then agent_probe_clients else '[]'::jsonb end,
    agent_probe_limit = least(greatest(coalesce(agent_probe_limit, 3), 1), 10),
    agent_probe_status_enabled = coalesce(agent_probe_status_enabled, true);

alter table website_monitors alter column agent_probe_mode set default 'country_auto';
alter table website_monitors alter column agent_probe_clients set default '[]'::jsonb;
alter table website_monitors alter column agent_probe_limit set default 3;
alter table website_monitors alter column agent_probe_status_enabled set default true;
alter table website_monitors alter column agent_probe_mode set not null;
alter table website_monitors alter column agent_probe_clients set not null;
alter table website_monitors alter column agent_probe_limit set not null;
alter table website_monitors alter column agent_probe_status_enabled set not null;

alter table website_monitors drop constraint if exists website_monitors_agent_probe_mode_check;
alter table website_monitors add constraint website_monitors_agent_probe_mode_check check (agent_probe_mode in ('off', 'selected', 'country_auto'));
alter table website_monitors drop constraint if exists website_monitors_agent_probe_limit_check;
alter table website_monitors add constraint website_monitors_agent_probe_limit_check check (agent_probe_limit between 1 and 10);

alter table website_checks add column if not exists source_type text not null default 'worker';
alter table website_checks add column if not exists source_client text;
update website_checks set source_type = 'worker' where source_type is null or source_type not in ('worker', 'agent');
alter table website_checks alter column source_type set default 'worker';
alter table website_checks alter column source_type set not null;
alter table website_checks drop constraint if exists website_checks_source_type_check;
alter table website_checks add constraint website_checks_source_type_check check (source_type in ('worker', 'agent'));
alter table website_checks drop constraint if exists website_checks_source_client_fkey;
alter table website_checks add constraint website_checks_source_client_fkey foreign key (source_client) references clients(uuid) on delete set null;
create index if not exists idx_website_checks_monitor_source_time on website_checks(monitor_id, source_type, source_client, checked_at desc);

create or replace function public.cfm_public_websites(period_hours int default 24, check_limit int default 120, input_include_hidden boolean default false)
returns jsonb
language sql
stable
set search_path = public
as $$
  with args as (
    select
      least(greatest(coalesce(period_hours, 24), 1), 72) as safe_hours,
      least(greatest(coalesce(check_limit, 120), 1), 120) as safe_limit
  ),
  monitor_rows as (
    select
      id, name, url, interval_sec, status, last_checked_at,
      last_status_code, last_raw_status_code, last_latency_ms, last_effective_reason
    from website_monitors
    where input_include_hidden or hidden = false
    order by sort_order asc, id asc
  ),
  check_rows as (
    select *
    from (
      select
        wc.monitor_id, wc.checked_at, wc.ok, wc.effective_status, wc.effective_reason,
        wc.status_code, wc.raw_status_code, wc.latency_ms, wc.source_type, wc.source_client,
        row_number() over (
          partition by wc.monitor_id,
          floor(extract(epoch from (now() - wc.checked_at)) / greatest(60, floor((a.safe_hours * 60 * 60) / a.safe_limit)))
          order by wc.checked_at desc, wc.id desc
        ) as rn
      from website_checks wc
      join website_monitors wm on wm.id = wc.monitor_id
      cross join args a
      where (input_include_hidden or wm.hidden = false)
        and wc.checked_at >= now() - (a.safe_hours * interval '1 hour')
        and (
          wc.source_type = 'worker'
          or wc.effective_status = 'up'
          or wm.agent_probe_status_enabled = false
        )
    ) ranked
    where rn = 1
  )
  select coalesce(jsonb_agg(
    to_jsonb(m) || jsonb_build_object(
      'checks',
      coalesce((
        select jsonb_agg(to_jsonb(c) - 'monitor_id' - 'rn' order by c.checked_at desc)
        from check_rows c
        where c.monitor_id = m.id
      ), '[]'::jsonb)
    )
  ), '[]'::jsonb)
  from monitor_rows m;
$$;

create or replace function public.cfm_public_website_monitor(input_id integer, input_check_limit integer default 120, input_include_hidden boolean default false)
returns jsonb
language plpgsql
stable
set search_path = public
as $$
begin
  return (
  with
    args as (
      select least(greatest(coalesce(input_check_limit, 120), 1), 500) as safe_limit
    ),
    monitor_row as (
      select
        id, name, url, interval_sec, status, last_checked_at,
        last_status_code, last_raw_status_code, last_latency_ms, last_effective_reason
      from website_monitors
      where id = input_id
        and (input_include_hidden or hidden = false)
      limit 1
    ),
    check_rows as (
      select wc.checked_at, wc.ok, wc.effective_status, wc.effective_reason,
        wc.status_code, wc.raw_status_code, wc.latency_ms, wc.source_type, wc.source_client
      from website_checks wc
      join website_monitors wm on wm.id = wc.monitor_id
      cross join args
      where wc.monitor_id = input_id
        and (
          wc.source_type = 'worker'
          or wc.effective_status = 'up'
          or wm.agent_probe_status_enabled = false
        )
      order by wc.checked_at desc, wc.id desc
      limit args.safe_limit
    )
  select to_jsonb(m) || jsonb_build_object(
    'checks',
    coalesce((select jsonb_agg(to_jsonb(c) order by c.checked_at desc) from check_rows c), '[]'::jsonb)
  )
  from monitor_row m
  );
end;
$$;

create or replace function public.cfm_record_website_check(input_check jsonb)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  monitor_row website_monitors%rowtype;
  check_ok boolean;
  checked_time timestamptz;
  source_kind text;
  source_client_id text;
begin
  if input_check is null or jsonb_typeof(input_check) <> 'object' then
    return null;
  end if;

  check_ok := coalesce((input_check->>'ok')::boolean, false);
  checked_time := coalesce((input_check->>'checked_at')::timestamptz, now());
  source_kind := coalesce(nullif(input_check->>'source_type', ''), 'worker');
  if source_kind not in ('worker', 'agent') then
    source_kind := 'worker';
  end if;
  source_client_id := nullif(input_check->>'source_client', '');

  select * into monitor_row
  from website_monitors
  where id = (input_check->>'monitor_id')::integer
  limit 1;
  if not found then
    return null;
  end if;

  insert into website_checks (
    monitor_id, checked_at, ok, effective_status, effective_reason,
    status_code, raw_status_code, latency_ms, error, source_type, source_client
  )
  values (
    (input_check->>'monitor_id')::integer,
    checked_time,
    check_ok,
    case when input_check->>'effective_status' = 'up' then 'up' else 'down' end,
    input_check->>'effective_reason',
    nullif(input_check->>'status_code', '')::integer,
    nullif(input_check->>'raw_status_code', '')::integer,
    nullif(input_check->>'latency_ms', '')::integer,
    input_check->>'error',
    source_kind,
    source_client_id
  );

  if source_kind = 'agent' and monitor_row.agent_probe_status_enabled = true and check_ok = false then
    if exists (
      select 1
      from website_checks recent_agent_success
      where recent_agent_success.monitor_id = monitor_row.id
        and recent_agent_success.source_type = 'agent'
        and recent_agent_success.effective_status = 'up'
        and recent_agent_success.checked_at >= checked_time - (greatest(monitor_row.interval_sec + 30, monitor_row.grace_period_sec, 180) * interval '1 second')
      limit 1
    ) then
      return null;
    end if;
    return to_jsonb(monitor_row);
  end if;

  if check_ok then
    update website_monitors
    set status = 'up',
        last_checked_at = checked_time,
        last_success_at = checked_time,
        last_status_code = nullif(input_check->>'status_code', '')::integer,
        last_raw_status_code = nullif(input_check->>'raw_status_code', '')::integer,
        last_latency_ms = nullif(input_check->>'latency_ms', '')::integer,
        last_effective_reason = input_check->>'effective_reason',
        last_error = null,
        down_since = null,
        updated_at = now()
    where id = (input_check->>'monitor_id')::integer
    returning * into monitor_row;
  else
    update website_monitors
    set status = 'down',
        last_checked_at = checked_time,
        last_failure_at = checked_time,
        last_status_code = nullif(input_check->>'status_code', '')::integer,
        last_raw_status_code = nullif(input_check->>'raw_status_code', '')::integer,
        last_latency_ms = nullif(input_check->>'latency_ms', '')::integer,
        last_effective_reason = input_check->>'effective_reason',
        last_error = input_check->>'error',
        down_since = coalesce(down_since, checked_time),
        last_notified_at = case when status = 'down' then last_notified_at else null end,
        updated_at = now()
    where id = (input_check->>'monitor_id')::integer
    returning * into monitor_row;
  end if;

  if not found then
    return null;
  end if;
  return to_jsonb(monitor_row);
end;
$$;

create or replace function public.cfm_create_website_monitor(input_monitor jsonb)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  created_row website_monitors%rowtype;
begin
  insert into website_monitors (
    name, url, method, expected_status_min, expected_status_max,
    interval_sec, timeout_sec, grace_period_sec, enabled, hidden,
    agent_probe_mode, agent_probe_clients, agent_probe_limit, agent_probe_status_enabled,
    sort_order
  ) values (
    coalesce(input_monitor->>'name', ''),
    coalesce(input_monitor->>'url', ''),
    coalesce(input_monitor->>'method', 'GET'),
    coalesce((input_monitor->>'expected_status_min')::integer, 200),
    coalesce((input_monitor->>'expected_status_max')::integer, 399),
    coalesce((input_monitor->>'interval_sec')::integer, 120),
    coalesce((input_monitor->>'timeout_sec')::integer, 10),
    coalesce((input_monitor->>'grace_period_sec')::integer, 180),
    coalesce((input_monitor->>'enabled')::boolean, true),
    coalesce((input_monitor->>'hidden')::boolean, false),
    case when input_monitor->>'agent_probe_mode' in ('off', 'selected', 'country_auto') then input_monitor->>'agent_probe_mode' else 'country_auto' end,
    case when input_monitor ? 'agent_probe_clients' and jsonb_typeof(input_monitor->'agent_probe_clients') = 'array' then input_monitor->'agent_probe_clients' else '[]'::jsonb end,
    least(greatest(coalesce((input_monitor->>'agent_probe_limit')::integer, 3), 1), 10),
    coalesce((input_monitor->>'agent_probe_status_enabled')::boolean, true),
    (select coalesce(max(sort_order), 0) + 1 from website_monitors)
  )
  returning * into created_row;

  return to_jsonb(created_row);
end;
$$;

create or replace function public.cfm_update_website_monitor(input_id integer, input_monitor jsonb)
returns jsonb
language sql
set search_path = public
as $$
  update website_monitors
  set
    name = coalesce(input_monitor->>'name', name),
    url = coalesce(input_monitor->>'url', url),
    method = coalesce(input_monitor->>'method', method),
    expected_status_min = coalesce((input_monitor->>'expected_status_min')::integer, expected_status_min),
    expected_status_max = coalesce((input_monitor->>'expected_status_max')::integer, expected_status_max),
    interval_sec = coalesce((input_monitor->>'interval_sec')::integer, interval_sec),
    timeout_sec = coalesce((input_monitor->>'timeout_sec')::integer, timeout_sec),
    grace_period_sec = coalesce((input_monitor->>'grace_period_sec')::integer, grace_period_sec),
    enabled = case when input_monitor ? 'enabled' then coalesce((input_monitor->>'enabled')::boolean, enabled) else enabled end,
    hidden = case when input_monitor ? 'hidden' then coalesce((input_monitor->>'hidden')::boolean, hidden) else hidden end,
    agent_probe_mode = case when input_monitor->>'agent_probe_mode' in ('off', 'selected', 'country_auto') then input_monitor->>'agent_probe_mode' else agent_probe_mode end,
    agent_probe_clients = case when input_monitor ? 'agent_probe_clients' and jsonb_typeof(input_monitor->'agent_probe_clients') = 'array' then input_monitor->'agent_probe_clients' else agent_probe_clients end,
    agent_probe_limit = case when input_monitor ? 'agent_probe_limit' then least(greatest(coalesce((input_monitor->>'agent_probe_limit')::integer, agent_probe_limit), 1), 10) else agent_probe_limit end,
    agent_probe_status_enabled = case when input_monitor ? 'agent_probe_status_enabled' then coalesce((input_monitor->>'agent_probe_status_enabled')::boolean, agent_probe_status_enabled) else agent_probe_status_enabled end,
    updated_at = now()
  where id = input_id
  returning to_jsonb(website_monitors.*);
$$;

drop function if exists public.cfm_public_websites(integer, integer);

revoke all on function public.cfm_public_websites(integer, integer, boolean) from public;
revoke all on function public.cfm_public_websites(integer, integer, boolean) from anon;
revoke all on function public.cfm_public_websites(integer, integer, boolean) from authenticated;
grant execute on function public.cfm_public_websites(integer, integer, boolean) to service_role;

drop function if exists public.cfm_public_website_monitor(integer, integer);

revoke all on function public.cfm_public_website_monitor(integer, integer, boolean) from public;
revoke all on function public.cfm_public_website_monitor(integer, integer, boolean) from anon;
revoke all on function public.cfm_public_website_monitor(integer, integer, boolean) from authenticated;
grant execute on function public.cfm_public_website_monitor(integer, integer, boolean) to service_role;

revoke all on function public.cfm_record_website_check(jsonb) from public;
revoke all on function public.cfm_record_website_check(jsonb) from anon;
revoke all on function public.cfm_record_website_check(jsonb) from authenticated;
grant execute on function public.cfm_record_website_check(jsonb) to service_role;

revoke all on function public.cfm_create_website_monitor(jsonb) from public;
revoke all on function public.cfm_create_website_monitor(jsonb) from anon;
revoke all on function public.cfm_create_website_monitor(jsonb) from authenticated;
grant execute on function public.cfm_create_website_monitor(jsonb) to service_role;

revoke all on function public.cfm_update_website_monitor(integer, jsonb) from public;
revoke all on function public.cfm_update_website_monitor(integer, jsonb) from anon;
revoke all on function public.cfm_update_website_monitor(integer, jsonb) from authenticated;
grant execute on function public.cfm_update_website_monitor(integer, jsonb) to service_role;

insert into settings (key, value)
values ('schema_bootstrap_version', 'postgres-2026-07-01-agent-website-public-results')
on conflict (key) do update set value = excluded.value;

notify pgrst, 'reload schema';

-- -----------------------------------------------------------------------------

-- Source: 20260701174548_fix_website_reorder_order.sql
create or replace function public.cfm_reorder_website_monitors(input_ids jsonb)
returns integer
language plpgsql
set search_path = public
as $$
declare
  input_count integer;
  existing_count integer;
  updated_count integer;
begin
  with input_order as (
    select value::integer as id, min(ord)::integer as ord
    from jsonb_array_elements_text(case when jsonb_typeof(input_ids) = 'array' then input_ids else '[]'::jsonb end) with ordinality as item(value, ord)
    where value ~ '^[0-9]+$' and value::integer > 0
    group by value::integer
  )
  select count(*) into input_count from input_order;
  if input_count = 0 then
    return 0;
  end if;

  with input_order as (
    select value::integer as id, min(ord)::integer as ord
    from jsonb_array_elements_text(case when jsonb_typeof(input_ids) = 'array' then input_ids else '[]'::jsonb end) with ordinality as item(value, ord)
    where value ~ '^[0-9]+$' and value::integer > 0
    group by value::integer
  )
  select count(*) into existing_count
  from website_monitors w
  join input_order i on i.id = w.id;
  if existing_count <> input_count then
    raise exception 'Website monitor id does not exist';
  end if;

  with input_order as (
    select value::integer as id, min(ord)::integer as ord
    from jsonb_array_elements_text(case when jsonb_typeof(input_ids) = 'array' then input_ids else '[]'::jsonb end) with ordinality as item(value, ord)
    where value ~ '^[0-9]+$' and value::integer > 0
    group by value::integer
  ),
  final_order as (
    select id, (row_number() over (order by i.ord asc))::integer as sort_order
    from input_order i
    union all
    select w.id, (input_count + (row_number() over (order by w.sort_order asc, w.id asc))::integer)::integer
    from website_monitors w
    where not exists (select 1 from input_order i where i.id = w.id)
  ),
  updated as (
    update website_monitors w
    set sort_order = f.sort_order,
        updated_at = now()
    from final_order f
    where w.id = f.id
      and w.sort_order is distinct from f.sort_order
    returning w.id
  )
  select count(*) into updated_count from updated;

  return updated_count;
end;
$$;

revoke all on function public.cfm_reorder_website_monitors(jsonb) from public;
revoke all on function public.cfm_reorder_website_monitors(jsonb) from anon;
revoke all on function public.cfm_reorder_website_monitors(jsonb) from authenticated;
grant execute on function public.cfm_reorder_website_monitors(jsonb) to service_role;

notify pgrst, 'reload schema';

-- -----------------------------------------------------------------------------

-- Source: 20260702010000_public_website_order.sql
set local search_path = public;

create or replace function public.cfm_public_websites(period_hours int default 24, check_limit int default 120, input_include_hidden boolean default false)
returns jsonb
language sql
stable
set search_path = public
as $$
  with args as (
    select
      least(greatest(coalesce(period_hours, 24), 1), 72) as safe_hours,
      least(greatest(coalesce(check_limit, 120), 1), 120) as safe_limit
  ),
  monitor_rows as (
    select
      id, name, url, interval_sec, status, last_checked_at,
      last_status_code, last_raw_status_code, last_latency_ms, last_effective_reason,
      sort_order
    from website_monitors
    where input_include_hidden or hidden = false
    order by sort_order asc, id asc
  ),
  check_rows as (
    select *
    from (
      select
        wc.monitor_id, wc.checked_at, wc.ok, wc.effective_status, wc.effective_reason,
        wc.status_code, wc.raw_status_code, wc.latency_ms, wc.source_type, wc.source_client,
        row_number() over (
          partition by wc.monitor_id,
          floor(extract(epoch from (now() - wc.checked_at)) / greatest(60, floor((a.safe_hours * 60 * 60) / a.safe_limit)))
          order by wc.checked_at desc, wc.id desc
        ) as rn
      from website_checks wc
      join website_monitors wm on wm.id = wc.monitor_id
      cross join args a
      where (input_include_hidden or wm.hidden = false)
        and wc.checked_at >= now() - (a.safe_hours * interval '1 hour')
        and (
          wc.source_type = 'worker'
          or wc.effective_status = 'up'
          or wm.agent_probe_status_enabled = false
        )
    ) ranked
    where rn = 1
  )
  select coalesce(jsonb_agg(
    (to_jsonb(m) - 'sort_order') || jsonb_build_object(
      'checks',
      coalesce((
        select jsonb_agg(to_jsonb(c) - 'monitor_id' - 'rn' order by c.checked_at desc)
        from check_rows c
        where c.monitor_id = m.id
      ), '[]'::jsonb)
    )
    order by m.sort_order asc, m.id asc
  ), '[]'::jsonb)
  from monitor_rows m;
$$;

drop function if exists public.cfm_public_websites(integer, integer);

revoke all on function public.cfm_public_websites(integer, integer, boolean) from public;
revoke all on function public.cfm_public_websites(integer, integer, boolean) from anon;
revoke all on function public.cfm_public_websites(integer, integer, boolean) from authenticated;
grant execute on function public.cfm_public_websites(integer, integer, boolean) to service_role;

insert into settings (key, value)
values ('schema_bootstrap_version', 'postgres-2026-07-02-public-website-order')
on conflict (key) do update set value = excluded.value;

notify pgrst, 'reload schema';

-- -----------------------------------------------------------------------------

-- Source: 20260703020000_admin_recovery.sql
set local search_path = public;

create or replace function public.cfm_recover_single_admin(input_uuid text, input_username text, input_passwd text)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  user_count integer;
  target_uuid text;
  recovered users%rowtype;
begin
  if nullif(trim(coalesce(input_uuid, '')), '') is null
    or nullif(trim(coalesce(input_username, '')), '') is null
    or coalesce(input_passwd, '') = ''
  then
    raise exception 'user uuid, username, and password hash are required';
  end if;

  select count(*)::integer into user_count from users;

  if user_count = 0 then
    insert into users (uuid, username, passwd, password_changed_at)
    values (input_uuid, input_username, input_passwd, now())
    returning * into recovered;
  elsif user_count = 1 then
    select uuid into target_uuid from users limit 1;
    update users
    set username = input_username,
        passwd = input_passwd,
        session_version = session_version + 1,
        password_changed_at = now(),
        updated_at = now()
    where uuid = target_uuid
    returning * into recovered;
  else
    raise exception 'admin recovery supports exactly one admin user';
  end if;

  return to_jsonb(recovered);
end;
$$;

revoke all on function public.cfm_recover_single_admin(text, text, text) from public;
revoke all on function public.cfm_recover_single_admin(text, text, text) from anon;
revoke all on function public.cfm_recover_single_admin(text, text, text) from authenticated;
grant execute on function public.cfm_recover_single_admin(text, text, text) to service_role;

notify pgrst, 'reload schema';

-- -----------------------------------------------------------------------------

-- Source: 20260710000000_totp_two_factor_authentication.sql
create or replace function public.cfm_login_user(input_username text)
returns jsonb
language sql
stable
set search_path = public
as $$
  select to_jsonb(row_data)
  from (
    select uuid, username, passwd, session_version, password_changed_at,
           totp_secret_enc, totp_enabled_at, totp_last_used_step, recovery_code_hashes,
           created_at, updated_at
    from users
    where username = input_username
    limit 1
  ) row_data;
$$;

create or replace function public.cfm_user_by_uuid(input_uuid text)
returns jsonb
language sql
stable
set search_path = public
as $$
  select to_jsonb(row_data)
  from (
    select uuid, username, passwd, session_version, password_changed_at,
           totp_secret_enc, totp_enabled_at, totp_last_used_step, recovery_code_hashes,
           created_at, updated_at
    from users
    where uuid = input_uuid
    limit 1
  ) row_data;
$$;
create or replace function public.cfm_enable_user_totp(
  input_uuid text,
  input_secret_enc text,
  input_recovery_code_hashes jsonb,
  input_used_step bigint
)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  updated_user users%rowtype;
begin
  if nullif(trim(coalesce(input_uuid, '')), '') is null
    or nullif(trim(coalesce(input_secret_enc, '')), '') is null
    or input_used_step < 0
    or jsonb_typeof(input_recovery_code_hashes) is distinct from 'array'
    or jsonb_array_length(input_recovery_code_hashes) <> 8
  then
    raise exception 'invalid TOTP enrollment data';
  end if;

  update users
  set totp_secret_enc = input_secret_enc,
      totp_enabled_at = now(),
      totp_last_used_step = input_used_step,
      recovery_code_hashes = input_recovery_code_hashes,
      session_version = session_version + 1,
      updated_at = now()
  where uuid = input_uuid
  returning * into updated_user;

  if not found then
    return null;
  end if;
  return to_jsonb(updated_user);
end;
$$;

create or replace function public.cfm_disable_user_totp(input_uuid text)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  updated_user users%rowtype;
begin
  update users
  set totp_secret_enc = null,
      totp_enabled_at = null,
      totp_last_used_step = -1,
      recovery_code_hashes = '[]'::jsonb,
      session_version = session_version + 1,
      updated_at = now()
  where uuid = input_uuid
  returning * into updated_user;

  if not found then
    return null;
  end if;
  return to_jsonb(updated_user);
end;
$$;

create or replace function public.cfm_replace_user_recovery_codes(
  input_uuid text,
  input_recovery_code_hashes jsonb
)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  updated_user users%rowtype;
begin
  if jsonb_typeof(input_recovery_code_hashes) is distinct from 'array'
    or jsonb_array_length(input_recovery_code_hashes) <> 8
  then
    raise exception 'exactly eight recovery code hashes are required';
  end if;

  update users
  set recovery_code_hashes = input_recovery_code_hashes,
      session_version = session_version + 1,
      updated_at = now()
  where uuid = input_uuid
    and totp_enabled_at is not null
  returning * into updated_user;

  if not found then
    return null;
  end if;
  return to_jsonb(updated_user);
end;
$$;

create or replace function public.cfm_consume_totp_step(input_uuid text, input_step bigint)
returns boolean
language plpgsql
set search_path = public
as $$
begin
  if input_step < 0 then
    return false;
  end if;

  update users
  set totp_last_used_step = input_step,
      updated_at = now()
  where uuid = input_uuid
    and totp_enabled_at is not null
    and totp_secret_enc is not null
    and totp_last_used_step < input_step;

  return found;
end;
$$;

create or replace function public.cfm_consume_recovery_code(input_uuid text, input_code_hash text)
returns boolean
language plpgsql
set search_path = public
as $$
begin
  if input_code_hash !~ '^[A-Za-z0-9_-]{43}$' then
    return false;
  end if;

  update users
  set recovery_code_hashes = recovery_code_hashes - input_code_hash,
      updated_at = now()
  where uuid = input_uuid
    and totp_enabled_at is not null
    and recovery_code_hashes ? input_code_hash;

  return found;
end;
$$;

create or replace function public.cfm_recover_single_admin(input_uuid text, input_username text, input_passwd text)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  user_count integer;
  target_uuid text;
  recovered users%rowtype;
begin
  if nullif(trim(coalesce(input_uuid, '')), '') is null
    or nullif(trim(coalesce(input_username, '')), '') is null
    or coalesce(input_passwd, '') = ''
  then
    raise exception 'user uuid, username, and password hash are required';
  end if;

  select count(*)::integer into user_count from users;

  if user_count = 0 then
    insert into users (uuid, username, passwd, password_changed_at)
    values (input_uuid, input_username, input_passwd, now())
    returning * into recovered;
  elsif user_count = 1 then
    select uuid into target_uuid from users limit 1;
    update users
    set username = input_username,
        passwd = input_passwd,
        session_version = session_version + 1,
        password_changed_at = now(),
        totp_secret_enc = null,
        totp_enabled_at = null,
        totp_last_used_step = -1,
        recovery_code_hashes = '[]'::jsonb,
        updated_at = now()
    where uuid = target_uuid
    returning * into recovered;
  else
    raise exception 'admin recovery supports exactly one admin user';
  end if;

  return to_jsonb(recovered);
end;
$$;

revoke all on function public.cfm_enable_user_totp(text, text, jsonb, bigint) from public;
revoke all on function public.cfm_enable_user_totp(text, text, jsonb, bigint) from anon;
revoke all on function public.cfm_enable_user_totp(text, text, jsonb, bigint) from authenticated;
grant execute on function public.cfm_enable_user_totp(text, text, jsonb, bigint) to service_role;

revoke all on function public.cfm_disable_user_totp(text) from public;
revoke all on function public.cfm_disable_user_totp(text) from anon;
revoke all on function public.cfm_disable_user_totp(text) from authenticated;
grant execute on function public.cfm_disable_user_totp(text) to service_role;

revoke all on function public.cfm_replace_user_recovery_codes(text, jsonb) from public;
revoke all on function public.cfm_replace_user_recovery_codes(text, jsonb) from anon;
revoke all on function public.cfm_replace_user_recovery_codes(text, jsonb) from authenticated;
grant execute on function public.cfm_replace_user_recovery_codes(text, jsonb) to service_role;

revoke all on function public.cfm_consume_totp_step(text, bigint) from public;
revoke all on function public.cfm_consume_totp_step(text, bigint) from anon;
revoke all on function public.cfm_consume_totp_step(text, bigint) from authenticated;
grant execute on function public.cfm_consume_totp_step(text, bigint) to service_role;

revoke all on function public.cfm_consume_recovery_code(text, text) from public;
revoke all on function public.cfm_consume_recovery_code(text, text) from anon;
revoke all on function public.cfm_consume_recovery_code(text, text) from authenticated;
grant execute on function public.cfm_consume_recovery_code(text, text) to service_role;

revoke all on function public.cfm_recover_single_admin(text, text, text) from public;
revoke all on function public.cfm_recover_single_admin(text, text, text) from anon;
revoke all on function public.cfm_recover_single_admin(text, text, text) from authenticated;
grant execute on function public.cfm_recover_single_admin(text, text, text) to service_role;

notify pgrst, 'reload schema';

-- -----------------------------------------------------------------------------

-- Source: 20260712000000_offline_recovery_state.sql
set local search_path = public;

create or replace function public.cfm_set_offline_notifications(input_items jsonb)
returns integer
language sql
set search_path = public
as $$
  with parsed as (
    select distinct on (client)
      client,
      case when lower(coalesce(item->>'enable', 'false')) in ('true', '1') then 1 else 0 end as enable,
      coalesce(nullif(item->>'grace_period', '')::integer, 180) as grace_period,
      ord
    from jsonb_array_elements(coalesce(input_items, '[]'::jsonb)) with ordinality as value(item, ord)
    cross join lateral (select trim(item->>'client') as client) normalized
    where client <> ''
    order by client, ord desc
  ),
  upserted as (
    insert into offline_notifications (client, enable, grace_period)
    select client, enable, grace_period
    from parsed
    on conflict (client) do update set
      enable = excluded.enable,
      grace_period = excluded.grace_period,
      last_notified = case
        when excluded.enable = 0 then null
        else offline_notifications.last_notified
      end
    where offline_notifications.enable is distinct from excluded.enable
       or offline_notifications.grace_period is distinct from excluded.grace_period
       or (excluded.enable = 0 and offline_notifications.last_notified is not null)
    returning client
  )
  select count(*)::integer from upserted;
$$;

create or replace function public.cfm_mark_offline_notification_sent(input_client text, input_time text)
returns void
language sql
set search_path = public
as $$
  update offline_notifications
  set last_notified = nullif(input_time, '')::timestamptz
  where client = input_client;
$$;

revoke all on function public.cfm_set_offline_notifications(jsonb) from public;
revoke all on function public.cfm_set_offline_notifications(jsonb) from anon;
revoke all on function public.cfm_set_offline_notifications(jsonb) from authenticated;
grant execute on function public.cfm_set_offline_notifications(jsonb) to service_role;

revoke all on function public.cfm_mark_offline_notification_sent(text, text) from public;
revoke all on function public.cfm_mark_offline_notification_sent(text, text) from anon;
revoke all on function public.cfm_mark_offline_notification_sent(text, text) from authenticated;
grant execute on function public.cfm_mark_offline_notification_sent(text, text) to service_role;
