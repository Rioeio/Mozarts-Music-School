import { describe, it, expect, vi } from "vitest"
import { validateEnquiryPayload } from "../src/lib/validation"
import { generateIdempotencyKey } from "../src/lib/api"
import { createSubmitEnquiryHandler, CONTACT_LIMIT, IP_LIMIT } from "../supabase/functions/_shared/submitEnquiry.ts"
import { getClientIp } from "../supabase/functions/_shared/clientIp.ts"
import { envOf, fakeRpc, jsonResponse, silentLog } from "./helpers"

// Rate limiting, idempotency and RPC privileges are also exercised against a real
// Postgres in tests/db (npm run test:db), including concurrent requests.

const ORIGIN = "https://mozartmusic.org"
const BASE_ENV = {
  SUPABASE_URL: "https://abc.supabase.co",
  ALLOWED_ORIGINS: `${ORIGIN},http://localhost:8443`,
  TURNSTILE_SECRET_KEY: "0x4AAAAAAAreal-secret-value-123456",
  OWNER_EMAIL: "owner@mozartmusic.org",
}

const validBody = {
  type: "lesson",
  contactName: "Sunita Sundaram",
  email: "Sunita@Example.org",
  instrument: "piano",
  learnerGroup: "child",
  experience: "beginner",
  classPreference: "online",
  contactConsent: true,
  idempotencyKey: "0b9f6a52-3d1e-4c7a-9a55-1f2d3e4c5b6a",
  turnstileToken: "turnstile-token",
}

function request(body: unknown, headers: Record<string, string> = {}, method = "POST") {
  return new Request("https://abc.supabase.co/functions/v1/submit-enquiry", {
    method,
    headers: { "Content-Type": "application/json", Origin: ORIGIN, "X-Forwarded-For": "203.0.113.9", ...headers },
    body: method === "POST" ? JSON.stringify(body) : undefined,
  })
}

function setup(options: { env?: Record<string, string | undefined>; siteverify?: unknown; rateLimitAllowed?: boolean; rpcError?: string } = {}) {
  const { rpc, calls } = fakeRpc({
    check_rate_limit: () => ({ data: options.rateLimitAllowed ?? true, error: null }),
    submit_enquiry_atomic: () => (options.rpcError ? { data: null, error: { message: options.rpcError } } : { data: "enquiry-id", error: null }),
  })
  const fetchMock = vi.fn(async () =>
    jsonResponse(options.siteverify ?? { success: true, action: "enquiry", hostname: "mozartmusic.org" }),
  )
  const handler = createSubmitEnquiryHandler({
    env: envOf({ ...BASE_ENV, ...options.env }),
    rpc,
    fetch: fetchMock as unknown as typeof fetch,
    log: silentLog,
  })
  return { handler, calls, fetchMock }
}

describe("Client-side abuse prevention", () => {
  it("immediately rejects submissions with populated honeypot fields", () => {
    const validation = validateEnquiryPayload({
      type: "lesson",
      contactName: "Spam Bot",
      email: "bot@spammer.com",
      contactConsent: true,
      _hp: "http://spamlink.com",
    })
    expect(validation.isValid).toBe(false)
    expect(validation.errors[0]?.field).toBe("_hp")
  })

  it("generates unique idempotency keys accepted by the server format", () => {
    const key1 = generateIdempotencyKey()
    const key2 = generateIdempotencyKey()
    expect(key1).not.toBe(key2)
    expect(key1).toMatch(/^[A-Za-z0-9_-]{8,100}$/)
  })
})

describe("submit-enquiry Edge Function", () => {
  it("records a valid enquiry through the service-role RPC after Turnstile and rate limits", async () => {
    const { handler, calls, fetchMock } = setup()
    const res = await handler(request(validBody))
    expect(res.status).toBe(200)
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body).not.toHaveProperty("id")

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(calls.map((c) => c.fn)).toEqual(["check_rate_limit", "check_rate_limit", "submit_enquiry_atomic"])
    expect(calls[0].args).toMatchObject({ p_limit: IP_LIMIT.max, p_window_seconds: IP_LIMIT.windowSeconds })
    expect(String(calls[0].args.p_key)).not.toContain("203.0.113.9")
    expect(calls[1].args).toMatchObject({ p_limit: CONTACT_LIMIT.max })
    expect(calls[2].args).toMatchObject({
      p_email: "sunita@example.org",
      p_idempotency_key: validBody.idempotencyKey,
      p_owner_email: "owner@mozartmusic.org",
      p_class_preference: "online",
      p_contact_consent: true,
    })
  })

  it("answers CORS preflight only for allowed origins and never with a wildcard", async () => {
    const { handler } = setup()
    const ok = await handler(request(null, {}, "OPTIONS"))
    expect(ok.status).toBe(204)
    expect(ok.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN)

    const evil = await handler(request(null, { Origin: "https://evil.example" }, "OPTIONS"))
    expect(evil.status).toBe(403)
    expect(evil.headers.get("Access-Control-Allow-Origin")).toBeNull()
  })

  it("rejects POSTs from origins that are not allowed", async () => {
    const { handler, calls } = setup()
    const res = await handler(request(validBody, { Origin: "https://evil.example" }))
    expect(res.status).toBe(403)
    expect(calls).toHaveLength(0)
  })

  it("ignores a wildcard in ALLOWED_ORIGINS", async () => {
    const { handler } = setup({ env: { ALLOWED_ORIGINS: "*" } })
    expect((await handler(request(validBody))).status).toBe(503)
  })

  it("fails closed with 503 when Turnstile, owner email or origins are not configured", async () => {
    for (const missing of ["TURNSTILE_SECRET_KEY", "OWNER_EMAIL", "ALLOWED_ORIGINS"]) {
      const { handler, calls, fetchMock } = setup({ env: { [missing]: undefined } })
      const res = await handler(request(validBody))
      expect(res.status, missing).toBe(503)
      expect(calls).toHaveLength(0)
      expect(fetchMock).not.toHaveBeenCalled()
    }
  })

  it("rejects placeholder secrets and Cloudflare test secrets outside local development", async () => {
    const placeholder = setup({ env: { TURNSTILE_SECRET_KEY: "0x4AAAAAA...your-turnstile-secret-key" } })
    expect((await placeholder.handler(request(validBody))).status).toBe(503)

    const testSecret = setup({ env: { TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA" } })
    expect((await testSecret.handler(request(validBody))).status).toBe(503)

    const local = setup({ env: { TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA", SUPABASE_URL: "http://kong:8000" }, siteverify: { success: true } })
    expect((await local.handler(request(validBody))).status).toBe(200)
  })

  it("returns 503 when the service-role client is unavailable", async () => {
    const handler = createSubmitEnquiryHandler({ env: envOf(BASE_ENV), rpc: null, fetch: vi.fn() as any, log: silentLog })
    expect((await handler(request(validBody))).status).toBe(503)
  })

  it("rejects missing, failed and mismatched Turnstile tokens without storing anything", async () => {
    const cases = [
      { body: { ...validBody, turnstileToken: undefined }, siteverify: undefined },
      { body: validBody, siteverify: { success: false, "error-codes": ["invalid-input-response"] } },
      { body: validBody, siteverify: { success: false, "error-codes": ["timeout-or-duplicate"] } },
      { body: validBody, siteverify: { success: true, action: "login", hostname: "mozartmusic.org" } },
      { body: validBody, siteverify: { success: true, action: "enquiry", hostname: "evil.example" } },
    ]
    for (const testCase of cases) {
      const { handler, calls } = setup({ siteverify: testCase.siteverify })
      const res = await handler(request(testCase.body))
      expect(res.status).toBe(400)
      expect((await res.json()).code).toBe("turnstile_failed")
      expect(calls.some((c) => c.fn === "submit_enquiry_atomic")).toBe(false)
    }
  })

  it("fails closed when Cloudflare siteverify is unreachable", async () => {
    const { rpc, calls } = fakeRpc({ check_rate_limit: () => ({ data: true, error: null }) })
    const handler = createSubmitEnquiryHandler({
      env: envOf(BASE_ENV),
      rpc,
      fetch: (async () => {
        throw new TypeError("network down")
      }) as unknown as typeof fetch,
      log: silentLog,
    })
    expect((await handler(request(validBody))).status).toBe(400)
    expect(calls.some((c) => c.fn === "submit_enquiry_atomic")).toBe(false)
  })

  it("returns 429 when the atomic rate limit refuses the request", async () => {
    const { handler, calls, fetchMock } = setup({ rateLimitAllowed: false })
    const res = await handler(request(validBody))
    expect(res.status).toBe(429)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(calls.some((c) => c.fn === "submit_enquiry_atomic")).toBe(false)
  })

  it("returns a decoy success for honeypot submissions without touching the database", async () => {
    const { handler, calls } = setup()
    const res = await handler(request({ ...validBody, _hp: "spam" }))
    expect(res.status).toBe(200)
    expect(calls).toHaveLength(0)
  })

  it("validates input server-side", async () => {
    const { handler } = setup()
    const bad = [
      { ...validBody, email: undefined, phone: undefined },
      { ...validBody, email: undefined, phone: "--------" },
      { ...validBody, email: "a'b@example.org" },
      { ...validBody, contactConsent: "yes" },
      { ...validBody, classPreference: undefined },
      { ...validBody, instrument: "drums" },
      { ...validBody, idempotencyKey: "bad key with spaces" },
    ]
    for (const body of bad) {
      expect((await handler(request(body))).status, JSON.stringify(body)).toBe(400)
    }
  })

  it("reports database failures instead of claiming success", async () => {
    const { handler } = setup({ rpcError: "violates check constraint" })
    const res = await handler(request(validBody))
    expect(res.status).toBe(500)
    expect((await res.json()).ok).toBe(false)
  })
})

describe("Trusted client IP", () => {
  it("uses the entry appended by the trusted proxy, not caller-supplied values", () => {
    const headers = new Headers({
      "x-forwarded-for": "1.2.3.4, 198.51.100.7",
      "cf-connecting-ip": "9.9.9.9",
      "x-real-ip": "8.8.8.8",
    })
    expect(getClientIp(headers, 1)).toBe("198.51.100.7")
    expect(getClientIp(headers, 2)).toBe("1.2.3.4")
  })

  it("returns null for missing or malformed values", () => {
    expect(getClientIp(new Headers(), 1)).toBeNull()
    expect(getClientIp(new Headers({ "x-forwarded-for": "not-an-ip" }), 1)).toBeNull()
    expect(getClientIp(new Headers({ "x-forwarded-for": "300.1.1.1" }), 1)).toBeNull()
    expect(getClientIp(new Headers({ "x-forwarded-for": "198.51.100.7" }), 2)).toBeNull()
  })

  it("normalises ports and IPv6", () => {
    expect(getClientIp(new Headers({ "x-forwarded-for": "198.51.100.7:4431" }), 1)).toBe("198.51.100.7")
    expect(getClientIp(new Headers({ "x-forwarded-for": "[2001:DB8::1]:443" }), 1)).toBe("2001:db8::1")
  })
})
