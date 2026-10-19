-- ==============================================================================
-- MOZART SCHOOL OF WESTERN CLASSICAL MUSIC
-- Migration: 20261005000002_staff_and_class_preference.sql
-- Adds class preference support and school staff access management
-- ==============================================================================

-- 1. Create Class Preference Enum
create type public.class_preference_type as enum (
  'online',
  'in_person',
  'either_guidance'
);

-- 2. Add class_preference to enquiries table
alter table public.enquiries
  add column if not exists class_preference public.class_preference_type;

-- 3. Create Staff Role and Status Enums
create type public.staff_role_type as enum (
  'admin',
  'staff'
);

create type public.staff_invitation_status_type as enum (
  'active',
  'invited',
  'revoked'
);

-- 4. Create staff_members table
-- School staff management only — no students, payments, fees, or bookings
create table if not exists public.staff_members (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  name text not null check (char_length(trim(name)) >= 2 and char_length(name) <= 120),
  email text not null unique check (email ~* '^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$'),
  role public.staff_role_type not null default 'staff',
  invitation_status public.staff_invitation_status_type not null default 'invited',
  invited_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists staff_members_email_idx on public.staff_members (email);
create index if not exists staff_members_status_idx on public.staff_members (invitation_status);

-- 5. Updated At Trigger
create trigger staff_members_updated_at
  before update on public.staff_members
  for each row execute function public.handle_updated_at();

-- 6. RLS on staff_members
alter table public.staff_members enable row level security;

-- Function to check if caller is an approved admin
create or replace function public.is_admin()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.staff_members
    where user_id = auth.uid()
      and role = 'admin'
      and invitation_status = 'active'
  )
  or exists (
    select 1
    from public.admin_users
    where admin_users.user_id = auth.uid()
  );
$$;

-- Function to check if caller is active staff (either admin or staff)
create or replace function public.is_active_staff()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.staff_members
    where user_id = auth.uid()
      and invitation_status = 'active'
  )
  or public.is_admin();
$$;

-- RLS: Only admins can manage (insert, update, delete) staff accounts
create policy "Admins can insert staff members"
  on public.staff_members
  for insert
  to authenticated
  with check (public.is_admin());

create policy "Admins can update staff members"
  on public.staff_members
  for update
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy "Admins can delete staff members"
  on public.staff_members
  for delete
  to authenticated
  using (public.is_admin());

-- Both Admin and Staff can view the staff directory
create policy "Active staff can view staff directory"
  on public.staff_members
  for select
  to authenticated
  using (public.is_active_staff());

-- Update enquiries RLS to allow all active staff (Admin or Staff) to view & update enquiries
create policy "Staff can view enquiries"
  on public.enquiries
  for select
  to authenticated
  using (public.is_active_staff());

create policy "Staff can update enquiries"
  on public.enquiries
  for update
  to authenticated
  using (public.is_active_staff())
  with check (public.is_active_staff());

-- 7. Update submit_enquiry_atomic to accept class_preference
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
set search_path = public
as $$
declare
  v_enquiry_id uuid;
  v_owner_subject text;
  v_visitor_subject text;
  v_pref_label text := '';
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
    class_preference,
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
    p_class_preference,
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

  -- Format preference label for subject line
  if p_class_preference is not null then
    if p_class_preference = 'online' then
      v_pref_label := ' (Online)';
    elsif p_class_preference = 'in_person' then
      v_pref_label := ' (In-person)';
    else
      v_pref_label := ' (Guidance requested)';
    end if;
  end if;

  -- Compose subjects
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

  -- 2. Queue Visitor Acknowledgement Job (if email supplied)
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
