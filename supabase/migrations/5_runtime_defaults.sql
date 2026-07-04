-- Source: 20260618020000_align_collection_interval_defaults.sql
set local search_path = public;

update settings
set value = '120'
where key = 'record_persist_interval_sec'
  and value = '60';

update settings
set value = '120'
where key = 'ping_record_persist_interval_sec'
  and value = '300';

update settings
set value = '120'
where key = 'live_poll_idle_interval_sec'
  and value = '600';

insert into settings (key, value)
values ('schema_bootstrap_version', 'postgres-2026-06-15-v15')
on conflict (key) do update set value = excluded.value;

-- -----------------------------------------------------------------------------

-- Source: 20260626030000_allow_backup_restore_safeupdate.sql
select 1;

-- -----------------------------------------------------------------------------

-- Source: 20260626030000_normalize_active_theme_default.sql
set local search_path = public;

insert into settings (key, value)
values ('active_theme', 'monitor')
on conflict (key) do update
set value = case
  when settings.value in ('', 'default') then 'monitor'
  else settings.value
end;

insert into settings (key, value)
values ('schema_bootstrap_version', 'postgres-2026-06-26-theme-active-monitor')
on conflict (key) do update set value = excluded.value;

notify pgrst, 'reload schema';

-- -----------------------------------------------------------------------------

-- Source: 20260703010000_live_viewer_ttl_120.sql
set local search_path = public;

update settings
set value = '120'
where key = 'live_poll_active_max_duration_sec'
  and value = '600';

insert into settings (key, value)
values ('live_poll_active_max_duration_sec', '120')
on conflict (key) do nothing;

insert into settings (key, value)
values ('schema_bootstrap_version', 'postgres-2026-07-03-v1')
on conflict (key) do update set value = excluded.value;

-- -----------------------------------------------------------------------------

-- Source: 20260704000000_agent_install_token_persistence.sql
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

drop function if exists public.cfm_rotate_client_token(text, text);

revoke all on function public.cfm_create_client(jsonb) from public;
revoke all on function public.cfm_create_client(jsonb) from anon;
revoke all on function public.cfm_create_client(jsonb) from authenticated;
grant execute on function public.cfm_create_client(jsonb) to service_role;

revoke all on function public.cfm_rotate_client_token(text, text, text) from public;
revoke all on function public.cfm_rotate_client_token(text, text, text) from anon;
revoke all on function public.cfm_rotate_client_token(text, text, text) from authenticated;
grant execute on function public.cfm_rotate_client_token(text, text, text) to service_role;

notify pgrst, 'reload schema';
