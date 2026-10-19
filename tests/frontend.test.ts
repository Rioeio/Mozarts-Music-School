import { describe, it, expect, vi } from "vitest"
import { resolveAppConfig } from "../src/lib/config"
import { createEnquirySubmitter } from "../src/lib/api"
import { loadMockBackend } from "../src/lib/supabase"
import { parseAuthCallback, authErrorMessage } from "../src/lib/authCallback"
import { resolveSearchIndexing, robotsTxt } from "../scripts/site-indexing"
import type { SubmissionPayload } from "../src/lib/types"

function jwt(role: string): string {
  const encode = (value: object) => btoa(JSON.stringify(value)).replace(/=+$/, "")
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ iss: "supabase", role })}.signature`
}

const LIVE = {
  VITE_SUPABASE_URL: "https://abcdefgh.supabase.co",
  VITE_SUPABASE_ANON_KEY: jwt("anon"),
  VITE_TURNSTILE_SITE_KEY: "0x4AAAAAAABcDeFgHiJkLmNo",
}

describe("Browser configuration", () => {
  it("accepts a complete production configuration", () => {
    expect(resolveAppConfig({ DEV: false, ...LIVE })).toMatchObject({ mode: "live", errors: [] })
    expect(resolveAppConfig({ DEV: false, ...LIVE, VITE_SUPABASE_ANON_KEY: "sb_publishable_abc123" }).mode).toBe("live")
  })

  it("never falls back to mock mode when production configuration is missing", () => {
    const config = resolveAppConfig({ DEV: false })
    expect(config.mode).toBe("misconfigured")
    expect(config.errors).toEqual(["VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY", "VITE_TURNSTILE_SITE_KEY"])
  })

  it("ignores the mock flag in builds", () => {
    expect(resolveAppConfig({ DEV: false, VITE_ENABLE_MOCK_BACKEND: "true" }).mode).toBe("misconfigured")
    expect(resolveAppConfig({ DEV: false, MODE: "mock", ...LIVE }).mode).toBe("misconfigured")
  })

  it("allows mock mode only on the dev server with the explicit flag", () => {
    expect(resolveAppConfig({ DEV: true, VITE_ENABLE_MOCK_BACKEND: "true" }).mode).toBe("mock")
    expect(resolveAppConfig({ DEV: true, MODE: "mock" }).mode).toBe("mock")
    expect(resolveAppConfig({ DEV: true }).mode).toBe("misconfigured")
  })

  it("rejects the placeholder values from .env.example", () => {
    const config = resolveAppConfig({
      DEV: false,
      VITE_SUPABASE_URL: "https://your-project-id.supabase.co",
      VITE_SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.your-anon-key-here",
      VITE_TURNSTILE_SITE_KEY: "0x4AAAAAA...your-turnstile-site-key",
    })
    expect(config.mode).toBe("misconfigured")
    expect(config.errors).toHaveLength(3)
  })

  it("refuses service-role and secret keys in the browser", () => {
    for (const key of [jwt("service_role"), "sb_secret_abc123"]) {
      const config = resolveAppConfig({ DEV: false, ...LIVE, VITE_SUPABASE_ANON_KEY: key })
      expect(config.mode).toBe("misconfigured")
      expect(config.errors[0]).toContain("secret/service-role")
    }
  })

  it("requires https and rejects Turnstile test keys in builds", () => {
    expect(resolveAppConfig({ DEV: false, ...LIVE, VITE_SUPABASE_URL: "http://abcdefgh.supabase.co" }).mode).toBe("misconfigured")
    expect(resolveAppConfig({ DEV: true, ...LIVE, VITE_SUPABASE_URL: "http://127.0.0.1:54321" }).mode).toBe("live")
    expect(resolveAppConfig({ DEV: false, ...LIVE, VITE_TURNSTILE_SITE_KEY: "1x00000000000000000000AA" }).mode).toBe("misconfigured")
    expect(resolveAppConfig({ DEV: true, ...LIVE, VITE_TURNSTILE_SITE_KEY: "1x00000000000000000000AA" }).mode).toBe("live")
  })

  it("refuses to load the demo backend outside mock mode", async () => {
    await expect(loadMockBackend()).rejects.toThrow("Demo mode is not available")
  })
})

const payload: SubmissionPayload = {
  type: "general",
  contactName: "Visitor Name",
  email: "visitor@example.org",
  message: "Hello",
  contactConsent: true,
  idempotencyKey: "0b9f6a52-3d1e-4c7a-9a55-1f2d3e4c5b6a",
  turnstileToken: "token",
}

describe("Enquiry submission client", () => {
  it("reports configuration errors and never stores the enquiry locally", async () => {
    const invoke = vi.fn()
    const loadMock = vi.fn()
    const submit = createEnquirySubmitter({ mode: "misconfigured", invoke, loadMock: loadMock as any })
    const res = await submit(payload)
    expect(res.ok).toBe(false)
    expect(res.code).toBe("config")
    expect(res.message).toContain("temporarily unavailable")
    expect(invoke).not.toHaveBeenCalled()
    expect(loadMock).not.toHaveBeenCalled()
  })

  it("labels demo-mode submissions as not sent", async () => {
    const addEnquiry = vi.fn()
    const submit = createEnquirySubmitter({ mode: "mock", invoke: null, loadMock: async () => ({ addEnquiry }) as any })
    const res = await submit(payload)
    expect(res.ok).toBe(true)
    expect(res.message).toContain("not sent to the school")
    expect(addEnquiry).toHaveBeenCalledOnce()
  })

  it("requires a Turnstile token in live mode", async () => {
    const invoke = vi.fn()
    const submit = createEnquirySubmitter({ mode: "live", invoke, loadMock: vi.fn() as any })
    const res = await submit({ ...payload, turnstileToken: undefined })
    expect(res.ok).toBe(false)
    expect(res.code).toBe("turnstile_failed")
    expect(invoke).not.toHaveBeenCalled()
  })

  it("sends the token and idempotency key, and surfaces server error messages", async () => {
    const response = new Response(JSON.stringify({ ok: false, code: "turnstile_failed", error: "The spam check could not be verified." }), { status: 400 })
    const invoke = vi.fn(async () => ({ data: null, error: { message: "Edge Function returned a non-2xx status code", context: response } }))
    const submit = createEnquirySubmitter({ mode: "live", invoke, loadMock: vi.fn() as any })
    const res = await submit(payload)
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ turnstileToken: "token", idempotencyKey: payload.idempotencyKey }))
    expect(res).toMatchObject({ ok: false, code: "turnstile_failed", message: "The spam check could not be verified." })
  })

  it("reports success only when the server confirms it", async () => {
    const ok = createEnquirySubmitter({ mode: "live", invoke: async () => ({ data: { ok: true, message: "Received" }, error: null }), loadMock: vi.fn() as any })
    expect(await ok(payload)).toMatchObject({ ok: true, message: "Received" })
    const odd = createEnquirySubmitter({ mode: "live", invoke: async () => ({ data: { ok: false, error: "Nope" }, error: null }), loadMock: vi.fn() as any })
    expect(await odd(payload)).toMatchObject({ ok: false, message: "Nope" })
  })
})

describe("Auth callback URLs", () => {
  it("ignores the site's ordinary hash routes", () => {
    expect(parseAuthCallback({ search: "", hash: "#home" })).toEqual({ kind: "none" })
    expect(parseAuthCallback({ search: "", hash: "#admin" })).toEqual({ kind: "none" })
  })

  it("recognises token-hash links from custom email templates", () => {
    expect(parseAuthCallback({ search: "?token_hash=abc&type=invite", hash: "" })).toEqual({ kind: "token_hash", tokenHash: "abc", type: "invite" })
    expect(parseAuthCallback({ search: "?token_hash=abc&type=recovery", hash: "" })).toEqual({ kind: "token_hash", tokenHash: "abc", type: "recovery" })
    expect(parseAuthCallback({ search: "?token_hash=abc&type=signup", hash: "" })).toEqual({ kind: "none" })
  })

  it("recognises default implicit-flow fragments", () => {
    expect(parseAuthCallback({ search: "", hash: "#access_token=x&refresh_token=y&type=recovery" })).toEqual({ kind: "session", type: "recovery" })
    expect(parseAuthCallback({ search: "", hash: "#access_token=x&type=invite" })).toEqual({ kind: "session", type: "invite" })
  })

  it("explains expired links", () => {
    const callback = parseAuthCallback({ search: "", hash: "#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired" })
    expect(callback).toMatchObject({ kind: "error", code: "otp_expired" })
    expect(authErrorMessage(callback as any)).toContain("expired")
  })
})

describe("Search indexing", () => {
  it("is off unless explicitly enabled", () => {
    expect(resolveSearchIndexing({}).indexable).toBe(false)
    expect(robotsTxt(resolveSearchIndexing({}))).toBe("User-agent: *\nDisallow: /\n")
  })

  it("is on for Vercel production deployments (and local builds) only", () => {
    expect(resolveSearchIndexing({ SITE_INDEXING: "true" }).indexable).toBe(true)
    expect(resolveSearchIndexing({ SITE_INDEXING: "true", VERCEL_ENV: "production" }).indexable).toBe(true)
    expect(resolveSearchIndexing({ SITE_INDEXING: "true", VERCEL_ENV: "preview" }).indexable).toBe(false)
    expect(resolveSearchIndexing({ SITE_INDEXING: "true", VERCEL_ENV: "development" }).indexable).toBe(false)
    expect(resolveSearchIndexing({ SITE_INDEXING: "false", VERCEL_ENV: "production" }).indexable).toBe(false)
  })

  it("allows crawling but keeps the dashboard out when indexable", () => {
    const decision = resolveSearchIndexing({ SITE_INDEXING: "true", SITE_URL: "https://mozartmusic.org" })
    expect(robotsTxt(decision)).toBe("User-agent: *\nAllow: /\nDisallow: /admin\n")
    expect(decision.canonicalUrl).toBe("https://mozartmusic.org/")
  })
})
