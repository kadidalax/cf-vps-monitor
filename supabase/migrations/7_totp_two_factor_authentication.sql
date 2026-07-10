set local search_path = public;

alter table users add column if not exists totp_secret_enc text;
alter table users add column if not exists totp_enabled_at timestamptz;
alter table users add column if not exists totp_last_used_step bigint not null default -1;
alter table users add column if not exists recovery_code_hashes jsonb not null default '[]'::jsonb;

alter table users drop constraint if exists users_recovery_code_hashes_array;
alter table users add constraint users_recovery_code_hashes_array
  check (
    jsonb_typeof(recovery_code_hashes) = 'array'
    and jsonb_array_length(recovery_code_hashes) <= 8
  );

alter table users drop constraint if exists users_totp_state_consistent;
alter table users add constraint users_totp_state_consistent
  check (
    (totp_enabled_at is null and totp_secret_enc is null and recovery_code_hashes = '[]'::jsonb)
    or (totp_enabled_at is not null and nullif(totp_secret_enc, '') is not null)
  );

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