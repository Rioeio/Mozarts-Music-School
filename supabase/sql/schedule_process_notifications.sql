-- ==============================================================================
-- Recurring notification processing (run once per environment, in the SQL editor)
--
-- Not a migration: it needs per-environment secrets. Re-running is safe.
-- Prerequisites:
--   * Database > Extensions: enable pg_cron and pg_net.
--   * The process-notifications function is deployed and NOTIFICATIONS_CRON_SECRET
--     is set as a function secret.
--   * Replace the two placeholders below. They are stored encrypted in Supabase
--     Vault, not in this file or in the cron job definition.
-- ==============================================================================

-- 1. Store (or update) the secrets in Vault.
do $$
begin
  if exists (select 1 from vault.secrets where name = 'project_url') then
    perform vault.update_secret((select id from vault.secrets where name = 'project_url'), 'https://YOUR-PROJECT-REF.supabase.co');
  else
    perform vault.create_secret('https://YOUR-PROJECT-REF.supabase.co', 'project_url');
  end if;

  if exists (select 1 from vault.secrets where name = 'notifications_cron_secret') then
    perform vault.update_secret((select id from vault.secrets where name = 'notifications_cron_secret'), 'SAME-VALUE-AS-NOTIFICATIONS_CRON_SECRET');
  else
    perform vault.create_secret('SAME-VALUE-AS-NOTIFICATIONS_CRON_SECRET', 'notifications_cron_secret');
  end if;
end;
$$;

-- 2. Call the worker every minute. cron.schedule replaces a job with the same name.
select cron.schedule(
  'process-notifications',
  '* * * * *',
  $job$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/process-notifications',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'notifications_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
  $job$
);

-- Check it is running (status should be 'succeeded'; the HTTP result is in net._http_response):
--   select jobname, schedule, active from cron.job;
--   select status, return_message, start_time from cron.job_run_details order by start_time desc limit 5;
--   select status_code, content, created from net._http_response order by created desc limit 5;
-- Stop it:
--   select cron.unschedule('process-notifications');
