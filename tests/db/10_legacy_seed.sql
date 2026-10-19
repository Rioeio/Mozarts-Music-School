-- Data that existed before 20261020000003, inserted between migrations 002 and 003
-- so the hardening migration is tested against realistic legacy state.

insert into auth.users (id, email, email_confirmed_at, encrypted_password, raw_user_meta_data) values
  ('10000000-0000-0000-0000-000000000001', 'legacy.admin@test.local', now(), 'hash', '{"full_name":"Legacy Admin"}'),
  ('10000000-0000-0000-0000-000000000002', 'revoked.admin@test.local', now(), 'hash', '{}'),
  ('10000000-0000-0000-0000-000000000003', 'unlinked.admin@test.local', now(), 'hash', '{}');

-- All three were administrators through the legacy fallback table.
insert into public.admin_users (user_id) values
  ('10000000-0000-0000-0000-000000000001'),
  ('10000000-0000-0000-0000-000000000002'),
  ('10000000-0000-0000-0000-000000000003');

-- Revoked in the new directory, but still in admin_users: must lose access.
insert into public.staff_members (user_id, name, email, role, invitation_status)
values ('10000000-0000-0000-0000-000000000002', 'Revoked Admin', 'revoked.admin@test.local', 'admin', 'revoked');

-- Invited by email in the new directory but never linked: becomes an active admin.
insert into public.staff_members (user_id, name, email, role, invitation_status)
values (null, 'Unlinked Admin', 'unlinked.admin@test.local', 'staff', 'invited');

-- Old database-row-only invitation from a month ago: expires under the new rules.
insert into public.staff_members (user_id, name, email, role, invitation_status, invited_at)
values (null, 'Old Invite', 'old.invite@test.local', 'staff', 'invited', now() - interval '30 days');

insert into auth.users (id, email, email_confirmed_at, encrypted_password) values
  ('10000000-0000-0000-0000-000000000004', 'old.invite@test.local', now(), 'hash');

-- A legacy enquiry with no contact method, allowed by the old broken constraint.
insert into public.enquiries (type, contact_name, email, phone, source, contact_consent, idempotency_key)
values ('general', 'Legacy No Contact', null, null, 'legacy', true, 'legacy-no-contact');

-- Before 003 both overloads existed, so an 18-argument call was ambiguous.
select tests.expect_error($sql$
  select public.submit_enquiry_atomic(
    'lesson'::public.enquiry_type, 'Legacy Visitor', 'legacy.visitor@test.local', null, 'email',
    'piano'::public.instrument_type, 'adult'::public.learner_group_type, null,
    'beginner'::public.experience_level_type, null, null, 'legacy', true, false, 'v1',
    'legacy-ambiguous', '{}'::jsonb, 'owner@test.local')
$sql$, '42725', 'legacy: 18-argument call is ambiguous between the two overloads');

-- Before 003 anonymous callers could execute the privileged function directly.
set role anon;
select public.submit_enquiry_atomic(
  p_type => 'lesson', p_contact_name => 'Legacy Visitor', p_email => 'legacy.visitor@test.local',
  p_phone => null, p_preferred_contact => 'email', p_instrument => 'piano', p_learner_group => 'adult',
  p_learner_name => null, p_experience => 'beginner', p_preferred_times => null, p_message => null,
  p_source => 'legacy', p_contact_consent => true, p_location_updates => false, p_consent_version => 'v1',
  p_idempotency_key => 'legacy-anon-direct', p_metadata => '{}'::jsonb, p_owner_email => 'owner@test.local',
  p_class_preference => 'online');
reset role;
select tests.assert(
  (select count(*) from public.enquiries where idempotency_key = 'legacy-anon-direct') = 1,
  'legacy: anon could bypass the Edge Function through direct RPC (the vulnerability being fixed)');
