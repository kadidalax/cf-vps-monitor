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
