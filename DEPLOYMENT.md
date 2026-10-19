# Deployment guide

Production setup for the Mozart School website:

- **Vercel** hosts the built frontend (a static Vite single-page app in `dist/`). There are no Vercel Functions and no Vercel Cron jobs.
- **Supabase** provides Auth, Postgres (with row level security), three Edge Functions and the notification scheduler (pg_cron).
- **Resend** sends notification emails and Supabase Auth emails.
- **Cloudflare Turnstile** protects the public enquiry form. It is independent of hosting and stays on Cloudflare.

The permission model is described in [docs/PERMISSIONS.md](docs/PERMISSIONS.md).

> Nothing in this repository deploys automatically. Follow the steps in order.

> **Vercel plan:** Vercel's Hobby plan is limited to non-commercial personal use, and commercial use (including a site that advertises a paid service, such as music lessons) requires a **Pro** or Enterprise plan. See Vercel's [Fair Use Guidelines → Commercial usage](https://vercel.com/docs/limits/fair-use-guidelines#commercial-usage) and [pricing](https://vercel.com/pricing). Create the project in a Pro team.

---

## 1. Where each setting lives

| Setting | Where | Public? |
|---|---|---|
| `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_TURNSTILE_SITE_KEY` | Vercel → Project → Settings → **Environment Variables**, per environment (Production / Preview), or `.env.local` for local dev | Yes, they are compiled into the JavaScript |
| `SITE_INDEXING`, `SITE_URL` | Vercel Environment Variables (Production only) | Build-time only |
| `ALLOWED_ORIGINS`, `SITE_URL`, `OWNER_EMAIL`, `TURNSTILE_SECRET_KEY`, `RESEND_API_KEY`, `FROM_EMAIL`, `NOTIFICATIONS_CRON_SECRET`, `CLIENT_IP_TRUSTED_PROXY_HOPS`, `EMAIL_DELIVERY_MODE` | Supabase **Edge Function secrets** | **No. Never put these in Vercel or in a `VITE_` variable** |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Injected into Edge Functions by Supabase automatically | **No** |
| Project URL and cron secret for the scheduler | Supabase **Vault** (§9) | **No** |

Vercel only needs the public build values. No secret of any kind belongs in Vercel for this project.

Templates: [`.env.example`](.env.example) (frontend) and [`supabase/functions/.env.example`](supabase/functions/.env.example) (functions). Every `.env*` file except the examples is git-ignored. The apps reject the placeholder values, so a half-configured deployment fails visibly instead of silently.

Safety checks built into the code:
- The browser refuses to start live mode with a service-role or `sb_secret_` key.
- Production builds never fall back to the demo backend or to browser-only storage (`VITE_ENABLE_MOCK_BACKEND` is ignored by builds, and the demo module is compiled out). A missing or invalid configuration shows "Online enquiries are temporarily unavailable" with the phone and email instead.
- Builds reject Turnstile test site keys.
- `submit-enquiry` returns 503 if Turnstile, CORS origins or the owner email are not configured.
- `process-notifications` returns 503 without claiming jobs if Resend is not configured.

---

## 2. Tools

```powershell
node --version        # 24.x (see .node-version and package.json "engines")
npm --version         # comes with Node (npm 11)
npx -y supabase@2 --version   # Supabase CLI, run through npx
```

The Vercel CLI is optional; the Git integration in §11 is enough.

---

## 3. Deployment order

1. Pre-flight checks (§4)
2. Database migrations (§5)
3. Supabase Auth settings and email (§6)
4. Edge Function secrets, then deploy the functions (§7)
5. First administrator (§8)
6. Notification scheduler (§9)
7. Turnstile widget (§10)
8. Frontend on Vercel (§11)
9. Domain cutover from Cloudflare, if the site was already live there (§12)
10. Post-deploy verification (§13)

Do steps 2–4 together in a quiet period. The old dashboard and functions are not compatible with the new database permissions, so the window between them should be short.

---

## 4. Pre-flight checks (local)

```powershell
npm ci
npm run check            # typecheck + unit tests (incl. vercel.json routing) + production build
npm run test:db          # migrations + RLS/privilege tests in a throwaway Docker Postgres
npm run check:functions  # Deno type-check of the Edge Functions
```

### Migration history (check before the first `db push`)

The two original migrations were renamed to unique versions (`20261005000001_…`, `20261005000002_…`). Check what the hosted project has already recorded:

```powershell
npx supabase link --project-ref <project-ref>
npx supabase migration list
```

- **Nothing applied yet:** continue to §5.
- **Already applied by hand in the SQL editor:** mark them as applied without re-running them:
  `npx supabase migration repair --status applied 20261005000001 20261005000002`.

---

## 5. Database migrations

```powershell
npx supabase db push --dry-run   # review what will run
npx supabase db push
```

`20261020000003_security_hardening.sql` is forward-only and keeps existing rows. Watch its output:

- **`enquiries_has_contact_method left NOT VALID`** means legacy enquiries have neither email nor phone. New rows are still checked. Review those rows, then run `alter table public.enquiries validate constraint enquiries_has_contact_method;`.
- **`admin_users …` notices** show how each legacy administrator was migrated (see §8).

---

## 6. Supabase Auth settings (Dashboard)

`<your-domain>` below is the site's **primary production domain on Vercel**, for example `mozartmusic.org` (§11, Domains). Use exactly one primary domain and redirect the other variant (`www` or apex) to it, so there is only one origin to allow.

**Authentication → URL Configuration** (production Supabase project)
- Site URL: `https://<your-domain>`
- Redirect URLs, exact entries only:
  - `https://<your-domain>/admin/auth/callback`
- Do **not** add `*.vercel.app` wildcards or `**` patterns to the production project.
- Add `http://localhost:8443/admin/auth/callback` only on a development project.
- If preview builds use their own Supabase project (§11, Preview), that project gets its own exact entry instead, e.g. `https://preview.<your-domain>/admin/auth/callback`.

How the links are built: *Forgot?* sends `<current origin>/admin/auth/callback`; invitations and resends from the dashboard (the `manage-staff` function) use the caller's origin if it is in `ALLOWED_ORIGINS`, otherwise `SITE_URL`. Every origin people use must therefore be listed both here and in `ALLOWED_ORIGINS` (§7). Supabase only redirects to listed URLs.

**Authentication → Sign In / Providers**
- Allow new users to sign up: **off** (staff join by invitation only; invitations still work)
- Email provider: on. Confirm email: **on**
- Minimum password length: **10** (the dashboard also enforces 10)
- Secure password change: **on**

**Authentication → Emails → SMTP Settings**: custom SMTP is required. Supabase's built-in sender is heavily rate-limited and only delivers to your own team's addresses, so staff invitations would not arrive. With Resend:
- Host `smtp.resend.com`, port `465`, username `resend`, password = a Resend API key
- Sender email on your Resend-verified domain (e.g. `no-reply@<your-domain>`)

**Authentication → Emails → Templates** (recommended): paste
[`supabase/templates/invite.html`](supabase/templates/invite.html) into *Invite user* and
[`supabase/templates/recovery.html`](supabase/templates/recovery.html) into *Reset password*.
These links send people to the dashboard, which verifies the token, so email scanners can't use up the link first. The default templates also work: the dashboard handles both link styles.

**Authentication → Emails / Providers → Email OTP expiration**: invitation and reset links expire after this time. 24 hours (86400 s) is a reasonable value. The app also expires unaccepted invitations after 7 days; admins can **Resend Invite** at any time.

---

## 7. Edge Function secrets and deployment

Create `supabase/functions/.env.production` from `supabase/functions/.env.example` (git-ignored), fill in the real values, then:

```powershell
npx supabase secrets set --env-file supabase/functions/.env.production
npx supabase secrets list

npx supabase functions deploy submit-enquiry --no-verify-jwt
npx supabase functions deploy process-notifications --no-verify-jwt
npx supabase functions deploy manage-staff --no-verify-jwt
```

Origin settings for Vercel (production project):

| Secret | Value |
|---|---|
| `ALLOWED_ORIGINS` | `https://<your-domain>` (exact, comma-separated if more than one, no `*`, no `*.vercel.app`) |
| `SITE_URL` | `https://<your-domain>` (same as the Supabase Auth Site URL) |
| `TURNSTILE_ALLOWED_HOSTNAMES` | leave unset: it defaults to the hostnames in `ALLOWED_ORIGINS` |

The functions ignore a `*` entry and compare origins exactly, so a browser on any other origin (including Vercel preview URLs) cannot submit enquiries or manage staff. That is intended.

Why `--no-verify-jwt` (matches `supabase/config.toml`):
- `submit-enquiry` is public. Visitors are not signed in. It is protected by Turnstile, atomic rate limits, an explicit CORS allow-list and server-side validation.
- `process-notifications` is authorised by the `x-cron-secret` header. A gateway JWT check would accept any visitor's anon token, so it is not real authorisation.
- `manage-staff` verifies the caller's JWT with Supabase Auth inside the function and requires an **active admin** row. With gateway verification on, CORS preflight requests would be rejected.

### Resend sender domain
1. Resend → Domains → add `<your-domain>` and create the DNS records it lists (SPF, DKIM, and optionally DMARC) at your DNS host.
2. Wait for **Verified**, then create an API key with *Sending access* for that domain.
3. Use it for `RESEND_API_KEY` and set `FROM_EMAIL` to an address on that domain, e.g. `Mozart School <enquiries@<your-domain>>`.

Moving the website to Vercel does not change these records. If you move DNS hosting, copy the Resend records (and any MX records) to the new DNS host.

### Client IP for rate limiting
The browser calls the Edge Functions directly (not through Vercel), so this setting does not change with hosting. The function uses the `X-Forwarded-For` entry appended by the trusted proxy (`CLIENT_IP_TRUSTED_PROXY_HOPS`, default `1` = right-most). It deliberately ignores `cf-connecting-ip` and `x-real-ip`, because callers can set those themselves. To confirm the right value for your project after deploying:
1. `npx supabase secrets set DEBUG_CLIENT_IP=true`
2. Submit one enquiry from your own network, then send a request with a forged header:
   `curl -X POST https://<ref>.supabase.co/functions/v1/submit-enquiry -H "Origin: https://<your-domain>" -H "X-Forwarded-For: 1.2.3.4" -H "Content-Type: application/json" -d "{}"`
3. In Edge Functions → submit-enquiry → Logs, read the `x-forwarded-for=… selected=…` lines. `selected` must be **your real IP**, not `1.2.3.4` and not a Supabase proxy address. If it shows a proxy address, increase the hop count by one.
4. `npx supabase secrets unset DEBUG_CLIENT_IP`

Turnstile is the main bot defence. A per-contact limit (5 per hour per email/phone) also applies, whatever the IP.

---

## 8. First administrator

Choose one of these:

**A. New project:** Dashboard → Authentication → Users → *Add user* → *Create new user* with the owner's email, a strong password, and *Auto Confirm User* ticked. Then in the SQL editor:
```sql
select public.bootstrap_first_admin('owner@<your-domain>', 'Srinivas Chetty');
```
It refuses to run if an active administrator already exists, and only the database owner (the SQL editor) can call it. Further staff are invited from the dashboard.

**B. Existing project with `admin_users` rows:** the hardening migration already converted each legacy administrator into an active admin `staff_members` row, unless `staff_members` explicitly revoked them (revocation wins). `admin_users` no longer grants any access. Check the result:
```sql
select email, role, invitation_status, user_id is not null as linked from public.staff_members order by role, email;
```

Invitations created by the old dashboard were database rows only; no email was ever sent. They now show as expired. Use **Resend Invite** to send real invitations.

---

## 9. Notification scheduler (Supabase pg_cron)

Notifications are processed by Supabase itself: pg_cron calls the `process-notifications` Edge Function every minute with the `x-cron-secret` header. This does not depend on the website host, so **moving to Vercel changes nothing here. Do not add a Vercel Cron job**, as it would create a second schedule.

1. Database → Extensions: enable **pg_cron** and **pg_net**.
2. Open [`supabase/sql/schedule_process_notifications.sql`](supabase/sql/schedule_process_notifications.sql). Replace `YOUR-PROJECT-REF` and the secret placeholder (the same value as `NOTIFICATIONS_CRON_SECRET`), then run it in the SQL editor. The values are stored encrypted in Vault, and the file in git keeps its placeholders. Re-running it replaces the job of the same name; it never adds a second one.
3. The job calls `process-notifications` every minute. Each run claims up to 10 jobs with a 5-minute lease. Failures retry after 2, 4, 8 and 16 minutes, and after 5 attempts a job is marked `failed`. Administrators can then use **Retry Send**.

Check it:
```sql
select jobname, schedule, active from cron.job;   -- exactly one 'process-notifications' row
select status, return_message, start_time from cron.job_run_details order by start_time desc limit 5;
select status_code, content from net._http_response order by created desc limit 5;   -- expect 200
select status, count(*) from public.notification_jobs group by status;
```
A `503` with `Email delivery is not configured` means a Resend secret is missing. Jobs stay queued and are not marked as sent.

---

## 10. Turnstile

Turnstile stays on Cloudflare; only its hostname list depends on where the site is served.

Cloudflare dashboard → Turnstile → your widget (or *Add widget*):
- Hostnames: `<your-domain>` (and the other `www`/apex variant only if people can actually load the site on it). If the site previously ran on a `*.workers.dev` address, remove that hostname.
- Do not add `vercel.app`. Add one explicit preview hostname (e.g. `preview.<your-domain>`) only if you set up the preview environment in §11, ideally on a separate widget used by the staging build.
- Mode: *Managed*
- Site key → `VITE_TURNSTILE_SITE_KEY` (Vercel environment variable). Secret key → `TURNSTILE_SECRET_KEY` (Supabase secret).

The server checks `success`, the action (`enquiry`) and the hostname. Allowed hostnames come from `ALLOWED_ORIGINS`, or from `TURNSTILE_ALLOWED_HOSTNAMES` if set, so a token issued on any other hostname is refused.

For local development use Cloudflare's test keys (`1x00000000000000000000AA` / `1x0000000000000000000000000000000AA`). Builds reject the test site key, and the functions reject the test secret unless Supabase is local.

---

## 11. Frontend on Vercel

### Import the repository
Vercel dashboard (Pro team) → **Add New… → Project** → import the GitHub repository `Mozarts-Music-School`.

| Setting | Value |
|---|---|
| Framework Preset | **Vite** |
| Root Directory | `./` (repository root) |
| Install Command | `npm ci` |
| Build Command | `npm run build` |
| Output Directory | `dist` |
| Node.js Version | 24.x (taken from `"engines": { "node": "24.x" }` in `package.json`) |
| Production Branch | `main` (Settings → Environments → Production) |

The first four are also set in [`vercel.json`](vercel.json), which takes precedence over the dashboard, so the build is the same whoever imports it. npm is used because of `package-lock.json`.

Add the environment variables **before the first deployment** (or redeploy afterwards: Vite bakes them into the build).

### Environment variables

Settings → Environment Variables. Set each value for the environment shown. None of these are secrets, but keep "Sensitive" off only for these public values.

| Name | Production | Preview |
|---|---|---|
| `VITE_SUPABASE_URL` | `https://<prod-ref>.supabase.co` | staging project URL, or leave unset |
| `VITE_SUPABASE_ANON_KEY` | production anon / publishable key | staging key, or leave unset |
| `VITE_TURNSTILE_SITE_KEY` | production widget site key | staging widget site key, or leave unset |
| `SITE_INDEXING` | `true` | do not set |
| `SITE_URL` | `https://<your-domain>` | do not set |

Never add `VITE_ENABLE_MOCK_BACKEND` on Vercel (builds ignore it and list it as a configuration error). Never add any Supabase service-role key, Resend key, Turnstile secret or cron secret to Vercel.

### Preview deployments
Every push to a branch other than `main` creates a Preview deployment. Choose one of these for Preview:

- **A. Leave the Preview `VITE_*` variables unset (simplest, safe default).** Preview builds run in "unavailable" mode: the public pages work, the enquiry form shows the phone/email fallback, and the staff dashboard is disabled. Nothing touches production data.
- **B. A stable testing address backed by a separate Supabase staging project.**
  1. Create a long-lived branch, e.g. `preview`.
  2. Settings → Domains → add `preview.<your-domain>` and assign it to the `preview` Git branch.
  3. Set the Preview environment variables to the **staging** Supabase project and a staging Turnstile widget whose only hostname is `preview.<your-domain>`.
  4. On the staging project: Site URL and the single redirect URL `https://preview.<your-domain>/admin/auth/callback`; `ALLOWED_ORIGINS=https://preview.<your-domain>`; `SITE_URL=https://preview.<your-domain>`; `EMAIL_DELIVERY_MODE` cannot be `log` on a hosted project, so use a test Resend key/domain or leave Resend unset (jobs then stay queued and nothing is sent).

Do not point Preview builds at the production Supabase project, and do not widen production `ALLOWED_ORIGINS`, Auth redirect URLs or Turnstile hostnames to `*.vercel.app`.

Deployment Protection: keep **Standard Protection** (Settings → Deployment Protection). It requires a Vercel login for preview URLs, including `preview.<your-domain>`, while the production domain stays public. Vercel also sends `X-Robots-Tag: noindex` on preview deployments, and our build adds `noindex` for any non-production build.

### Domains
Settings → Domains → add `<your-domain>` and `www.<your-domain>`. Make one the primary production domain and set the other to **redirect** to it (308). The DNS records to create are shown on that page. Use the primary domain everywhere in §6, §7 and §10.

### Routing and caching (`vercel.json`)
- Real files (`/assets/*`, `/robots.txt`, `/index.html`) are always served first.
- Every other path, including `/admin`, `/admin/auth/callback` and unknown paths, is rewritten (not redirected) to `/index.html`, so direct visits and refreshes work. The address bar, query string (`?token_hash=…&type=…`) and hash (`#access_token=…`, `#admin`, `#home`) are left unchanged for the app to read.
- `/assets/*` is excluded from the rewrite, so an outdated hashed file returns 404 instead of HTML. Hashed assets are cached for a year (`immutable`); `index.html` is revalidated on every visit, so new deployments show up immediately.
- No redirects are configured, so there is nothing that can loop. The domain redirect (apex ↔ www) is configured in the dashboard, not here.
- Security headers on every response: `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: DENY`.
- `tests/vercelConfig.test.ts` (part of `npm run check`) checks these rules.

### Search indexing
Indexing is only enabled when `SITE_INDEXING=true` **and** Vercel's `VERCEL_ENV` is `production`. Preview builds always get `noindex, nofollow` and a robots.txt that disallows crawling. The build log prints `[site] search indexing ENABLED/disabled (reason)`. This needs Vercel's system environment variables, which are exposed by default (Settings → Environment Variables → *Automatically expose System Environment Variables*).

### Optional: deploy from the CLI
The Git integration is the intended path. For a one-off manual deploy, `npx vercel@latest link` then `npx vercel@latest --prod`. It uses the same `vercel.json` and the environment variables stored in Vercel.

---

## 12. Moving the live site from Cloudflare to Vercel

Skip this for a first launch.

1. Complete §11 and wait for a successful Production deployment. Open the `<project>.vercel.app` production URL and check the public pages and `/admin` load. (Enquiries and staff sign-in will be refused there until the domain moves, because that origin is deliberately not allowed.)
2. **Same domain as before:** no change is needed to Supabase Site URL, redirect URLs, `ALLOWED_ORIGINS`, `SITE_URL` or Turnstile hostnames. **New domain** (for example, the old site was on `*.workers.dev`): update §6, §7 and §10 to the new domain at the same time as the DNS change, and remove the old origin and hostname.
3. In Cloudflare, remove the custom domain / route from the Worker first, so the two hosts don't both claim it. Then create the DNS records Vercel shows (§11 Domains). If DNS stays on Cloudflare, set those records to **DNS only** (grey cloud), as Vercel recommends; keep the existing Resend/MX records untouched.
4. Wait for Vercel to show the domain as valid with a certificate, then run §13.
5. When everything passes, delete the Cloudflare Worker and disconnect its Workers Builds Git integration, so pushes no longer build there. Keep the Cloudflare account: it still owns the Turnstile widget (and possibly DNS).

---

## 13. Post-deploy verification

Routing (replace `<your-domain>`):
```powershell
curl -sI https://<your-domain>/admin                       # 200, content-type text/html
curl -sI "https://<your-domain>/admin/auth/callback?token_hash=x&type=recovery"   # 200, no Location header
curl -s  https://<your-domain>/robots.txt                  # text/plain: Allow: / and Disallow: /admin
curl -sI https://<your-domain>/assets/does-not-exist.js    # 404 (not HTML)
```
Then in a browser: open `https://<your-domain>/admin` directly, refresh it, and open `https://<your-domain>/#admin`; all three show the staff sign-in. View the page source: no `noindex` meta tag, and the canonical link is present.

Application:
1. Submit an enquiry. Expected: success message, an enquiry row, and two `notification_jobs` rows that change to `sent` within about a minute. You should get the owner alert and the acknowledgement.
2. Sign in at `/admin` as the administrator. Invite a test staff member, accept the invitation in a private window (the link must open `https://<your-domain>/admin/auth/callback…`), set a password, and confirm they can change status and add notes but cannot delete or retry.
3. Revoke the test staff member and confirm their open dashboard loses access on the next action or when the window regains focus.
4. Use *Forgot?* on the sign-in screen and complete a password reset.
5. Confirm direct API calls are refused, using the anon key from the browser bundle:
   ```powershell
   curl -X POST https://<ref>.supabase.co/rest/v1/rpc/claim_notification_jobs -H "apikey: <anon>" -H "Authorization: Bearer <anon>" -H "Content-Type: application/json" -d "{}"
   # expect 401/403 "permission denied for function claim_notification_jobs"
   curl "https://<ref>.supabase.co/rest/v1/enquiries?select=*" -H "apikey: <anon>" -H "Authorization: Bearer <anon>"
   # expect 401/403 permission denied
   curl -X POST https://<ref>.supabase.co/functions/v1/process-notifications
   # expect 401
   curl -X POST https://<ref>.supabase.co/functions/v1/submit-enquiry -H "Origin: https://evil.example" -H "Content-Type: application/json" -d "{}"
   # expect 403 (origin not allowed)
   ```

---

## 14. Checklist of external dashboard changes

These are not done by anything in this repository:

- [ ] **Vercel:** Pro team; import the repo (§11); Production environment variables; Preview choice A or B; domains with one primary and a redirect; Standard Deployment Protection.
- [ ] **DNS host:** records shown by Vercel; Resend/MX records preserved (§12).
- [ ] **Supabase Auth → URL Configuration:** Site URL and the exact `/admin/auth/callback` redirect URL for the primary domain (§6).
- [ ] **Supabase Edge Function secrets:** `ALLOWED_ORIGINS` and `SITE_URL` set to the primary domain (§7).
- [ ] **Cloudflare Turnstile:** widget hostnames = primary domain; old `*.workers.dev` hostname removed (§10).
- [ ] **Cloudflare Workers:** remove the domain from the Worker, then delete the Worker and its Git build after verification (§12).
- [ ] **Supabase pg_cron:** unchanged; confirm exactly one `process-notifications` job (§9).
- [ ] **Staging (only for Preview option B):** separate Supabase project, Turnstile widget and `preview.<your-domain>` branch domain.

---

## 15. Local development

```powershell
npm run dev:mock   # demo data in browser storage, DEMO MODE banner, demo sign-in buttons
npm run dev        # live mode: needs .env.local with real (or local Supabase) values
npm run build; npm run preview   # serve the production build at http://localhost:8443
```

Without configuration, `npm run dev` shows the site with online enquiries disabled. The staff page then lists the missing variables. Demo mode cannot be enabled in a build.

Full local stack (Docker, downloads several GB of images):
```powershell
npx supabase start                 # applies migrations, uses supabase/config.toml auth settings + templates
npx supabase functions serve --env-file supabase/functions/.env.local
#   in .env.local: EMAIL_DELIVERY_MODE=log, Turnstile test secret,
#   ALLOWED_ORIGINS=http://localhost:8443, SITE_URL=http://localhost:8443
```
Local Auth emails appear in Mailpit at http://localhost:54324. Then create `.env.local` with `VITE_SUPABASE_URL=http://127.0.0.1:54321`, the local anon key printed by `supabase start`, and `VITE_TURNSTILE_SITE_KEY=1x00000000000000000000AA`.
