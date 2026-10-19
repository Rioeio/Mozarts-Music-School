# Progress

## 2026-10-19 — Hosting moved from Cloudflare Workers to Vercel (local work only)

### Done
- `vercel.json`: Vite preset, `npm ci`, `npm run build`, output `dist`; SPA rewrite for every path except `/assets/` (missing hashed files 404 instead of returning HTML); no redirects; `/assets/*` cached immutable; `nosniff`, `Referrer-Policy`, `X-Frame-Options: DENY`.
- Removed `wrangler.json` and the `cf:dry-run` script. `.vercel/` git-ignored.
- Node pinned to 24.x (`engines` + `.node-version`; Vercel reads `engines`). npm via `package-lock.json`.
- Search indexing now keys off Vercel's `VERCEL_ENV` (only `production` can be indexable); `SITE_PRODUCTION_BRANCH` removed.
- `.env.example`, `supabase/functions/.env.example`, `AGENTS.md`, `DEPLOYMENT.md` rewritten for Vercel (Pro plan required for commercial use; Production/Preview variables; exact Supabase redirect URLs, CORS origins and Turnstile hostnames; cutover from Cloudflare; external checklist in §14).
- Unchanged on purpose: Supabase Edge Functions, Turnstile, and the pg_cron notification scheduler (no Vercel Cron).

### Checks run
`npm run check` (typecheck, 93 tests incl. new `tests/vercelConfig.test.ts`, build). Built `dist` contains only `index.html`, `robots.txt`, `assets/` (no Cloudflare files). Production-like and preview builds served by a local Vercel-routing stand-in and checked with curl + headless Chrome: `/admin` direct + refresh, `/admin/`, `/#admin`, `?token_hash` callback, `#error=otp_expired` callback, missing asset 404, headers, robots/canonical/noindex, demo mode refused in builds.

### Not verified
- A real Vercel build/deploy (not deployed; no account changes) and real Supabase invite/recovery emails.

### Next steps
- Follow DEPLOYMENT.md §11–14 (Vercel Pro project, env vars, domain, Supabase URL config, Turnstile hostnames, then retire the Cloudflare Worker).

## 2026-10-19 — Frontend UI fixes (admin/auth, instrument cards, enquiry modal)

### Done
- **CSS cascade fix (`src/index.css`):** element rules (`h1`–`h3`, `p`, `a`, `img`) moved into Tailwind's `@layer base`; the big display sizes now apply only inside `<main>` (public page). Before, unlayered `h1`/`h2` rules beat every Tailwind class, so the login "Staff Administration" was 84px and modal titles 61px. `@theme` maps `font-serif`/`font-sans` to Playfair Display / DM Sans.
- **Admin/auth:** login heading now 26–32px, one line at every width; small uppercase dashboard headings use the sans font; dashboard tabs no longer wrap on phones.
- **Instrument cards:** titles 32–42px (desktop), 28–34px (tablet), 34–40px (phone), same on all three cards; "Discover …" links use the underlined link style and never wrap. Photos are grayscale by default and show colour on hover or keyboard focus (`:focus-within`); no zoom when reduced motion is on.
- **Enquiry modal (`EnquiryModal.tsx`):** one fixed-size shell (720px wide, screen height minus a 32px gap top and bottom; 12px on phones and short screens); header + tabs + close button fixed, fields scroll, Cancel/Submit always visible. Added focus trap, focus return on close and page scroll lock. Name label on non-lesson tabs fixed ("Your Name"). Demo-mode banner now sits under modals (it covered the buttons on phones).

### Checks run
`npm run check` (typecheck, 89 tests, build). Headless Chrome at 8 viewport sizes (1440×900, 1024×768, 820×1180, 760×1024, 375×812, 320×640, 1280×600, 740×360): identical modal size across tabs, no overflow, hover/focus colour, Escape/focus/scroll lock, error and demo-mode success states, admin dashboard. Public page headings unchanged.

### Known issues / next steps
- Privacy notice dialog still uses the older modal pattern (no focus trap / scroll lock).
- Loading state ("Sending...") was too fast to see in demo mode; its code is unchanged.

## 2026-10-19 — Switched from pnpm to npm

### Done
- Deleted `pnpm-lock.yaml`; new `package-lock.json` keeps the same package versions as before, except Vite.
- Vite 8.0.5 → 8.3.4 (`npm audit fix`, within the existing `^8.0.5` range) to fix a high-severity dev-server issue on Windows.
- `packageManager` is now `npm@11.9.0`; `check` and `cf:dry-run` scripts use `npm run`. All docs, comments and `.env.example` use npm commands.

### Checks run
`npm ci` from clean, `npm audit` (0 vulnerabilities), `npm run check` (typecheck, 89 tests, build).

### Next steps
- Cloudflare dashboard: if the build command says `pnpm`, change it to `npm run build`.
- Then the Supabase migration (needs `npx supabase login` + `link` by the user).

## 2026-10-19 — Cleanup: Cloudflare + Supabase only

### Done
- Renamed migrations to unique versions: `20261005000001_enquiries_schema.sql`, `20261005000002_staff_and_class_preference.sql`.
- Removed Vercel (`vercel.json`) and Figma Make (`.figma/`, `.mise.toml`, Figma Vite plugins, `figma:` slots in `index.html`, Figma `.gitignore` entries). Package renamed to `mozarts-music-school`.
- `vite.config.ts` now only has React, Tailwind and a small `search-indexing` plugin (robots.txt + robots/canonical tags). Social share tags moved into `index.html`. Dev server no longer listens on the local network (localhost:8443 only).
- `AGENTS.md` and `DEPLOYMENT.md` updated to match.

### Checks run
`tsc`, `vitest` (89 passing), production build (robots.txt + noindex tag verified). `pnpm test:db` not run: Docker Desktop was not running.

### Kept on purpose
- Resend (email sending, used by the Supabase Edge Functions) and Google Fonts / Unsplash images on the site.

### Next steps
- Link the hosted Supabase project and push the migrations (DEPLOYMENT.md §4–5), then secrets, functions, cron, Cloudflare (§6–11).

## 2026-10-20 — Production hardening (Cloudflare + Supabase)

### Done
- **Config safety:** no automatic mock fallback. Demo mode only on the dev server (`pnpm dev:mock` or `VITE_ENABLE_MOCK_BACKEND=true`), with a visible banner. The demo module is compiled out of builds. Placeholder, `http`, service-role and Turnstile test keys are rejected (`src/lib/config.ts`). A misconfigured build shows "enquiries unavailable" and never claims an enquiry was received.
- **Database:** `supabase/migrations/20261020000003_security_hardening.sql` (forward-only). Removes the obsolete `submit_enquiry_atomic` overload; privileged functions are service-role-only with `search_path=''`; fixes the contact-method constraint; adds atomic `check_rate_limit`, lease-checked `finish_notification_job` and admin-only `retry_notification_job`; retires the `admin_users` fallback (rows migrated); limits staff writes to the status column and notes; note author comes from the session; adds `activate_staff_membership` and `bootstrap_first_admin`.
- **Edge Functions:** logic in `supabase/functions/_shared/*` (testable under Node). `submit-enquiry`: Turnstile verify with action and hostname checks, fail-closed config, explicit CORS, trusted XFF hop, per-IP and per-contact limits. `process-notifications`: `x-cron-secret` auth, refuses to run without Resend, escaped HTML, lease-safe completion. New `manage-staff`: invite/resend/revoke/reactivate via the Auth Admin API, with rollback when an email fails.
- **Frontend:** Turnstile widget (`TurnstileWidget.tsx`) with load, expiry, error, retry and reset handling; a stable idempotency key per form; dashboard rebuilt on `src/lib/adminBackend.ts`: membership checked through the database on sign-in, refresh, focus and permission errors; invite, recovery and set-password flows via `/admin/auth/callback`; admin-only UI for delete, retry and notifications. Design unchanged.
- **Deployment:** search indexing set per build (`SITE_INDEXING` + production branch); robots.txt always emitted; `packageManager`, `engines`, `.node-version`; scripts `check`, `test:db`, `check:functions`, `cf:dry-run`; `DEPLOYMENT.md`, `docs/PERMISSIONS.md`, email templates, cron SQL.

### Checks run (all passing)
`tsc` · `vitest` (89 tests) · `pnpm test:db` (160 SQL assertions + 3 concurrency checks, Postgres 17) · `deno check` on the 3 functions · production build (bundle inspected: no demo data or secret names) · clean-copy `pnpm install --frozen-lockfile` + build · `wrangler deploy --dry-run` · `wrangler dev` SPA routing for `/admin`, `/admin/auth/callback`, `/robots.txt`.

### Not run
- Browser UI walkthrough (Chrome extension not connected).
- Full `supabase start` stack and real Auth emails, Turnstile and Resend (no credentials; mocked in tests).

### Decisions
- Staff: view enquiries, change status, add notes. Admin additionally: delete, retry notifications, manage staff, view delivery status.
- Edge Functions deploy with `--no-verify-jwt`; each one does its own authorisation (see DEPLOYMENT.md §7).
- Invitations expire after 7 days in the app; an existing account gets a password-reset email instead of an invite.
- Supabase client uses the implicit flow (required for admin-sent invites); token-hash email templates recommended.

### Known issues / next steps
- `CLIENT_IP_TRUSTED_PROXY_HOPS` must be confirmed on the hosted project (DEPLOYMENT.md §7).
- Then follow DEPLOYMENT.md §3 in order.
