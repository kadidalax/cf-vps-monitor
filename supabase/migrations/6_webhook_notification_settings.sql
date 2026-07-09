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
