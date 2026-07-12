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

-- Source: 20260709000000_webhook_notification_settings.sql
set local search_path = public;

insert into settings (key, value) values
  ('webhook_url', ''),
  ('webhook_format', 'generic'),
  ('webhook_secret', ''),
  ('webhook_method', 'POST'),
  ('webhook_content_type', 'application/json'),
  ('webhook_headers_json', ''),
  ('webhook_body_template', '{"message":"{{message}}","title":"{{title}}"}'),
  ('webhook_username', ''),
  ('webhook_password', ''),
  ('webhook_retry_count', '1')
on conflict (key) do nothing;

insert into settings (key, value)
values ('schema_bootstrap_version', 'postgres-2026-07-09-webhook-notifications')
on conflict (key) do update set value = excluded.value;
