// Browser configuration. Only public values belong here (VITE_ variables are
// embedded in the built JavaScript). Mock mode exists for local development and
// is never available in a build.

export type BackendMode = "live" | "mock" | "misconfigured"

export interface AppConfig {
  mode: BackendMode
  supabaseUrl: string
  supabaseAnonKey: string
  turnstileSiteKey: string
  // Variable names with problems; never their values.
  errors: string[]
}

export interface RawEnv {
  DEV?: boolean
  MODE?: string
  VITE_SUPABASE_URL?: string
  VITE_SUPABASE_ANON_KEY?: string
  VITE_TURNSTILE_SITE_KEY?: string
  VITE_ENABLE_MOCK_BACKEND?: string
}

const PLACEHOLDER_PATTERNS = [
  /your[-_]?(project|anon|key|turnstile|site)/i,
  /placeholder/i,
  /changeme/i,
  /\.\.\./,
  /^<.*>$/,
  /example\.(com|org|net)/i,
]

// Cloudflare test site keys always pass or always fail; useless in production.
const TURNSTILE_TEST_SITE_KEY = /^[123]x0{20}A{2}$/

export function isPlaceholder(value: string): boolean {
  return PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(value))
}

function decodeJwtRole(token: string): string | null {
  const parts = token.split(".")
  if (parts.length !== 3) return null
  try {
    const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")))
    return typeof payload.role === "string" ? payload.role : null
  } catch {
    return null
  }
}

export function resolveAppConfig(env: RawEnv): AppConfig {
  const dev = env.DEV === true
  const supabaseUrl = (env.VITE_SUPABASE_URL ?? "").trim()
  const supabaseAnonKey = (env.VITE_SUPABASE_ANON_KEY ?? "").trim()
  const turnstileSiteKey = (env.VITE_TURNSTILE_SITE_KEY ?? "").trim()
  const errors: string[] = []

  const mockRequested = env.VITE_ENABLE_MOCK_BACKEND === "true" || env.MODE === "mock"
  if (mockRequested && dev) {
    return { mode: "mock", supabaseUrl: "", supabaseAnonKey: "", turnstileSiteKey, errors }
  }
  if (mockRequested) {
    errors.push("VITE_ENABLE_MOCK_BACKEND (only honoured by the local dev server; remove it from build settings)")
  }

  if (!supabaseUrl || isPlaceholder(supabaseUrl)) {
    errors.push("VITE_SUPABASE_URL")
  } else {
    try {
      const url = new URL(supabaseUrl)
      const local = url.hostname === "localhost" || url.hostname === "127.0.0.1"
      if (url.protocol !== "https:" && !(dev && local && url.protocol === "http:")) {
        errors.push("VITE_SUPABASE_URL (must use https)")
      }
    } catch {
      errors.push("VITE_SUPABASE_URL (not a valid URL)")
    }
  }

  if (!supabaseAnonKey || isPlaceholder(supabaseAnonKey)) {
    errors.push("VITE_SUPABASE_ANON_KEY")
  } else if (supabaseAnonKey.startsWith("sb_secret_") || decodeJwtRole(supabaseAnonKey) === "service_role") {
    // A secret key in the browser bypasses every RLS policy. Refuse to start.
    errors.push("VITE_SUPABASE_ANON_KEY (this is a secret/service-role key; use the anon or publishable key)")
  } else if (!supabaseAnonKey.startsWith("sb_publishable_") && decodeJwtRole(supabaseAnonKey) !== "anon") {
    errors.push("VITE_SUPABASE_ANON_KEY (not a Supabase anon or publishable key)")
  }

  if (!turnstileSiteKey || isPlaceholder(turnstileSiteKey) || !/^[0-9]x[0-9A-Za-z_-]{20,}$/.test(turnstileSiteKey)) {
    errors.push("VITE_TURNSTILE_SITE_KEY")
  } else if (!dev && TURNSTILE_TEST_SITE_KEY.test(turnstileSiteKey)) {
    errors.push("VITE_TURNSTILE_SITE_KEY (Cloudflare test key in a production build)")
  }

  return {
    mode: errors.length > 0 ? "misconfigured" : "live",
    supabaseUrl,
    supabaseAnonKey,
    turnstileSiteKey,
    errors,
  }
}

export const appConfig: AppConfig = resolveAppConfig(import.meta.env as RawEnv)

if (appConfig.mode === "misconfigured") {
  console.error(
    "Mozart School: online enquiries and the staff dashboard are disabled until these build variables are fixed:",
    appConfig.errors.join(", "),
  )
}

export const CONTACT_FALLBACK = "Please call 9043877104 or email srinivaschetty@gmail.com."
