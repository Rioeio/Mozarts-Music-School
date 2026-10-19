-- ==============================================================================
-- Owner alerts only
--
-- New enquiries queue a single email: the alert to the school owner. Visitors no
-- longer receive an automatic acknowledgement email (they still see the on-screen
-- confirmation). Same signature as 20261020000003, so `create or replace` keeps
-- its service-role-only grants and comment. Existing queued jobs are untouched.
--
-- To bring acknowledgements back later, add a migration that restores the
-- 'visitor_acknowledgement' insert from 20261020000003_security_hardening.sql.
-- ==============================================================================

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
  v_pref_label text := '';
begin
  if v_owner_email is null then
    raise exception 'Owner notification address is required.' using errcode = '22023';
  end if;

  -- Concurrency-safe idempotency: a duplicate key inserts nothing and returns the
  -- original enquiry without queueing a second notification.
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
  elsif p_type = 'location_interest' then
    v_owner_subject := 'New location-interest registration — Mozart School';
  else
    v_owner_subject := 'New message from website — Mozart School';
  end if;

  insert into public.notification_jobs (enquiry_id, kind, status, recipient, subject, next_attempt_at)
  values (v_enquiry_id, 'owner_alert', 'pending', v_owner_email, v_owner_subject, now());

  return v_enquiry_id;
end;
$$;
