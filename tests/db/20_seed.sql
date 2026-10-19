-- Personas and data created after all migrations have run.
--   10..01 legacy admin (migrated to an active admin staff row)
--   20..01 unknown authenticated user (no staff record)
--   20..02 active staff
--   20..03 revoked staff
--   20..04 invited staff, password not set yet
--   20..05 invited staff, password set (can activate)
--   20..06 invited staff, email not confirmed
--   20..07 authenticated attacker with no staff record

insert into auth.users (id, email, email_confirmed_at, encrypted_password) values
  ('20000000-0000-0000-0000-000000000001', 'unknown@test.local', now(), 'hash'),
  ('20000000-0000-0000-0000-000000000002', 'staff@test.local', now(), 'hash'),
  ('20000000-0000-0000-0000-000000000003', 'revoked@test.local', now(), 'hash'),
  ('20000000-0000-0000-0000-000000000004', 'invited.nopw@test.local', now(), ''),
  ('20000000-0000-0000-0000-000000000005', 'invited.pw@test.local', now(), 'hash'),
  ('20000000-0000-0000-0000-000000000006', 'unconfirmed@test.local', null, 'hash'),
  ('20000000-0000-0000-0000-000000000007', 'attacker@test.local', now(), 'hash');

insert into public.staff_members (user_id, name, email, role, invitation_status, invite_expires_at, accepted_at) values
  ('20000000-0000-0000-0000-000000000002', 'Active Staff', 'staff@test.local', 'staff', 'active', null, now()),
  ('20000000-0000-0000-0000-000000000003', 'Revoked Staff', 'revoked@test.local', 'staff', 'revoked', null, now()),
  (null, 'Invited NoPw', 'invited.nopw@test.local', 'staff', 'invited', now() + interval '7 days', null),
  (null, 'Invited Pw', 'invited.pw@test.local', 'staff', 'invited', now() + interval '7 days', null),
  (null, 'Unconfirmed', 'unconfirmed@test.local', 'admin', 'invited', now() + interval '7 days', null);

set role service_role;

select public.submit_enquiry_atomic(
  p_type => 'lesson', p_contact_name => 'Seed Visitor', p_email => 'Seed.Visitor@Test.local',
  p_phone => '9876543210', p_preferred_contact => 'either', p_instrument => 'violin',
  p_learner_group => 'child', p_learner_name => 'Kid', p_experience => 'beginner',
  p_preferred_times => 'Weekends', p_message => 'Hello', p_source => 'seed',
  p_contact_consent => true, p_location_updates => false, p_consent_version => 'v1',
  p_idempotency_key => 'seed-1', p_metadata => '{}'::jsonb, p_owner_email => 'owner@test.local',
  p_class_preference => 'online');

select public.submit_enquiry_atomic(
  p_type => 'general', p_contact_name => 'Phone Only', p_email => null,
  p_phone => '9876500000', p_preferred_contact => 'phone', p_instrument => null,
  p_learner_group => null, p_learner_name => null, p_experience => null,
  p_preferred_times => null, p_message => 'Call me', p_source => 'seed',
  p_contact_consent => true, p_location_updates => false, p_consent_version => 'v1',
  p_idempotency_key => 'seed-2', p_metadata => '{}'::jsonb, p_owner_email => 'owner@test.local');

reset role;

-- One permanently failed notification for the retry tests.
update public.notification_jobs j
   set status = 'failed', attempts = 5, last_error = 'Seeded failure'
  from public.enquiries e
 where e.id = j.enquiry_id and e.idempotency_key = 'seed-2' and j.kind = 'owner_alert';
