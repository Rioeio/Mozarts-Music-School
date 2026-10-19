# mozarts-music-school

Website for Mozart School Of Western Classical Music: React + Vite + Tailwind CSS frontend hosted on Vercel (static single-page app), with Supabase (Postgres, Auth, Edge Functions) as the backend. Deployment steps are in `DEPLOYMENT.md`; current status is in `PROGRESS.md`.

## Development Server

Start it with `npm run dev` (needs real Supabase values in `.env`) or `npm run dev:mock` (demo data stored in the browser, no Supabase needed). It runs on `$PORT` (default 8443).

## Project Structure

Start with task-relevant files below. Only follow imports or inspect other files when required, when a documented path is missing, or when the repository contradicts this guide.

- `src/main.tsx` - React entrypoint; imports `src/index.css` and mounts `src/App.tsx` into the `#root` element
- `src/App.tsx` - Public site, and the switch to the staff dashboard on `/admin`
- `src/components/` - Enquiry form, Turnstile widget, privacy notice, staff dashboard
- `src/lib/` - Config checks, Supabase client, admin data access, validation, demo backend
- `src/index.css` - Global CSS entrypoint and Tailwind CSS v4 import
- `index.html` - Vite HTML shell containing the `#root` element and loading `src/main.tsx`
- `vite.config.ts` - Vite configuration with React, Tailwind CSS v4, the search-indexing plugin and the `@` alias for `src`
- `scripts/` - Build-time search indexing decision and the database test runner
- `supabase/migrations/` - Database schema and security policies
- `supabase/functions/` - Edge Functions (`submit-enquiry`, `process-notifications`, `manage-staff`); shared logic in `_shared/`
- `supabase/sql/` - One-off SQL run by hand per environment (notification schedule)
- `vercel.json` - Vercel build settings, single-page-app rewrites (except `/assets/`) and response headers; checked by `tests/vercelConfig.test.ts`
- `tests/` - Vitest unit tests; `tests/db/` holds SQL tests run by `npm run test:db`

## Dependencies

- Runtime: React 19, React DOM 19, `@supabase/supabase-js`
- Styling: Tailwind CSS v4 with the `@tailwindcss/vite` plugin
- Build tooling: Vite 8, TypeScript 5, and `@vitejs/plugin-react`
- Testing: Vitest; formatting: oxfmt
- Package manager: npm (comes with Node; version pinned in `package.json`); Node version in `.node-version`

## Styling

This project uses **Tailwind CSS v4** through the `@tailwindcss/vite` plugin configured in `vite.config.ts`. `src/index.css` imports Tailwind with `@import 'tailwindcss';`. Use Tailwind utility classes directly in JSX and put global CSS or Tailwind v4 theme customization in `src/index.css`. This project does not need a Tailwind config file or PostCSS config.

`src/main.tsx` imports `src/index.css`, so global font wiring belongs in `src/index.css`. Keep CSS `@import` statements first, then add any `@font-face` rules and font-family defaults there.

## Code quality

- Use double quotes for strings containing apostrophes (`"We're here to help"`), or escape them in single-quoted strings. An unescaped apostrophe in a single-quoted string breaks the build.
- Ensure JSX tags are closed and braces are balanced.
- Export components as default exports.
- Before calling a change done, run `npm run check` (typecheck, tests, build).
