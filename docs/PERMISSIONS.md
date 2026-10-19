# Permissions

Authorization is decided by the database, using the signed-in user's id (`auth.uid()` from the Supabase JWT). The dashboard only hides what the database would refuse anyway.

A person has access only through a `staff_members` row that is **linked to their auth user id** and has `invitation_status = 'active'`. Emails, roles or ids sent by the browser are never trusted. The legacy `admin_users` table grants nothing (migration `20261020000003`).

## Roles

| Action | Visitor (anon) | Signed in, no active staff row (unknown, invited, expired, revoked) | Staff | Admin |
|---|---|---|---|---|
| Submit an enquiry (via `submit-enquiry`, with Turnstile) | ✅ | ✅ | ✅ | ✅ |
| Read enquiries and notes | ❌ | ❌ (0 rows) | ✅ | ✅ |
| Change enquiry **status** | ❌ | ❌ | ✅ | ✅ |
| Change contact details, consent, metadata | ❌ | ❌ | ❌ | ❌ (no client may) |
| Add a private note (author set from the session) | ❌ | ❌ | ✅ | ✅ |
| Delete a note | ❌ | ❌ | ❌ | ✅ |
| Delete an enquiry (erasure request) | ❌ | ❌ | ❌ | ✅ |
| View notification delivery (recipient, status, error) | ❌ | ❌ | ❌ | ✅ |
| Retry a failed notification (`retry_notification_job`) | ❌ | ❌ | ❌ | ✅ |
| Change notification recipient/subject | ❌ | ❌ | ❌ | ❌ |
| View staff directory | ❌ | own row only | ✅ (read-only) | ✅ |
| Invite / resend / revoke / reactivate staff (`manage-staff`) | ❌ | ❌ | ❌ | ✅ |
| Change any role or link a staff record | ❌ | ❌ | ❌ | ❌ (only `manage-staff` and activation) |

The Staff role description in the invite form ("Can view enquiries, update status, and add private staff notes") matches this table. Before this migration, staff could edit every enquiry column (including consent) but could not add notes.

## Server-only operations (service role)

| Function | Caller | Purpose |
|---|---|---|
| `submit_enquiry_atomic` | `submit-enquiry` | Idempotent insert + notification jobs |
| `check_rate_limit` | `submit-enquiry` | Atomic fixed-window counter |
| `claim_notification_jobs`, `finish_notification_job` | `process-notifications` | Lease-based queue; results only accepted from the lease holder |
| `bootstrap_first_admin` | SQL editor (database owner) only | First administrator |

EXECUTE on these is revoked from `PUBLIC`, `anon` and `authenticated`. The old 18-argument `submit_enquiry_atomic` overload was removed. All SECURITY DEFINER functions use `search_path = ''` with schema-qualified names.

## Invitation and activation

1. An admin invites someone in the dashboard. `manage-staff` checks that the caller is an active admin, creates an `invited` row (expires in 7 days) and sends a Supabase invitation. If the email already has an account, it sends a password-reset link instead. If no email can be sent, the row is removed and the admin sees the error.
2. The person opens the link, which lands on `/admin/auth/callback`, and sets a password.
3. The dashboard calls `activate_staff_membership()`. Access is granted only if the person's **confirmed** auth email matches an unlinked, unexpired, non-revoked invitation **and** a password is set. The row is then linked to their user id and becomes `active`. The role comes from the invitation and cannot be chosen by the user.
4. Revoking sets `revoked` (effective immediately for all queries) and bans the auth user from signing in. Reactivating unbans a linked account, or re-sends the invitation if it was never accepted. Admins cannot revoke themselves, so at least one active administrator always remains.

## Where this is tested

- `npm run test:db`: migrations plus about 160 assertions run as anon, an unknown user, invited, expired, active, revoked and legacy users, an admin and the service role. Includes concurrency tests for idempotency, rate limiting and job claiming.
- `npm test`: Edge Function handlers (Turnstile, CORS, rate-limit wiring, notifications, staff management) with mocked Supabase, Turnstile and Resend; plus frontend configuration and auth-callback handling.
