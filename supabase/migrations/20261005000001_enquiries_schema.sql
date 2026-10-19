-- ==============================================================================
-- MOZART SCHOOL OF WESTERN CLASSICAL MUSIC
-- Supabase PostgreSQL Schema & Security Migration
-- Migration: 20261005000001_enquiries_schema.sql
-- ==============================================================================

-- 1. Create Enums
create type public.enquiry_type as enum (
  'lesson',
  'location_interest',
  'general'
);

create type public.enquiry_status as enum (
  'new',
  'contacted',
  'awaiting_reply',
  'enrolled',
  'closed',
  'spam'
);

create type public.instrument_type as enum (
  'piano',
  'keyboard',
  'violin',
  'unsure'
);

create type public.learner_group_type as enum (
  'child',
  'teen',
  'adult'
);

create type public.experience_level_type as enum (
  'beginner',
  'some_experience',
  'experienced'
);

create type public.notification_job_kind as enum (
  'owner_alert',
  'visitor_acknowledgement'
);

create type public.notification_job_status as enum (
  'pending',
  'processing',
  'sent',
  'failed'
);

-- 2. Create admin_users table
-- Staff accounts linked to Supabase Auth. Never public.
create table public.admin_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null default 'admin',
  created_at timestamptz not null default now()
);

-- 3. Create enquiries table
create table public.enquiries (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  type public.enquiry_type not null,
  contact_name text not null check (char_length(trim(contact_name)) >= 2 and char_length(contact_name) <= 120),
  email text check (email is null or (char_length(email) <= 255 and email ~* '^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$')),
  phone text check (phone is null or (char_length(phone) >= 7 and char_length(phone) <= 30)),
  preferred_contact text check (preferred_contact in ('email', 'phone', 'either')),
  instrument public.instrument_type,
  learner_group public.learner_group_type,
  learner_name text check (learner_name is null or char_length(learner_name) <= 80),
  experience public.experience_level_type,
  preferred_times text check (preferred_times is null or char_length(preferred_times) <= 300),
  message text check (message is null or char_length(message) <= 3000),
  status public.enquiry_status not null default 'new',
  source text not null check (char_length(source) <= 80),
  contact_consent boolean not null default false,
  location_updates boolean not null default false,
  consent_version text not null default 'v1',
  consented_at timestamptz not null default now(),
  idempotency_key text unique,
  metadata jsonb not null default '{}'::jsonb,

  -- Integrity Constraints:
  -- Must have at least one contact method (email or phone)
  constraint enquiries_has_contact_method check (email is null or char_length(trim(email)) > 0 or phone is null or char_length(trim(phone)) > 0),
  -- Must have explicit contact consent
  constraint enquiries_consent_required check (contact_consent = true)
);

-- 4. Create enquiry_notes table (Private staff follow-ups)
create table public.enquiry_notes (
  id uuid primary key default gen_random_uuid(),
  enquiry_id uuid not null references public.enquiries(id) on delete cascade,
  admin_user_id uuid not null references auth.users(id) on delete cascade,
  admin_email text,
  note text not null check (char_length(trim(note)) > 0 and char_length(note) <= 3000),
  created_at timestamptz not null default now()
);

-- 5. Create notification_jobs table (Transactional queue with lease claims)
create table public.notification_jobs (
  id uuid primary key default gen_random_uuid(),
  enquiry_id uuid not null references public.enquiries(id) on delete cascade,
  kind public.notification_job_kind not null,
  status public.notification_job_status not null default 'pending',
  recipient text not null check (char_length(recipient) <= 255),
  subject text not null check (char_length(subject) <= 255),
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  processing_token uuid,
  processing_expires_at timestamptz,
  provider_message_id text,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Unique constraint: exactly one job of each kind per enquiry
  constraint notification_jobs_unique_kind unique (enquiry_id, kind)
);

-- 6. Create rate_limits table (Durable abuse prevention)
create table public.rate_limits (
  key text primary key,
  count integer not null default 1,
  window_start timestamptz not null default now(),
  expires_at timestamptz not null
);

-- 7. Indexes for performant lookups and queue processing
create index enquiries_created_at_idx on public.enquiries (created_at desc);
create index enquiries_type_status_idx on public.enquiries (type, status);
create index enquiries_contact_name_idx on public.enquiries (contact_name);
create index enquiries_email_idx on public.enquiries (email);
create index enquiries_phone_idx on public.enquiries (phone);

create index enquiry_notes_enquiry_id_idx on public.enquiry_notes (enquiry_id, created_at desc);
create index notification_jobs_processing_idx on public.notification_jobs (status, next_attempt_at) where status in ('pending', 'failed');
create index rate_limits_expires_at_idx on public.rate_limits (expires_at);

-- 8. Updated at triggers
create or replace function public.handle_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger enquiries_updated_at
  before update on public.enquiries
  for each row execute function public.handle_updated_at();

create trigger notification_jobs_updated_at
  before update on public.notification_jobs
  for each row execute function public.handle_updated_at();

-- 9. Row Level Security (RLS) Policies
alter table public.admin_users enable row level security;
alter table public.enquiries enable row level security;
alter table public.enquiry_notes enable row level security;
alter table public.notification_jobs enable row level security;
alter table public.rate_limits enable row level security;

-- Helper security definer function to verify if the caller is an authenticated administrator
create or replace function public.is_admin()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.admin_users
    where admin_users.user_id = auth.uid()
  );
$$;

-- RLS: admin_users
-- Admins can view other admin records; users can view their own record to verify status
create policy "Admins can view admin list"
  on public.admin_users
  for select
  to authenticated
  using (user_id = auth.uid() or public.is_admin());

-- RLS: enquiries
-- Anonymous visitors: DIRECT ACCESS DENIED. (All public writes happen via Edge Function service role)
-- Authenticated admins: FULL READ, UPDATE, DELETE permissions
create policy "Admins can view enquiries"
  on public.enquiries
  for select
  to authenticated
  using (public.is_admin());

create policy "Admins can update enquiries"
  on public.enquiries
  for update
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy "Admins can delete enquiries"
  on public.enquiries
  for delete
  to authenticated
  using (public.is_admin());

-- RLS: enquiry_notes
-- Completely private to admins. Never readable by anonymous users or non-admins.
create policy "Admins can view enquiry notes"
  on public.enquiry_notes
  for select
  to authenticated
  using (public.is_admin());

create policy "Admins can insert enquiry notes"
  on public.enquiry_notes
  for insert
  to authenticated
  with check (public.is_admin() and admin_user_id = auth.uid());

create policy "Admins can delete enquiry notes"
  on public.enquiry_notes
  for delete
  to authenticated
  using (public.is_admin());

-- RLS: notification_jobs
-- Admins can view notification statuses to monitor delivery health
create policy "Admins can view notification jobs"
  on public.notification_jobs
  for select
  to authenticated
  using (public.is_admin());

-- Admins can trigger retry by resetting status to 'pending'
create policy "Admins can update notification jobs for retry"
  on public.notification_jobs
  for update
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- RLS: rate_limits
-- Managed strictly by service-role / Edge functions. Denied to all public/authenticated clients.

-- 10. Atomic Enquiry Submission Function
-- Called by Edge Function to insert enquiry and queue notification jobs atomically
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
  p_owner_email text default 'srinivaschetty@gmail.com'
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_enquiry_id uuid;
  v_owner_subject text;
  v_visitor_subject text;
begin
  -- Check idempotency
  if p_idempotency_key is not null then
    select id into v_enquiry_id from public.enquiries where idempotency_key = p_idempotency_key;
    if v_enquiry_id is not null then
      return v_enquiry_id;
    end if;
  end if;

  -- Insert enquiry record
  insert into public.enquiries (
    type,
    contact_name,
    email,
    phone,
    preferred_contact,
    instrument,
    learner_group,
    learner_name,
    experience,
    preferred_times,
    message,
    source,
    contact_consent,
    location_updates,
    consent_version,
    idempotency_key,
    metadata
  ) values (
    p_type,
    p_contact_name,
    p_email,
    p_phone,
    p_preferred_contact,
    p_instrument,
    p_learner_group,
    p_learner_name,
    p_experience,
    p_preferred_times,
    p_message,
    p_source,
    p_contact_consent,
    p_location_updates,
    coalesce(p_consent_version, 'v1'),
    p_idempotency_key,
    coalesce(p_metadata, '{}'::jsonb)
  )
  returning id into v_enquiry_id;

  -- Compose subjects based on enquiry type
  if p_type = 'lesson' then
    v_owner_subject := concat('New lesson enquiry — ', coalesce(initcap(p_instrument::text), 'General'), ' — ', coalesce(initcap(p_learner_group::text), 'Learner'));
    v_visitor_subject := 'Thank you for your enquiry — Mozart School Of Western Classical Music';
  elsif p_type = 'location_interest' then
    v_owner_subject := 'New location-interest registration — Mozart School';
    v_visitor_subject := 'Location update registration — Mozart School Of Western Classical Music';
  else
    v_owner_subject := 'New message from website — Mozart School';
    v_visitor_subject := 'We have received your message — Mozart School Of Western Classical Music';
  end if;

  -- 1. Queue Owner Notification Job
  insert into public.notification_jobs (
    enquiry_id,
    kind,
    status,
    recipient,
    subject,
    next_attempt_at
  ) values (
    v_enquiry_id,
    'owner_alert',
    'pending',
    coalesce(p_owner_email, 'srinivaschetty@gmail.com'),
    v_owner_subject,
    now()
  );

  -- 2. Queue Visitor Acknowledgement Job (only if email was supplied)
  if p_email is not null and char_length(trim(p_email)) > 0 then
    insert into public.notification_jobs (
      enquiry_id,
      kind,
      status,
      recipient,
      subject,
      next_attempt_at
    ) values (
      v_enquiry_id,
      'visitor_acknowledgement',
      'pending',
      trim(lower(p_email)),
      v_visitor_subject,
      now()
    );
  end if;

  return v_enquiry_id;
end;
$$;

-- 11. Safe Notification Lease Claiming Function
-- Used by the notification worker to claim a batch of jobs with a 5-minute lease
create or replace function public.claim_notification_jobs(
  p_batch_size integer default 10,
  p_lease_seconds integer default 300
)
returns setof public.notification_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_token uuid := gen_random_uuid();
  v_now timestamptz := now();
  v_expires timestamptz := v_now + (p_lease_seconds || ' seconds')::interval;
begin
  return query
  with claimed as (
    update public.notification_jobs
    set
      status = 'processing',
      processing_token = v_token,
      processing_expires_at = v_expires,
      attempts = attempts + 1
    where id in (
      select id
      from public.notification_jobs
      where (
        (status = 'pending' and next_attempt_at <= v_now)
        or
        (status = 'processing' and processing_expires_at < v_now)
        or
        (status = 'failed' and attempts < 5 and next_attempt_at <= v_now)
      )
      order by next_attempt_at asc
      limit p_batch_size
      for update skip locked
    )
    returning *
  )
  select * from claimed;
end;
$$;
