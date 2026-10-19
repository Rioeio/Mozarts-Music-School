import { getClientIp } from "./clientIp.ts"
import { parseEnquiryInput } from "./enquiry.ts"
import { type Env, isLocalSupabaseUrl, parseAllowedOrigins, readSetting } from "./env.ts"
import { buildCors, json, sha256Hex } from "./http.ts"
import { TURNSTILE_TEST_SECRETS, verifyTurnstile } from "./turnstile.ts"

export type RpcResult = { data: unknown; error: { message: string; code?: string } | null }
export type Rpc = (fn: string, args: Record<string, unknown>) => Promise<RpcResult>

export interface SubmitEnquiryDeps {
  env: Env
  // Null when SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are missing.
  rpc: Rpc | null
  fetch: typeof fetch
  log?: Pick<Console, "warn" | "error">
}

// Per-network and per-contact windows. Turnstile is the primary bot defence;
// these bound the damage from solved challenges and shared networks.
export const IP_LIMIT = { max: 10, windowSeconds: 15 * 60 }
export const CONTACT_LIMIT = { max: 5, windowSeconds: 60 * 60 }
export const TURNSTILE_ACTION = "enquiry"

const UNAVAILABLE = "Online enquiries are temporarily unavailable. Please call 9043877104 or email srinivaschetty@gmail.com."

function successMessage(type: string): string {
  return type === "location_interest"
    ? "Thank you for registering your interest. In-person classes are coming soon — A welcoming new space is on the way, and we’ll keep you informed."
    : "Thank you for getting in touch with Mozart School. Online classes are available now, and in-person classes are coming soon. We’ve received your enquiry and will be in touch soon."
}

interface SubmitConfig {
  allowedOrigins: string[]
  allowedHostnames: string[]
  turnstileSecret: string
  ownerEmail: string
  trustedProxyHops: number
}

export function readSubmitConfig(env: Env): { config: SubmitConfig | null; missing: string[] } {
  const missing: string[] = []
  const allowedOrigins = parseAllowedOrigins(readSetting(env, "ALLOWED_ORIGINS"))
  if (allowedOrigins.length === 0) missing.push("ALLOWED_ORIGINS")

  const turnstileSecret = readSetting(env, "TURNSTILE_SECRET_KEY")
  const local = isLocalSupabaseUrl(readSetting(env, "SUPABASE_URL"))
  if (!turnstileSecret) missing.push("TURNSTILE_SECRET_KEY")
  else if (TURNSTILE_TEST_SECRETS.has(turnstileSecret) && !local) missing.push("TURNSTILE_SECRET_KEY (test secret outside local development)")

  const ownerEmail = readSetting(env, "OWNER_EMAIL")
  if (!ownerEmail) missing.push("OWNER_EMAIL")

  const hostnames = readSetting(env, "TURNSTILE_ALLOWED_HOSTNAMES")
  const allowedHostnames = hostnames
    ? hostnames.split(",").map((h) => h.trim().toLowerCase()).filter(Boolean)
    : allowedOrigins.map((origin) => new URL(origin).hostname)

  const hops = Number(readSetting(env, "CLIENT_IP_TRUSTED_PROXY_HOPS") ?? "1")

  if (missing.length > 0 || !turnstileSecret || !ownerEmail) return { config: null, missing }
  return {
    config: { allowedOrigins, allowedHostnames, turnstileSecret, ownerEmail, trustedProxyHops: hops },
    missing,
  }
}

export function createSubmitEnquiryHandler(deps: SubmitEnquiryDeps) {
  const log = deps.log ?? console

  return async function handle(req: Request): Promise<Response> {
    const { config, missing } = readSubmitConfig(deps.env)
    const cors = buildCors(req, config?.allowedOrigins ?? [], "POST, OPTIONS")

    if (req.method === "OPTIONS") {
      return new Response(null, { status: cors.allowed ? 204 : 403, headers: cors.headers })
    }
    if (req.method !== "POST") {
      return json({ ok: false, error: "Method not allowed" }, 405, cors.headers)
    }
    if (!config || !deps.rpc) {
      log.error("submit-enquiry is not configured. Missing or invalid:", [...missing, ...(deps.rpc ? [] : ["SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY"])].join(", "))
      return json({ ok: false, error: UNAVAILABLE }, 503, cors.headers)
    }
    // Browsers always send Origin on cross-origin POSTs; reject unknown sites.
    if (cors.origin !== null && !cors.allowed) {
      return json({ ok: false, error: "Origin not allowed." }, 403, cors.headers)
    }

    let body: unknown
    try {
      body = await req.json()
    } catch {
      return json({ ok: false, error: "Invalid request body." }, 400, cors.headers)
    }

    const parsed = parseEnquiryInput(body)
    if (!parsed.ok) return json({ ok: false, error: parsed.error }, 400, cors.headers)
    if (parsed.honeypot) {
      // Decoy success; nothing is stored.
      log.warn("Spam honeypot triggered")
      return json({ ok: true, message: "Thank you — your enquiry has been received." }, 200, cors.headers)
    }
    const enquiry = parsed.value

    const clientIp = getClientIp(req.headers, config.trustedProxyHops)
    if (readSetting(deps.env, "DEBUG_CLIENT_IP") === "true") {
      // Temporary aid for choosing CLIENT_IP_TRUSTED_PROXY_HOPS (DEPLOYMENT.md). Logs IPs; switch off afterwards.
      log.warn(`x-forwarded-for="${req.headers.get("x-forwarded-for") ?? ""}" selected=${clientIp ?? "none"}`)
    }
    try {
      if (clientIp) {
        const allowed = await rateLimit(deps.rpc, `enquiry_ip:${await sha256Hex(clientIp)}`, IP_LIMIT)
        if (!allowed) {
          return json({ ok: false, error: "Too many enquiries from this network. Please wait a few minutes or call us directly." }, 429, cors.headers)
        }
      } else {
        log.warn("Client IP unavailable; per-network rate limit skipped for this request.")
      }
    } catch (err) {
      log.error("Rate limit check failed:", err)
      return json({ ok: false, error: UNAVAILABLE }, 503, cors.headers)
    }

    const turnstile = await verifyTurnstile({
      secret: config.turnstileSecret,
      token: enquiry.turnstileToken,
      remoteIp: clientIp,
      expectedAction: TURNSTILE_ACTION,
      allowedHostnames: config.allowedHostnames,
      fetchImpl: deps.fetch,
    })
    if (!turnstile.ok) {
      log.warn("Turnstile verification failed:", turnstile.reason)
      return json({ ok: false, code: "turnstile_failed", error: "The spam check could not be verified. Please complete it again and resubmit." }, 400, cors.headers)
    }

    try {
      const contactKey = `enquiry_contact:${await sha256Hex(enquiry.email ?? enquiry.phone ?? "")}`
      if (!(await rateLimit(deps.rpc, contactKey, CONTACT_LIMIT))) {
        return json({ ok: false, error: "We have already received several enquiries from these contact details. We will be in touch soon." }, 429, cors.headers)
      }
    } catch (err) {
      log.error("Rate limit check failed:", err)
      return json({ ok: false, error: UNAVAILABLE }, 503, cors.headers)
    }

    const { error } = await deps.rpc("submit_enquiry_atomic", {
      p_type: enquiry.type,
      p_contact_name: enquiry.contactName,
      p_email: enquiry.email,
      p_phone: enquiry.phone,
      p_preferred_contact: enquiry.preferredContact,
      p_instrument: enquiry.instrument,
      p_learner_group: enquiry.learnerGroup,
      p_learner_name: enquiry.learnerName,
      p_experience: enquiry.experience,
      p_class_preference: enquiry.classPreference,
      p_preferred_times: enquiry.preferredTimes,
      p_message: enquiry.message,
      p_source: enquiry.source,
      p_contact_consent: true,
      p_location_updates: enquiry.locationUpdates,
      p_consent_version: enquiry.consentVersion,
      p_idempotency_key: enquiry.idempotencyKey,
      p_metadata: {
        userAgent: (req.headers.get("user-agent") ?? "unknown").slice(0, 300),
        submittedAt: new Date().toISOString(),
      },
      p_owner_email: config.ownerEmail,
    })

    if (error) {
      log.error("Database submission error:", error.message)
      return json({ ok: false, error: "Failed to record enquiry. Please contact the school directly." }, 500, cors.headers)
    }

    return json({ ok: true, message: successMessage(enquiry.type) }, 200, cors.headers)
  }
}

async function rateLimit(rpc: Rpc, key: string, limit: { max: number; windowSeconds: number }): Promise<boolean> {
  const { data, error } = await rpc("check_rate_limit", {
    p_key: key,
    p_limit: limit.max,
    p_window_seconds: limit.windowSeconds,
  })
  if (error) throw new Error(error.message)
  return data === true
}
