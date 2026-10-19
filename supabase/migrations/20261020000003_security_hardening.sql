-- ==============================================================================
-- MOZART SCHOOL OF WESTERN CLASSICAL MUSIC
-- Migration: 20261020000003_security_hardening.sql
--
-- Forward-only hardening. Existing rows are preserved.
--   1. Contact-method constraint now requires at least one nonblank email or phone.
--   2. Obsolete submit_enquiry_atomic overload removed; privileged functions are
--      service_role-only, with an empty search_path and qualified references.
--   3. Atomic rate limiting, lease-safe notification completion, admin-only retry.
--   4. Authorization comes only from active staff_members rows linked by auth user id.
--      The legacy admin_users fallback is retired (rows are migrated, not deleted).
--   5. Staff can update enquiry status and add notes; consent, contact data, roles,
--      notification recipients and staff records are not writable by clients.
--   6. Staff invitation activation and first-administrator bootstrap.
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 0. Trigger helper: pin search_path
-- ------------------------------------------------------------------------------
alter function public.handle_updated_at() set search_path = '';
revoke all on function public.handle_updated_at() from public, anon, authenticated;

-- ------------------------------------------------------------------------------
-- 1. Contact-method constraint
-- The original check passed whenever email was null. Added NOT VALID so legacy rows
-- never block the migration; validated immediately when no legacy row violates it.
-- New and updated rows are always checked.
-- ------------------------------------------------------------------------------
alter table public.enquiries drop constraint if exists enquiries_has_contact_method;

alter table public.enquiries
  add constraint enquiries_has_contact_method check (
    char_length(btrim(coalesce(email, ''))) > 0
    or char_length(btrim(coalesce(phone, ''))) > 0
  ) not valid;

do $$
begin
  if exists (
    select 1
    from public.enquiries e
    where char_length(btrim(coalesce(e.email, ''))) = 0
      and char_length(btrim(coalesce(e.phone, ''))) = 0
  ) then
    raise warning 'enquiries_has_contact_method left NOT VALID: legacy enquiries without any contact method exist. Review them, then run: alter table public.enquiries validate constraint enquiries_has_contact_method;';
  else
    alter table public.enquiries validate constraint enquiries_has_contact_method;
  end if;
end;
$$;

-- ------------------------------------------------------------------------------
-- 2. Enquiry submission (service_role only)
-- Migration 002 added p_class_preference, which created a second overload and left
-- the 18-argument version callable. Remove it; the Edge Function calls the
-- 19-argument version by named parameters.
-- ------------------------------------------------------------------------------
drop function if exists public.submit_enquiry_atomic(
  public.enquiry_type, text, text, text, text,
  public.instrument_type, public.learner_group_type, text,
  public.experience_level_type, text, text, text,
  boolean, boolean, text, text, jsonb, text
);

create or replace function public.submit_enquiry_atomic(
  p_type public.enquiry_type,
  p_contact_name text,
  p_email text,
  p_phone text,
  p_preferred_contact text,
  p_instrument public.instrument_type,
  p_learner_group public.learner_group_type,
  p_learner_name text,
  p_experience public.experience_level_type,
  p_preferred_times text,
  p_message text,
  p_source text,
  p_contact_consent boolean,
  p_location_updates boolean,
  p_consent_version text,
  p_idempotency_key text,
  p_metadata jsonb,
  p_owner_email text default 'srinivaschetty@gmail.com',
  p_class_preference public.class_preference_type default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_enquiry_id uuid;
  v_email text := nullif(lower(btrim(coalesce(p_email, ''))), '');
  v_phone text := nullif(btrim(coalesce(p_phone, '')), '');
  v_owner_email text := nullif(lower(btrim(coalesce(p_owner_email, ''))), '');
  v_owner_subject text;
  v_visitor_subject text;
  v_pref_label text := '';
begin
  if v_owner_email is null then
    raise exception 'Owner notification address is required.' using errcode = '22023';
  end if;

  -- Concurrency-safe idempotency: a duplicate key inserts nothing and returns the
  -- original enquiry without queueing a second set of notifications.
  insert into public.enquiries (
    type, contact_name, email, phone, preferred_contact, instrument, learner_group,
    learner_name, experience, class_preference, preferred_times, message, source,
    contact_consent, location_updates, consent_version, idempotency_key, metadata
  ) values (
    p_type, btrim(p_contact_name), v_email, v_phone, p_preferred_contact, p_instrument,
    p_learner_group, p_learner_name, p_experience, p_class_preference, p_preferred_times,
    p_message, p_source, p_contact_consent, p_location_updates,
    coalesce(p_consent_version, 'v1'), p_idempotency_key, coalesce(p_metadata, '{}'::jsonb)
  )
  on conflict (idempotency_key) do nothing
  returning id into v_enquiry_id;

  if v_enquiry_id is null then
    select e.id into v_enquiry_id
    from public.enquiries e
    where e.idempotency_key = p_idempotency_key;
    return v_enquiry_id;
  end if;

  if p_class_preference is not null then
    if p_class_preference = 'online' then
      v_pref_label := ' (Online)';
    elsif p_class_preference = 'in_person' then
      v_pref_label := ' (In-person)';
    else
      v_pref_label := ' (Guidance requested)';
    end if;
  end if;

  if p_type = 'lesson' then
    v_owner_subject := concat('New lesson enquiry — ', coalesce(initcap(p_instrument::text), 'General'), ' — ', coalesce(initcap(p_learner_group::text), 'Learner'), v_pref_label);
    v_visitor_subject := 'Thank you for your enquiry — Mozart School Of Western Classical Music';
  elsif p_type = 'location_interest' then
    v_owner_subject := 'New location-interest registration — Mozart School';
    v_visitor_subject := 'Location update registration — Mozart School Of Western Classical Music';
  else
    v_owner_subject := 'New message from website — Mozart School';
    v_visitor_subject := 'We have received your message — Mozart School Of Western Classical Music';
  end if;

  insert into public.notification_jobs (enquiry_id, kind, status, recipient, subject, next_attempt_at)
  values (v_enquiry_id, 'owner_alert', 'pending', v_owner_email, v_owner_subject, now());

  if v_email is not null then
    insert into public.notification_jobs (enquiry_id, kind, status, recipient, subject, next_attempt_at)
    values (v_enquiry_id, 'visitor_acknowledgement', 'pending', v_email, v_visitor_subject, now());
  end if;

  return v_enquiry_id;
end;
$$;

comment on function public.submit_enquiry_atomic(
  public.enquiry_type, text, text, text, text, public.instrument_type, public.learner_group_type,
  text, public.experience_level_type, text, text, text, boolean, boolean, text, text, jsonb, text,
  public.class_preference_type
) is 'Service role only. Called by the submit-enquiry Edge Function after validation, Turnstile and rate limiting.';

-- ------------------------------------------------------------------------------
-- 3. Atomic rate limiting (service_role only)
-- Single upsert under a row lock; returns true while the caller is within the limit.
-- ------------------------------------------------------------------------------
create or replace function public.check_rate_limit(
  p_key text,
  p_limit integer,
  p_window_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := now();
  v_count integer;
begin
  if p_key is null or char_length(p_key) = 0 or char_length(p_key) > 200
     or p_limit is null or p_limit < 1
     or p_window_seconds is null or p_window_seconds < 1 then
    raise exception 'Invalid rate limit arguments.' using errcode = '22023';
  end if;

  insert into public.rate_limits as r (key, count, window_start, expires_at)
  values (p_key, 1, v_now, v_now + make_interval(secs => p_window_seconds))
  on conflict (key) do update
    set count = case when r.expires_at <= v_now then 1 else r.count + 1 end,
        window_start = case when r.expires_at <= v_now then v_now else r.window_start end,
        expires_at = case when r.expires_at <= v_now then v_now + make_interval(secs => p_window_seconds) else r.expires_at end
  returning r.count into v_count;

  -- Occasional cleanup of long-expired windows.
  if random() < 0.02 then
    delete from public.rate_limits rl where rl.expires_at < v_now - interval '1 day';
  end if;

  return v_count <= p_limit;
end;
$$;

-- ------------------------------------------------------------------------------
-- 4. Notification queue (service_role only, except admin retry)
-- ------------------------------------------------------------------------------
create or replace function public.claim_notification_jobs(
  p_batch_size integer default 10,
  p_lease_seconds integer default 300
)
returns setof public.notification_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_token uuid := gen_random_uuid();
  v_now timestamptz := now();
  v_batch integer := least(greatest(coalesce(p_batch_size, 10), 1), 50);
  v_lease integer := least(greatest(coalesce(p_lease_seconds, 300), 30), 900);
begin
  -- A lease that expired on the final attempt is failed for manual review.
  update public.notification_jobs j
     set status = 'failed',
         processing_token = null,
         processing_expires_at = null,
         last_error = coalesce(j.last_error, 'Worker lease expired on the final attempt.')
   where j.status = 'processing'
     and j.processing_expires_at < v_now
     and j.attempts >= 5;

  return query
  with candidates as (
    select j.id
    from public.notification_jobs j
    where (j.status = 'pending' and j.next_attempt_at <= v_now)
       or (j.status = 'processing' and j.processing_expires_at < v_now and j.attempts < 5)
       or (j.status = 'failed' and j.attempts < 5 and j.next_attempt_at <= v_now)
    order by j.next_attempt_at asc
    limit v_batch
    for update skip locked
  ),
  claimed as (
    update public.notification_jobs j
       set status = 'processing',
           processing_token = v_token,
           processing_expires_at = v_now + make_interval(secs => v_lease),
           attempts = j.attempts + 1
      from candidates c
     where j.id = c.id
    returning j.*
  )
  select * from claimed;
end;
$$;

-- Completes a claimed job only while the caller still holds the lease token, so a
-- worker whose job was reclaimed by another worker cannot overwrite its result.
-- Returns 'sent', 'retry_scheduled', 'failed' or 'lease_lost'.
create or replace function public.finish_notification_job(
  p_job_id uuid,
  p_processing_token uuid,
  p_sent boolean,
  p_provider_message_id text default null,
  p_error text default null
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_attempts integer;
begin
  select j.attempts into v_attempts
  from public.notification_jobs j
  where j.id = p_job_id
    and j.status = 'processing'
    and j.processing_token = p_processing_token
  for update;

  if not found then
    return 'lease_lost';
  end if;

  if p_sent then
    if nullif(btrim(coalesce(p_provider_message_id, '')), '') is null then
      raise exception 'A provider message id is required to mark a job as sent.' using errcode = '22023';
    end if;

    update public.notification_jobs j
       set status = 'sent',
           provider_message_id = left(p_provider_message_id, 255),
           last_error = null,
           processing_token = null,
           processing_expires_at = null
     where j.id = p_job_id;
    return 'sent';
  end if;

  if v_attempts >= 5 then
    update public.notification_jobs j
       set status = 'failed',
           last_error = left(coalesce(p_error, 'Unknown delivery error.'), 1000),
           processing_token = null,
           processing_expires_at = null
     where j.id = p_job_id;
    return 'failed';
  end if;

  -- Exponential backoff: 2, 4, 8, 16 minutes after attempts 1-4.
  update public.notification_jobs j
     set status = 'pending',
         last_error = left(coalesce(p_error, 'Unknown delivery error.'), 1000),
         next_attempt_at = now() + make_interval(mins => power(2, v_attempts)::integer),
         processing_token = null,
         processing_expires_at = null
   where j.id = p_job_id;
  return 'retry_scheduled';
end;
$$;

-- ------------------------------------------------------------------------------
-- 5. Staff membership: authorization identity is auth.uid() + active staff row
-- ------------------------------------------------------------------------------
alter table public.staff_members
  add column if not exists invite_expires_at timestamptz,
  add column if not exists accepted_at timestamptz;

comment on column public.staff_members.invite_expires_at is 'Invitations must be accepted before this time; resending extends it.';
comment on column public.staff_members.accepted_at is 'When the invited user activated access (linked user_id).';

-- Invitations created by the old UI were database rows only (no email was sent).
-- Give them an expiry relative to when they were created; admins resend as needed.
update public.staff_members s
   set invite_expires_at = s.invited_at + interval '7 days'
 where s.invitation_status = 'invited'
   and s.invite_expires_at is null;

-- Normalise emails where doing so does not collide with another row.
update public.staff_members s
   set email = lower(btrim(s.email))
 where s.email <> lower(btrim(s.email))
   and not exists (
     select 1 from public.staff_members o
     where o.id <> s.id and o.email = lower(btrim(s.email))
   );

-- One staff record per auth user. Fails loudly if legacy data links a user twice.
create unique index if not exists staff_members_user_id_key
  on public.staff_members (user_id)
  where user_id is not null;

-- Retire the legacy admin_users fallback. Each legacy administrator keeps access
-- through an explicit staff_members row, unless staff_members already says otherwise:
--   * a row linked to the same user is authoritative (revoked stays revoked);
--   * an unlinked, non-revoked row with the same email is linked and activated as admin;
--   * a revoked row with the same email stays revoked;
--   * otherwise an active admin row is created.
do $$
declare
  r record;
  v_name text;
begin
  for r in
    select a.user_id, u.email, u.raw_user_meta_data
    from public.admin_users a
    join auth.users u on u.id = a.user_id
  loop
    if exists (select 1 from public.staff_members s where s.user_id = r.user_id) then
      raise notice 'admin_users %: existing linked staff_members row is authoritative.', r.user_id;
      continue;
    end if;

    if r.email is null or r.email !~* '^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$' then
      raise warning 'admin_users %: no usable email; not migrated. Use public.bootstrap_first_admin or invite them.', r.user_id;
      continue;
    end if;

    if exists (select 1 from public.staff_members s where s.email = lower(r.email)) then
      update public.staff_members s
         set user_id = r.user_id,
             role = 'admin',
             invitation_status = 'active',
             accepted_at = coalesce(s.accepted_at, now())
       where s.email = lower(r.email)
         and s.user_id is null
         and s.invitation_status <> 'revoked';
      if not found then
        raise notice 'admin_users %: staff_members row for % is revoked or linked elsewhere; access not restored.', r.user_id, lower(r.email);
      end if;
      continue;
    end if;

    v_name := coalesce(
      nullif(btrim(r.raw_user_meta_data ->> 'full_name'), ''),
      nullif(btrim(r.raw_user_meta_data ->> 'name'), '')
    );
    if v_name is null or char_length(v_name) < 2 or char_length(v_name) > 120 then
      v_name := 'Administrator';
    end if;

    insert into public.staff_members (user_id, name, email, role, invitation_status, invited_at, accepted_at)
    values (r.user_id, v_name, lower(r.email), 'admin', 'active', now(), now());
  end loop;
end;
$$;

drop policy if exists "Admins can view admin list" on public.admin_users;
comment on table public.admin_users is 'DEPRECATED since 20261020000003. Grants no access; kept for history. Authorization uses public.staff_members.';

create or replace function public.is_admin()
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select exists (
    select 1
    from public.staff_members s
    where s.user_id = (select auth.uid())
      and s.role = 'admin'
      and s.invitation_status = 'active'
  );
$$;

create or replace function public.is_active_staff()
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select exists (
    select 1
    from public.staff_members s
    where s.user_id = (select auth.uid())
      and s.invitation_status = 'active'
  );
$$;

-- Called by the dashboard after every sign-in. Links the caller to an invitation
-- addressed to their own confirmed auth email, once they have set a password.
-- The caller cannot choose the staff record or the role.
-- status: active | pending | password_required | expired | revoked | none
create or replace function public.activate_staff_membership()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_email text;
  v_confirmed timestamptz;
  v_has_password boolean;
  v_staff public.staff_members%rowtype;
begin
  if v_uid is null then
    raise exception 'Authentication required.' using errcode = '42501';
  end if;

  select * into v_staff from public.staff_members s where s.user_id = v_uid;
  if found then
    return jsonb_build_object(
      'status', case v_staff.invitation_status when 'active' then 'active' when 'revoked' then 'revoked' else 'pending' end,
      'staff_id', v_staff.id, 'name', v_staff.name, 'email', v_staff.email, 'role', v_staff.role
    );
  end if;

  select u.email, u.email_confirmed_at, coalesce(u.encrypted_password, '') <> ''
    into v_email, v_confirmed, v_has_password
  from auth.users u
  where u.id = v_uid;

  if v_email is null or v_confirmed is null then
    return jsonb_build_object('status', 'none');
  end if;

  select * into v_staff
  from public.staff_members s
  where s.email = lower(v_email)
  for update;

  if not found or v_staff.user_id is not null then
    return jsonb_build_object('status', 'none');
  end if;

  if v_staff.invitation_status = 'revoked' then
    return jsonb_build_object('status', 'revoked');
  end if;

  if v_staff.invitation_status = 'invited'
     and v_staff.invite_expires_at is not null
     and v_staff.invite_expires_at < now() then
    return jsonb_build_object('status', 'expired');
  end if;

  if not v_has_password then
    return jsonb_build_object('status', 'password_required', 'name', v_staff.name, 'email', v_staff.email);
  end if;

  update public.staff_members s
     set user_id = v_uid,
         invitation_status = 'active',
         accepted_at = now()
   where s.id = v_staff.id;

  return jsonb_build_object(
    'status', 'active',
    'staff_id', v_staff.id, 'name', v_staff.name, 'email', v_staff.email, 'role', v_staff.role
  );
end;
$$;

-- First administrator, run once from the Supabase SQL editor (postgres role) after
-- creating the user under Authentication > Users. Refuses if an active admin exists.
create or replace function public.bootstrap_first_admin(p_email text, p_name text default 'Administrator')
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid;
  v_id uuid;
  v_email text := lower(btrim(coalesce(p_email, '')));
begin
  if exists (
    select 1 from public.staff_members s
    where s.role = 'admin' and s.invitation_status = 'active'
  ) then
    raise exception 'An active administrator already exists. Invite further staff from the dashboard.' using errcode = '55000';
  end if;

  select u.id into v_uid
  from auth.users u
  where lower(u.email) = v_email
    and u.email_confirmed_at is not null;

  if v_uid is null then
    raise exception 'No confirmed Supabase Auth user with email %. Create the user first (Authentication > Users).', v_email using errcode = 'P0002';
  end if;

  insert into public.staff_members (user_id, name, email, role, invitation_status, invited_at, accepted_at)
  values (v_uid, btrim(p_name), v_email, 'admin', 'active', now(), now())
  on conflict (email) do update
    set user_id = excluded.user_id,
        name = excluded.name,
        role = 'admin',
        invitation_status = 'active',
        accepted_at = now()
  returning id into v_id;

  return v_id;
end;
$$;

-- Admin-only retry of a permanently failed notification. Replaces direct UPDATE access,
-- which allowed changing recipients and subjects.
create or replace function public.retry_notification_job(p_job_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'Only administrators can retry notifications.' using errcode = '42501';
  end if;

  update public.notification_jobs j
     set status = 'pending',
         attempts = 0,
         next_attempt_at = now(),
         last_error = null,
         processing_token = null,
         processing_expires_at = null
   where j.id = p_job_id
     and j.status = 'failed';

  if not found then
    raise exception 'Only failed notifications can be retried.' using errcode = 'P0002';
  end if;
end;
$$;

-- Note authorship comes from the session, never from client-supplied values.
create or replace function public.set_enquiry_note_author()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is not null then
    new.admin_user_id := auth.uid();
    new.admin_email := (select u.email from auth.users u where u.id = auth.uid());
  end if;
  return new;
end;
$$;

drop trigger if exists enquiry_notes_set_author on public.enquiry_notes;
create trigger enquiry_notes_set_author
  before insert on public.enquiry_notes
  for each row execute function public.set_enquiry_note_author();

-- ------------------------------------------------------------------------------
-- 6. Row level security policies
-- ------------------------------------------------------------------------------
-- enquiries: active staff read and update status; admins delete.
drop policy if exists "Admins can view enquiries" on public.enquiries;
drop policy if exists "Admins can update enquiries" on public.enquiries;
-- Kept: "Staff can view enquiries", "Staff can update enquiries", "Admins can delete enquiries".

-- enquiry_notes: active staff read and add (as themselves); admins delete.
drop policy if exists "Admins can view enquiry notes" on public.enquiry_notes;
drop policy if exists "Admins can insert enquiry notes" on public.enquiry_notes;

create policy "Active staff can view enquiry notes"
  on public.enquiry_notes
  for select
  to authenticated
  using ((select public.is_active_staff()));

create policy "Active staff can add enquiry notes"
  on public.enquiry_notes
  for insert
  to authenticated
  with check ((select public.is_active_staff()) and admin_user_id = (select auth.uid()));
-- Kept: "Admins can delete enquiry notes".

-- notification_jobs: admins read; no direct writes (retry via retry_notification_job).
drop policy if exists "Admins can update notification jobs for retry" on public.notification_jobs;
-- Kept: "Admins can view notification jobs".

-- staff_members: writes only through the manage-staff Edge Function (service role).
drop policy if exists "Admins can insert staff members" on public.staff_members;
drop policy if exists "Admins can update staff members" on public.staff_members;
drop policy if exists "Admins can delete staff members" on public.staff_members;

create policy "Users can view their own staff record"
  on public.staff_members
  for select
  to authenticated
  using (user_id = (select auth.uid()));
-- Kept: "Active staff can view staff directory".

-- ------------------------------------------------------------------------------
-- 7. Table and column privileges
-- Supabase grants ALL on public tables to anon and authenticated by default; RLS
-- alone then decides. Grant only what the dashboard needs.
-- ------------------------------------------------------------------------------
revoke all on table public.enquiries from anon, authenticated;
grant select, delete on table public.enquiries to authenticated;
grant update (status) on table public.enquiries to authenticated;

revoke all on table public.enquiry_notes from anon, authenticated;
grant select, delete on table public.enquiry_notes to authenticated;
grant insert (enquiry_id, note) on table public.enquiry_notes to authenticated;

revoke all on table public.notification_jobs from anon, authenticated;
grant select (
  id, enquiry_id, kind, status, recipient, subject, attempts, next_attempt_at,
  last_error, provider_message_id, created_at, updated_at
) on table public.notification_jobs to authenticated;

revoke all on table public.staff_members from anon, authenticated;
grant select on table public.staff_members to authenticated;

revoke all on table public.rate_limits from anon, authenticated;
revoke all on table public.admin_users from anon, authenticated;

grant select, insert, update, delete on table
  public.enquiries, public.enquiry_notes, public.notification_jobs,
  public.staff_members, public.rate_limits, public.admin_users
to service_role;

-- ------------------------------------------------------------------------------
-- 8. Function privileges
-- Postgres grants EXECUTE to PUBLIC and Supabase also grants it to anon and
-- authenticated, so revoke from all three explicitly.
-- ------------------------------------------------------------------------------
revoke all on function public.submit_enquiry_atomic(
  public.enquiry_type, text, text, text, text, public.instrument_type, public.learner_group_type,
  text, public.experience_level_type, text, text, text, boolean, boolean, text, text, jsonb, text,
  public.class_preference_type
) from public, anon, authenticated;
grant execute on function public.submit_enquiry_atomic(
  public.enquiry_type, text, text, text, text, public.instrument_type, public.learner_group_type,
  text, public.experience_level_type, text, text, text, boolean, boolean, text, text, jsonb, text,
  public.class_preference_type
) to service_role;

revoke all on function public.claim_notification_jobs(integer, integer) from public, anon, authenticated;
grant execute on function public.claim_notification_jobs(integer, integer) to service_role;

revoke all on function public.finish_notification_job(uuid, uuid, boolean, text, text) from public, anon, authenticated;
grant execute on function public.finish_notification_job(uuid, uuid, boolean, text, text) to service_role;

revoke all on function public.check_rate_limit(text, integer, integer) from public, anon, authenticated;
grant execute on function public.check_rate_limit(text, integer, integer) to service_role;

revoke all on function public.retry_notification_job(uuid) from public, anon, service_role;
grant execute on function public.retry_notification_job(uuid) to authenticated;

revoke all on function public.activate_staff_membership() from public, anon, service_role;
grant execute on function public.activate_staff_membership() to authenticated;

revoke all on function public.bootstrap_first_admin(text, text) from public, anon, authenticated, service_role;

revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated, service_role;

revoke all on function public.is_active_staff() from public, anon;
grant execute on function public.is_active_staff() to authenticated, service_role;

revoke all on function public.set_enquiry_note_author() from public, anon, authenticated;
