// Runtime configuration helpers shared by the Edge Functions. Handlers receive an
// Env so tests can supply values without Deno.

export interface Env {
  get(name: string): string | undefined
}

const PLACEHOLDER_PATTERNS = [
  /your[-_ ]?(project|key|secret|domain|verified|resend|turnstile|anon|service)/i,
  /placeholder/i,
  /changeme/i,
  /replace[-_ ]?me/i,
  /\.\.\./,
  /^<.*>$/,
  /^x{3,}$/i,
  // RFC 2606 reserved domain used in the templates.
  /\.example(\b|$)/i,
]

export function isPlaceholderValue(value: string): boolean {
  return PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(value))
}

// Returns the trimmed value, or null when missing, blank or an obvious placeholder.
export function readSetting(env: Env, name: string): string | null {
  const value = env.get(name)?.trim()
  if (!value || isPlaceholderValue(value)) return null
  return value
}

// Comma-separated list of exact origins. Wildcards are not accepted.
export function parseAllowedOrigins(raw: string | null): string[] {
  if (!raw) return []
  return raw
    .split(",")
    .map((origin) => origin.trim().replace(/\/+$/, ""))
    .filter((origin) => {
      if (!origin || origin === "*") return false
      try {
        const url = new URL(origin)
        return (url.protocol === "https:" || url.protocol === "http:") && url.origin === origin
      } catch {
        return false
      }
    })
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "kong", "host.docker.internal"])

// True for the URLs the Supabase CLI gives Edge Functions locally.
export function isLocalSupabaseUrl(raw: string | null): boolean {
  if (!raw) return false
  try {
    return LOCAL_HOSTS.has(new URL(raw).hostname)
  } catch {
    return false
  }
}

// SITE_URL must be an https origin (http is allowed only for localhost).
export function parseSiteUrl(raw: string | null): string | null {
  if (!raw) return null
  try {
    const url = new URL(raw)
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1"
    if (url.protocol !== "https:" && !(local && url.protocol === "http:")) return null
    return url.origin
  } catch {
    return null
  }
}
