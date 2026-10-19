-- Privilege, RLS and queue tests. Every assertion raises on failure (ON_ERROR_STOP).
-- Each persona block runs in a transaction that is rolled back unless noted.

-- ==============================================================================
-- A. Migration outcomes (postgres)
-- ==============================================================================
select tests.assert(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'submit_enquiry_atomic') = 1,
  'only one submit_enquiry_atomic overload remains');

select tests.assert(
  not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef
      and not coalesce(p.proconfig, '{}') @> array['search_path=""']
  ),
  'every SECURITY DEFINER function in public has an empty search_path');

select tests.assert(
  (select s.user_id = '10000000-0000-0000-0000-000000000001' and s.role = 'admin' and s.invitation_status = 'active'
   from public.staff_members s where s.email = 'legacy.admin@test.local'),
  'legacy admin_users administrator migrated to an active admin staff row');

select tests.assert(
  (select s.invitation_status = 'revoked' from public.staff_members s where s.email = 'revoked.admin@test.local'),
  'legacy administrator revoked in staff_members stays revoked');

select tests.assert(
  (select s.user_id = '10000000-0000-0000-0000-000000000003' and s.role = 'admin' and s.invitation_status = 'active'
   from public.staff_members s where s.email = 'unlinked.admin@test.local'),
  'legacy administrator with an unlinked invitation is linked and activated');

select tests.assert(
  (select s.invite_expires_at < now() from public.staff_members s where s.email = 'old.invite@test.local'),
  'old database-only invitation now has an expiry in the past');

select tests.assert((select count(*) from public.admin_users) = 3, 'admin_users rows preserved');

select tests.assert(
  exists (select 1 from public.enquiries where idempotency_key = 'legacy-no-contact'),
  'legacy enquiry without contact method preserved');

select tests.assert(
  (select not c.convalidated from pg_constraint c where c.conname = 'enquiries_has_contact_method'),
  'contact constraint left NOT VALID while legacy violations exist');

-- Function privileges
select tests.assert(not has_function_privilege('anon', p, 'execute') and not has_function_privilege('authenticated', p, 'execute') and has_function_privilege('service_role', p, 'execute'),
  'service_role only: ' || p)
from unnest(array[
  'public.submit_enquiry_atomic(public.enquiry_type,text,text,text,text,public.instrument_type,public.learner_group_type,text,public.experience_level_type,text,text,text,boolean,boolean,text,text,jsonb,text,public.class_preference_type)',
  'public.claim_notification_jobs(integer,integer)',
  'public.finish_notification_job(uuid,uuid,boolean,text,text)',
  'public.check_rate_limit(text,integer,integer)'
]) as p;

select tests.assert(not has_function_privilege('anon', 'public.bootstrap_first_admin(text,text)', 'execute')
  and not has_function_privilege('authenticated', 'public.bootstrap_first_admin(text,text)', 'execute')
  and not has_function_privilege('service_role', 'public.bootstrap_first_admin(text,text)', 'execute'),
  'bootstrap_first_admin is only callable by the database owner');

select tests.assert(not has_function_privilege('anon', 'public.retry_notification_job(uuid)', 'execute')
  and has_function_privilege('authenticated', 'public.retry_notification_job(uuid)', 'execute'),
  'retry_notification_job: authenticated (checked inside), not anon');

select tests.assert(not has_function_privilege('anon', 'public.activate_staff_membership()', 'execute'),
  'anon cannot call activate_staff_membership');

-- Table and column privileges
select tests.assert(not has_table_privilege('anon', t, 'select') and not has_table_privilege('anon', t, 'insert')
  and not has_table_privilege('anon', t, 'update') and not has_table_privilege('anon', t, 'delete'),
  'anon has no privileges on ' || t)
from unnest(array['public.enquiries', 'public.enquiry_notes', 'public.notification_jobs', 'public.staff_members', 'public.rate_limits', 'public.admin_users']) as t;

select tests.assert(not has_table_privilege('authenticated', t, 'select'), 'authenticated cannot read ' || t)
from unnest(array['public.rate_limits', 'public.admin_users']) as t;

select tests.assert(has_column_privilege('authenticated', 'public.enquiries', 'status', 'update'), 'authenticated may update enquiries.status');
select tests.assert(not has_column_privilege('authenticated', 'public.enquiries', c, 'update'), 'authenticated cannot update enquiries.' || c)
from unnest(array['contact_consent', 'consented_at', 'consent_version', 'location_updates', 'email', 'phone', 'contact_name', 'metadata', 'idempotency_key', 'updated_at']) as c;
select tests.assert(not has_table_privilege('authenticated', 'public.enquiries', 'insert'), 'authenticated cannot insert enquiries');
select tests.assert(not has_column_privilege('authenticated', 'public.enquiry_notes', c, 'insert'), 'authenticated cannot set enquiry_notes.' || c)
from unnest(array['admin_user_id', 'admin_email', 'created_at']) as c;
select tests.assert(not has_table_privilege('authenticated', 'public.notification_jobs', 'update'), 'authenticated cannot update notification jobs');
select tests.assert(not has_column_privilege('authenticated', 'public.notification_jobs', 'processing_token', 'select'), 'processing_token is not readable');
select tests.assert(not has_table_privilege('authenticated', 'public.staff_members', p), 'authenticated cannot ' || p || ' staff_members')
from unnest(array['insert', 'update', 'delete']) as p;

-- ==============================================================================
-- B. Anonymous visitor
-- ==============================================================================
begin;
set local role anon;
select tests.expect_error('select * from public.' || t, '42501', 'anon cannot read ' || t)
from unnest(array['enquiries', 'enquiry_notes', 'notification_jobs', 'staff_members', 'rate_limits', 'admin_users']) as t;
select tests.expect_error($$insert into public.enquiries (type, contact_name, email, source, contact_consent) values ('general', 'Anon Direct', 'anon@test.local', 'x', true)$$, '42501', 'anon cannot insert enquiries directly');
select tests.expect_error($$select public.submit_enquiry_atomic(p_type => 'general', p_contact_name => 'Bypass', p_email => 'bypass@test.local', p_phone => null, p_preferred_contact => 'email', p_instrument => null, p_learner_group => null, p_learner_name => null, p_experience => null, p_preferred_times => null, p_message => null, p_source => 'rpc', p_contact_consent => true, p_location_updates => false, p_consent_version => 'v1', p_idempotency_key => 'anon-bypass', p_metadata => '{}', p_owner_email => 'attacker@test.local', p_class_preference => null)$$, '42501', 'anon cannot bypass submit-enquiry through RPC');
select tests.expect_error($$select public.submit_enquiry_atomic('general', 'Bypass', 'bypass@test.local', null, 'email', null, null, null, null, null, null, 'rpc', true, false, 'v1', 'anon-bypass-2', '{}', 'attacker@test.local')$$, '42501', 'anon cannot call the former 18-argument signature either');
select tests.expect_error($$select * from public.claim_notification_jobs(10, 300)$$, '42501', 'anon cannot claim notification jobs');
select tests.expect_error($$select public.finish_notification_job(gen_random_uuid(), gen_random_uuid(), true, 'x', null)$$, '42501', 'anon cannot finish notification jobs');
select tests.expect_error($$select public.check_rate_limit('x', 1, 60)$$, '42501', 'anon cannot touch rate limits');
select tests.expect_error($$select public.retry_notification_job(gen_random_uuid())$$, '42501', 'anon cannot retry notifications');
select tests.expect_error($$select public.activate_staff_membership()$$, '42501', 'anon cannot activate staff membership');
select tests.expect_error($$select public.bootstrap_first_admin('anon@test.local', 'Anon')$$, '42501', 'anon cannot bootstrap an admin');
rollback;

-- ==============================================================================
-- C. Unknown authenticated user (valid JWT, no staff record)
-- ==============================================================================
begin;
select tests.login('20000000-0000-0000-0000-000000000001');
select tests.assert(tests.count_rows('select id from public.enquiries') = 0, 'unknown user sees no enquiries');
select tests.assert(tests.count_rows('select id from public.enquiry_notes') = 0, 'unknown user sees no notes');
select tests.assert(tests.count_rows('select id, recipient from public.notification_jobs') = 0, 'unknown user sees no notification jobs');
select tests.assert(tests.count_rows('select id from public.staff_members') = 0, 'unknown user sees no staff directory');
select tests.assert(not public.is_active_staff() and not public.is_admin(), 'unknown user is not staff');
select tests.assert(public.activate_staff_membership() ->> 'status' = 'none', 'unknown user activation returns none');
select tests.assert(tests.affected($$update public.enquiries set status = 'spam'$$) = 0, 'unknown user cannot update enquiries');
select tests.assert(tests.affected($$delete from public.enquiries$$) = 0, 'unknown user cannot delete enquiries');
select tests.expect_error($$insert into public.enquiry_notes (enquiry_id, note) values ((select gen_random_uuid()), 'x')$$, '42501', 'unknown user note insert rejected by RLS');
select tests.expect_error($$insert into public.staff_members (user_id, name, email, role, invitation_status) values (auth.uid(), 'Me', 'unknown@test.local', 'admin', 'active')$$, '42501', 'unknown user cannot grant themselves admin');
select tests.expect_error($$select * from public.claim_notification_jobs(10, 300)$$, '42501', 'authenticated cannot claim notification jobs');
select tests.expect_error($$select public.submit_enquiry_atomic(p_type => 'general', p_contact_name => 'Bypass', p_email => 'bypass@test.local', p_phone => null, p_preferred_contact => 'email', p_instrument => null, p_learner_group => null, p_learner_name => null, p_experience => null, p_preferred_times => null, p_message => null, p_source => 'rpc', p_contact_consent => true, p_location_updates => false, p_consent_version => 'v1', p_idempotency_key => 'auth-bypass', p_metadata => '{}', p_owner_email => 'attacker@test.local', p_class_preference => null)$$, '42501', 'authenticated cannot bypass submit-enquiry through RPC');
select tests.expect_error($$select public.check_rate_limit('x', 1, 60)$$, '42501', 'authenticated cannot touch rate limits');
select tests.expect_error($$select public.retry_notification_job((select gen_random_uuid()))$$, '42501', 'non-admin cannot retry notifications');
rollback;

-- ==============================================================================
-- D. Invited staff before password setup, then after
-- ==============================================================================
begin;
select tests.login('20000000-0000-0000-0000-000000000004');
select tests.assert(public.activate_staff_membership() ->> 'status' = 'password_required', 'invited user without password is not activated');
select tests.assert(not public.is_active_staff(), 'invited user without password has no access');
select tests.assert(tests.count_rows('select id from public.enquiries') = 0, 'invited user sees no enquiries before activation');
reset role;
update auth.users set encrypted_password = 'hash' where id = '20000000-0000-0000-0000-000000000004';
select tests.login('20000000-0000-0000-0000-000000000004');
select tests.assert(public.activate_staff_membership() ->> 'status' = 'active', 'invited user activates after setting a password');
select tests.assert(public.is_active_staff() and not public.is_admin(), 'activated invitee is staff, not admin');
rollback;

-- ==============================================================================
-- E. Invited staff with password (committed: used by later sections)
-- ==============================================================================
begin;
select tests.login('20000000-0000-0000-0000-000000000005');
select tests.assert(tests.count_rows('select id from public.enquiries') = 0, 'pending invitee sees nothing before activation');
select tests.assert(public.activate_staff_membership() ->> 'status' = 'active', 'invitee with confirmed email and password activates');
select tests.assert(public.activate_staff_membership() ->> 'role' = 'staff', 'activation keeps the invited role');
select tests.assert(public.activate_staff_membership() ->> 'status' = 'active', 'activation is idempotent');
select tests.assert(tests.count_rows('select id from public.enquiries') > 0, 'activated invitee can read enquiries');
commit;
select tests.assert(
  (select s.user_id = '20000000-0000-0000-0000-000000000005' and s.accepted_at is not null from public.staff_members s where s.email = 'invited.pw@test.local'),
  'activation linked staff_members.user_id to the authenticated user');

-- ==============================================================================
-- F. Unconfirmed email, expired invite, attacker linking attempts
-- ==============================================================================
begin;
select tests.login('20000000-0000-0000-0000-000000000006');
select tests.assert(public.activate_staff_membership() ->> 'status' = 'none', 'unconfirmed email cannot activate an invitation');
select tests.login('10000000-0000-0000-0000-000000000004');
select tests.assert(public.activate_staff_membership() ->> 'status' = 'expired', 'expired invitation cannot be activated');
select tests.assert(not public.is_active_staff(), 'expired invitee has no access');
select tests.login('20000000-0000-0000-0000-000000000007');
select tests.assert(public.activate_staff_membership() ->> 'status' = 'none', 'attacker cannot activate someone else''s invitation');
select tests.expect_error($$update public.staff_members set user_id = auth.uid() where email = 'invited.nopw@test.local'$$, '42501', 'attacker cannot link themselves to another staff record');
select tests.expect_error($$update auth.users set email = 'invited.nopw@test.local' where id = auth.uid()$$, '42501', 'attacker cannot rewrite their auth email in the database');
rollback;

-- ==============================================================================
-- G. Active staff
-- ==============================================================================
begin;
select tests.login('20000000-0000-0000-0000-000000000002');
select tests.assert(tests.count_rows('select * from public.enquiries') > 0, 'active staff can read enquiries');
select tests.assert(tests.affected($$update public.enquiries set status = 'contacted' where idempotency_key = 'seed-1'$$) = 1, 'active staff can update enquiry status');
select tests.expect_error($$update public.enquiries set contact_consent = false where idempotency_key = 'seed-1'$$, '42501', 'staff cannot change consent');
select tests.expect_error($$update public.enquiries set email = 'changed@test.local' where idempotency_key = 'seed-1'$$, '42501', 'staff cannot change contact details');
select tests.expect_error($$update public.enquiries set location_updates = true where idempotency_key = 'seed-1'$$, '42501', 'staff cannot change location-update consent');
select tests.assert(tests.affected($$insert into public.enquiry_notes (enquiry_id, note) select id, 'Called back' from public.enquiries where idempotency_key = 'seed-1'$$) = 1, 'active staff can add a note');
select tests.assert(
  (select n.admin_user_id = '20000000-0000-0000-0000-000000000002' and n.admin_email = 'staff@test.local' from public.enquiry_notes n where n.note = 'Called back'),
  'note author is taken from the session');
select tests.expect_error($$insert into public.enquiry_notes (enquiry_id, admin_user_id, admin_email, note) select id, '10000000-0000-0000-0000-000000000001', 'legacy.admin@test.local', 'Spoofed' from public.enquiries limit 1$$, '42501', 'staff cannot spoof the note author');
select tests.assert(tests.affected($$delete from public.enquiries where idempotency_key = 'seed-1'$$) = 0, 'staff cannot delete enquiries');
select tests.assert(tests.affected($$delete from public.enquiry_notes$$) = 0, 'staff cannot delete notes');
select tests.assert(tests.count_rows('select id, recipient from public.notification_jobs') = 0, 'staff cannot read notification jobs');
select tests.expect_error($$select public.retry_notification_job((select gen_random_uuid()))$$, '42501', 'staff cannot retry notifications');
select tests.assert(tests.count_rows('select id from public.staff_members') > 0, 'active staff can view the staff directory');
select tests.expect_error($$update public.staff_members set role = 'admin' where user_id = auth.uid()$$, '42501', 'staff cannot change their own role');
select tests.expect_error($$update public.staff_members set invitation_status = 'active' where email = 'revoked@test.local'$$, '42501', 'staff cannot reactivate others');
select tests.expect_error($$select * from public.claim_notification_jobs(10, 300)$$, '42501', 'staff cannot claim notification jobs');
rollback;

-- ==============================================================================
-- H. Revoked staff, and the legacy administrator revoked in staff_members
-- ==============================================================================
begin;
select tests.login('20000000-0000-0000-0000-000000000003');
select tests.assert(public.activate_staff_membership() ->> 'status' = 'revoked', 'revoked staff activation returns revoked');
select tests.assert(tests.count_rows('select id from public.enquiries') = 0, 'revoked staff sees no enquiries');
select tests.assert(tests.affected($$update public.enquiries set status = 'spam'$$) = 0, 'revoked staff cannot update enquiries');
select tests.expect_error($$insert into public.enquiry_notes (enquiry_id, note) values ((select gen_random_uuid()), 'x')$$, '42501', 'revoked staff cannot add notes');
select tests.login('10000000-0000-0000-0000-000000000002');
select tests.assert(not public.is_admin() and not public.is_active_staff(), 'revoked legacy admin no longer has access via admin_users');
select tests.assert(tests.count_rows('select id from public.enquiries') = 0, 'revoked legacy admin sees no enquiries');
rollback;

-- ==============================================================================
-- I. Administrator
-- ==============================================================================
begin;
select tests.login('10000000-0000-0000-0000-000000000001');
select tests.assert(public.is_admin(), 'migrated legacy admin is an admin');
select tests.assert(tests.count_rows('select id, recipient, status, last_error from public.notification_jobs') > 0, 'admin can read notification jobs');
select tests.expect_error($$select processing_token from public.notification_jobs$$, '42501', 'admin cannot read lease tokens');
select tests.expect_error($$update public.notification_jobs set recipient = 'attacker@test.local'$$, '42501', 'admin cannot redirect notification recipients');
select public.retry_notification_job((select j.id from public.notification_jobs j where j.status = 'failed' limit 1));
select tests.assert(
  (select j.status = 'pending' and j.attempts = 0 and j.last_error is null from public.notification_jobs j join public.enquiries e on e.id = j.enquiry_id where e.idempotency_key = 'seed-2' and j.kind = 'owner_alert'),
  'admin retry re-queues a failed notification');
select tests.expect_error($$select public.retry_notification_job((select j.id from public.notification_jobs j where j.status = 'pending' limit 1))$$, 'P0002', 'only failed notifications can be retried');
select tests.assert(tests.affected($$delete from public.enquiries where idempotency_key = 'seed-2'$$) = 1, 'admin can delete an enquiry');
select tests.expect_error($$insert into public.staff_members (name, email, role) values ('Direct', 'direct@test.local', 'staff')$$, '42501', 'admin staff changes go through the Edge Function, not direct writes');
select tests.expect_error($$select * from public.claim_notification_jobs(10, 300)$$, '42501', 'admin cannot claim notification jobs');
select tests.expect_error($$select public.bootstrap_first_admin('unknown@test.local', 'X')$$, '42501', 'admin cannot call bootstrap_first_admin');
rollback;

-- ==============================================================================
-- J. Service role: submission, constraint, idempotency
-- ==============================================================================
begin;
set local role service_role;
create temporary table ids (k text, id uuid) on commit drop;
insert into ids select 'a', public.submit_enquiry_atomic(p_type => 'lesson', p_contact_name => 'Svc Visitor', p_email => 'svc@test.local', p_phone => null, p_preferred_contact => 'email', p_instrument => 'piano', p_learner_group => 'adult', p_learner_name => null, p_experience => 'beginner', p_preferred_times => null, p_message => null, p_source => 'svc', p_contact_consent => true, p_location_updates => false, p_consent_version => 'v1', p_idempotency_key => 'svc-key', p_metadata => '{}', p_owner_email => 'owner@test.local', p_class_preference => 'in_person');
insert into ids select 'b', public.submit_enquiry_atomic(p_type => 'lesson', p_contact_name => 'Svc Visitor', p_email => 'svc@test.local', p_phone => null, p_preferred_contact => 'email', p_instrument => 'piano', p_learner_group => 'adult', p_learner_name => null, p_experience => 'beginner', p_preferred_times => null, p_message => null, p_source => 'svc', p_contact_consent => true, p_location_updates => false, p_consent_version => 'v1', p_idempotency_key => 'svc-key', p_metadata => '{}', p_owner_email => 'owner@test.local', p_class_preference => 'in_person');
select tests.assert((select count(distinct id) from ids) = 1, 'duplicate idempotency key returns the original enquiry');
select tests.assert((select count(*) from public.enquiries where idempotency_key = 'svc-key') = 1, 'duplicate idempotency key creates one enquiry');
select tests.assert((select count(*) from public.notification_jobs j join ids on ids.id = j.enquiry_id where ids.k = 'a') = 1, 'duplicate submission does not queue extra notifications');
select tests.assert((select count(*) from public.notification_jobs j join ids on ids.id = j.enquiry_id where ids.k = 'a' and j.kind = 'visitor_acknowledgement') = 0, 'only the owner alert is queued (no visitor acknowledgement)');
select tests.assert((select subject from public.notification_jobs j join ids on ids.id = j.enquiry_id where ids.k = 'a' and j.kind = 'owner_alert') like '%(In-person)', 'owner subject includes class preference');
select tests.expect_error($$select public.submit_enquiry_atomic(p_type => 'general', p_contact_name => 'Blank Contact', p_email => '   ', p_phone => '        ', p_preferred_contact => 'email', p_instrument => null, p_learner_group => null, p_learner_name => null, p_experience => null, p_preferred_times => null, p_message => null, p_source => 'svc', p_contact_consent => true, p_location_updates => false, p_consent_version => 'v1', p_idempotency_key => 'svc-blank', p_metadata => '{}', p_owner_email => 'owner@test.local')$$, '23514', 'blank email and phone are rejected');
select tests.expect_error($$insert into public.enquiries (type, contact_name, email, phone, source, contact_consent) values ('general', 'Whitespace Phone', null, '         ', 'svc', true)$$, '23514', 'whitespace-only phone does not count as a contact method');
select tests.expect_error($$insert into public.enquiries (type, contact_name, email, phone, source, contact_consent) values ('general', 'No Contact', null, null, 'svc', true)$$, '23514', 'enquiry with no contact method is rejected');
select tests.expect_error($$select public.submit_enquiry_atomic(p_type => 'general', p_contact_name => 'No Owner', p_email => 'x@test.local', p_phone => null, p_preferred_contact => 'email', p_instrument => null, p_learner_group => null, p_learner_name => null, p_experience => null, p_preferred_times => null, p_message => null, p_source => 'svc', p_contact_consent => true, p_location_updates => false, p_consent_version => 'v1', p_idempotency_key => 'svc-no-owner', p_metadata => '{}', p_owner_email => ' ')$$, '22023', 'owner notification address is required');
select tests.expect_error($$select public.bootstrap_first_admin('unknown@test.local', 'X')$$, '42501', 'service_role cannot call bootstrap_first_admin');
rollback;

-- ==============================================================================
-- K. Service role: notification leases, retries and backoff
-- ==============================================================================
begin;
update public.notification_jobs set status = 'sent';
insert into public.notification_jobs (id, enquiry_id, kind, recipient, subject)
select '30000000-0000-0000-0000-000000000001', e.id, 'visitor_acknowledgement', 'lease@test.local', 'Lease test'
from public.enquiries e where e.idempotency_key = 'legacy-no-contact';

set local role service_role;
create temporary table claim_a on commit drop as select * from public.claim_notification_jobs(10, 300);
select tests.assert((select count(*) from claim_a) = 1, 'worker A claims the pending job');
select tests.assert((select attempts = 1 and status = 'processing' from claim_a), 'claim increments attempts and sets processing');
select tests.assert((select count(*) from public.claim_notification_jobs(10, 300)) = 0, 'a leased job is not claimed twice');
select tests.assert(public.finish_notification_job('30000000-0000-0000-0000-000000000001', gen_random_uuid(), true, 'msg-wrong', null) = 'lease_lost', 'finishing with the wrong token is refused');

reset role;
update public.notification_jobs set processing_expires_at = now() - interval '1 second' where id = '30000000-0000-0000-0000-000000000001';
set local role service_role;
create temporary table claim_b on commit drop as select * from public.claim_notification_jobs(10, 300);
select tests.assert((select count(*) from claim_b) = 1 and (select processing_token from claim_b) <> (select processing_token from claim_a), 'worker B reclaims the expired lease with a new token');
select tests.assert(public.finish_notification_job('30000000-0000-0000-0000-000000000001', (select processing_token from claim_a), true, 'msg-a', null) = 'lease_lost', 'worker A cannot update a job reclaimed by worker B');
select tests.assert(public.finish_notification_job('30000000-0000-0000-0000-000000000001', (select processing_token from claim_b), false, null, 'Resend 500') = 'retry_scheduled', 'worker B failure schedules a retry');
select tests.assert(
  (select status = 'pending' and last_error = 'Resend 500' and next_attempt_at > now() + interval '3 minutes' and processing_token is null
   from public.notification_jobs where id = '30000000-0000-0000-0000-000000000001'),
  'retry uses exponential backoff and releases the lease');

reset role;
update public.notification_jobs set attempts = 4, next_attempt_at = now() where id = '30000000-0000-0000-0000-000000000001';
set local role service_role;
create temporary table claim_c on commit drop as select * from public.claim_notification_jobs(10, 300);
select tests.expect_error(format($$select public.finish_notification_job('30000000-0000-0000-0000-000000000001', %L, true, '  ', null)$$, (select processing_token from claim_c)), '22023', 'a job cannot be marked sent without a provider message id');
select tests.assert(public.finish_notification_job('30000000-0000-0000-0000-000000000001', (select processing_token from claim_c), false, null, 'Final failure') = 'failed', 'the fifth failed attempt marks the job failed');
select tests.assert((select count(*) from public.claim_notification_jobs(10, 300)) = 0, 'failed jobs at the attempt limit are not reclaimed');

reset role;
update public.notification_jobs set status = 'processing', attempts = 5, processing_token = gen_random_uuid(), processing_expires_at = now() - interval '1 second' where id = '30000000-0000-0000-0000-000000000001';
set local role service_role;
select tests.assert((select count(*) from public.claim_notification_jobs(10, 300)) = 0, 'expired lease on the final attempt is not reclaimed');
select tests.assert((select status = 'failed' from public.notification_jobs where id = '30000000-0000-0000-0000-000000000001'), 'expired lease on the final attempt is failed for review');

reset role;
update public.notification_jobs set status = 'pending', attempts = 0, next_attempt_at = now(), processing_token = null, processing_expires_at = null where id = '30000000-0000-0000-0000-000000000001';
set local role service_role;
create temporary table claim_d on commit drop as select * from public.claim_notification_jobs(10, 300);
select tests.assert(public.finish_notification_job('30000000-0000-0000-0000-000000000001', (select processing_token from claim_d), true, 're_123', null) = 'sent', 'successful delivery marks the job sent');
select tests.assert((select status = 'sent' and provider_message_id = 're_123' from public.notification_jobs where id = '30000000-0000-0000-0000-000000000001'), 'provider message id recorded');
rollback;

-- ==============================================================================
-- L. Service role: atomic rate limiting
-- ==============================================================================
begin;
set local role service_role;
select tests.assert(public.check_rate_limit('test:ip', 3, 60), 'rate limit request 1 allowed');
select tests.assert(public.check_rate_limit('test:ip', 3, 60), 'rate limit request 2 allowed');
select tests.assert(public.check_rate_limit('test:ip', 3, 60), 'rate limit request 3 allowed');
select tests.assert(not public.check_rate_limit('test:ip', 3, 60), 'rate limit request 4 blocked');
reset role;
update public.rate_limits set expires_at = now() - interval '1 second' where key = 'test:ip';
set local role service_role;
select tests.assert(public.check_rate_limit('test:ip', 3, 60), 'rate limit window resets after expiry');
select tests.expect_error($$select public.check_rate_limit('', 3, 60)$$, '22023', 'rate limit rejects an empty key');
rollback;

-- ==============================================================================
-- M. First-administrator bootstrap (postgres, as in the SQL editor)
-- ==============================================================================
begin;
select tests.expect_error($$select public.bootstrap_first_admin('unknown@test.local', 'First Admin')$$, '55000', 'bootstrap refuses while an active admin exists');
update public.staff_members set invitation_status = 'revoked' where role = 'admin';
select tests.expect_error($$select public.bootstrap_first_admin('unconfirmed@test.local', 'First Admin')$$, 'P0002', 'bootstrap requires a confirmed auth user');
select public.bootstrap_first_admin('Unknown@Test.local', 'First Admin');
select tests.login('20000000-0000-0000-0000-000000000001');
select tests.assert(public.is_admin(), 'bootstrapped user is an active admin');
rollback;
