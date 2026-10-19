// Cloudflare Turnstile server-side verification.
// https://developers.cloudflare.com/turnstile/get-started/server-side-validation/

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify"

// Cloudflare's documented test secrets. They never prove a human solved a
// challenge, so production refuses them (see submitEnquiry.ts).
export const TURNSTILE_TEST_SECRETS = new Set([
  "1x0000000000000000000000000000000AA",
  "2x0000000000000000000000000000000AA",
  "3x0000000000000000000000000000000AA",
])

export type TurnstileResult = { ok: true } | { ok: false; reason: string; retryable: boolean }

export interface TurnstileOptions {
  secret: string
  token: string | undefined
  remoteIp: string | null
  expectedAction: string
  allowedHostnames: string[]
  fetchImpl: typeof fetch
  timeoutMs?: number
}

interface SiteverifyResponse {
  success?: boolean
  "error-codes"?: string[]
  action?: string
  hostname?: string
}

export async function verifyTurnstile(options: TurnstileOptions): Promise<TurnstileResult> {
  const token = options.token?.trim()
  if (!token || token.length > 2048) {
    return { ok: false, reason: "missing-input-response", retryable: true }
  }

  const form = new URLSearchParams({ secret: options.secret, response: token })
  if (options.remoteIp) form.set("remoteip", options.remoteIp)

  let outcome: SiteverifyResponse
  try {
    const response = await options.fetchImpl(SITEVERIFY_URL, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    })
    if (!response.ok) return { ok: false, reason: `siteverify-http-${response.status}`, retryable: true }
    outcome = (await response.json()) as SiteverifyResponse
  } catch {
    // Fail closed: an unverifiable token is treated as invalid.
    return { ok: false, reason: "siteverify-unavailable", retryable: true }
  }

  if (!outcome.success) {
    return { ok: false, reason: (outcome["error-codes"] ?? ["unknown"]).join(","), retryable: true }
  }

  // Test secrets return fixed dummy hostname/action values.
  if (TURNSTILE_TEST_SECRETS.has(options.secret)) return { ok: true }

  if (outcome.action !== options.expectedAction) {
    return { ok: false, reason: "action-mismatch", retryable: false }
  }
  if (options.allowedHostnames.length > 0 && !options.allowedHostnames.includes(outcome.hostname ?? "")) {
    return { ok: false, reason: "hostname-mismatch", retryable: false }
  }
  return { ok: true }
}
