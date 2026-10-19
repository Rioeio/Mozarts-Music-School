/// <reference types="vite/client" />

// Public build-time variables (embedded in the browser bundle). Secrets never go here.
interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string
  readonly VITE_SUPABASE_ANON_KEY?: string
  readonly VITE_TURNSTILE_SITE_KEY?: string
  // Local dev server only; ignored by builds.
  readonly VITE_ENABLE_MOCK_BACKEND?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
