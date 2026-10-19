import { describe, it, expect, vi } from "vitest"
import { createProcessNotificationsHandler } from "../supabase/functions/_shared/processNotifications.ts"
import { buildNotificationEmail, escapeHtml, type EnquiryRow, type NotificationJobRow } from "../supabase/functions/_shared/email.ts"
import { envOf, fakeRpc, jsonResponse, silentLog } from "./helpers"

// Lease ownership, retry limits and backoff are enforced in SQL and tested
// against Postgres in tests/db (claim_notification_jobs / finish_notification_job).
// No real email is sent: Resend is a mocked fetch.

const SECRET = "a".repeat(40)
const ENV = {
  SUPABASE_URL: "https://abc.supabase.co",
  NOTIFICATIONS_CRON_SECRET: SECRET,
  RESEND_API_KEY: "re_live_key_123",
  FROM_EMAIL: "Mozart School <enquiries@mozartmusic.org>",
}

const enquiry: EnquiryRow = {
  id: "e1",
  type: "lesson",
  contact_name: "<script>alert(1)</script> Ravi",
  email: "ravi@example.org",
  phone: "9876543210",
  preferred_contact: "either",
  instrument: "piano",
  learner_group: "child",
  learner_name: "<img src=x onerror=alert(1)>",
  experience: "beginner",
  class_preference: "in_person",
  preferred_times: "Weekends & evenings",
  message: "Hello <b>there</b>\n\"quoted\"",
  location_updates: false,
  source: "piano_card",
  created_at: "2026-10-19T10:00:00Z",
}

function job(overrides: Partial<NotificationJobRow> = {}): NotificationJobRow {
  return {
    id: "job-1",
    enquiry_id: "e1",
    kind: "owner_alert",
    recipient: "owner@mozartmusic.org",
    subject: "New lesson enquiry — Piano — Child (In-person)",
    attempts: 1,
    processing_token: "token-1",
    ...overrides,
  }
}

function request(headers: Record<string, string> = { "x-cron-secret": SECRET }, method = "POST") {
  return new Request("https://abc.supabase.co/functions/v1/process-notifications", { method, headers })
}

function setup(options: { env?: Record<string, string | undefined>; jobs?: NotificationJobRow[]; resend?: () => Response | Promise<Response>; finish?: string } = {}) {
  const { rpc, calls } = fakeRpc({
    claim_notification_jobs: () => ({ data: options.jobs ?? [job()], error: null }),
    finish_notification_job: () => ({ data: options.finish ?? "sent", error: null }),
  })
  const fetchMock = vi.fn(async () => (options.resend ? options.resend() : jsonResponse({ id: "re_msg_1" })))
  const handler = createProcessNotificationsHandler({
    env: envOf({ ...ENV, ...options.env }),
    rpc,
    getEnquiry: async (id) => (id === "e1" ? enquiry : null),
    fetch: fetchMock as unknown as typeof fetch,
    log: silentLog,
  })
  return { handler, calls, fetchMock }
}

describe("process-notifications authorization", () => {
  it("rejects callers without the scheduler secret, including signed-in users", async () => {
    const { handler, calls } = setup()
    const attempts: Record<string, string>[] = [{}, { "x-cron-secret": "wrong" }, { Authorization: "Bearer eyJ.user.jwt" }]
    for (const headers of attempts) {
      expect((await handler(request(headers))).status).toBe(401)
    }
    expect(calls).toHaveLength(0)
  })

  it("refuses to run when the secret is missing or too short", async () => {
    for (const value of [undefined, "short-secret"]) {
      const { handler, calls } = setup({ env: { NOTIFICATIONS_CRON_SECRET: value } })
      expect((await handler(request({ "x-cron-secret": value ?? "" }))).status).toBe(503)
      expect(calls).toHaveLength(0)
    }
  })

  it("only accepts POST", async () => {
    const { handler } = setup()
    expect((await handler(request({ "x-cron-secret": SECRET }, "GET"))).status).toBe(405)
  })
})

describe("process-notifications delivery", () => {
  it("does not claim or mark jobs when the email provider is not configured", async () => {
    for (const env of [{ RESEND_API_KEY: undefined }, { RESEND_API_KEY: "re_your_resend_api_key_here" }, { FROM_EMAIL: undefined }, { RESEND_API_KEY: "mock-resend-key" }]) {
      const { handler, calls, fetchMock } = setup({ env })
      const res = await handler(request())
      expect(res.status).toBe(503)
      expect(calls).toHaveLength(0)
      expect(fetchMock).not.toHaveBeenCalled()
    }
  })

  it("refuses log-only delivery against a hosted project", async () => {
    const { handler, calls } = setup({ env: { EMAIL_DELIVERY_MODE: "log" } })
    expect((await handler(request())).status).toBe(503)
    expect(calls).toHaveLength(0)
  })

  it("allows log-only delivery with a local Supabase stack", async () => {
    const { handler, calls, fetchMock } = setup({ env: { EMAIL_DELIVERY_MODE: "log", SUPABASE_URL: "http://kong:8000", RESEND_API_KEY: undefined } })
    expect((await handler(request())).status).toBe(200)
    expect(fetchMock).not.toHaveBeenCalled()
    const finish = calls.find((c) => c.fn === "finish_notification_job")!
    expect(String(finish.args.p_provider_message_id)).toMatch(/^local-log-/)
  })

  it("sends through Resend and records the provider message id with the lease token", async () => {
    const { handler, calls, fetchMock } = setup()
    const res = await handler(request())
    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe("https://api.resend.com/emails")
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer re_live_key_123")
    const payload = JSON.parse(String(init.body))
    expect(payload.to).toEqual(["owner@mozartmusic.org"])
    expect(payload.reply_to).toBe("ravi@example.org")

    expect(calls.find((c) => c.fn === "claim_notification_jobs")!.args).toEqual({ p_batch_size: 10, p_lease_seconds: 300 })
    expect(calls.find((c) => c.fn === "finish_notification_job")!.args).toEqual({
      p_job_id: "job-1",
      p_processing_token: "token-1",
      p_sent: true,
      p_provider_message_id: "re_msg_1",
      p_error: null,
    })
    const body = await res.json()
    expect(body.results).toEqual([{ id: "job-1", outcome: "sent" }])
    expect(JSON.stringify(body)).not.toContain("owner@mozartmusic.org")
  })

  it("records provider failures as failed attempts instead of sent", async () => {
    const { handler, calls } = setup({ resend: () => jsonResponse({ name: "validation_error", message: "domain not verified" }, 403), finish: "retry_scheduled" })
    const res = await handler(request())
    const finish = calls.find((c) => c.fn === "finish_notification_job")!
    expect(finish.args.p_sent).toBe(false)
    expect(finish.args.p_provider_message_id).toBeNull()
    expect(String(finish.args.p_error)).toContain("domain not verified")
    expect((await res.json()).results[0].outcome).toBe("retry_scheduled")
  })

  it("treats a 200 response without a message id as a failure", async () => {
    const { handler, calls } = setup({ resend: () => jsonResponse({}) })
    await handler(request())
    expect(calls.find((c) => c.fn === "finish_notification_job")!.args.p_sent).toBe(false)
  })

  it("treats network errors and missing enquiries as failures", async () => {
    const network = setup({
      resend: () => {
        throw new TypeError("network down")
      },
    })
    await network.handler(request())
    expect(network.calls.find((c) => c.fn === "finish_notification_job")!.args.p_sent).toBe(false)

    const missing = setup({ jobs: [job({ enquiry_id: "gone" })] })
    await missing.handler(request())
    expect(missing.fetchMock).not.toHaveBeenCalled()
    expect(String(missing.calls.find((c) => c.fn === "finish_notification_job")!.args.p_error)).toContain("not found")
  })

  it("reports when another worker took over the lease", async () => {
    const { handler } = setup({ finish: "lease_lost" })
    const res = await handler(request())
    expect((await res.json()).results[0].outcome).toBe("lease_lost")
  })
})

describe("Notification email templates", () => {
  it("escapes every user-provided value in the owner alert", () => {
    const { html } = buildNotificationEmail(job(), enquiry)
    expect(html).not.toContain("<script>")
    expect(html).not.toContain("<img")
    expect(html).not.toContain("<b>there</b>")
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt; Ravi")
    expect(html).toContain("Weekends &amp; evenings")
    expect(html).toContain("&quot;quoted&quot;")
  })

  it("escapes the visitor name in the acknowledgement", () => {
    const { html, replyTo } = buildNotificationEmail(job({ kind: "visitor_acknowledgement", recipient: "ravi@example.org" }), enquiry)
    expect(html).toContain("Dear &lt;script&gt;")
    expect(replyTo).toBeUndefined()
  })

  it("omits reply-to when the visitor email is not a plain address", () => {
    const { replyTo } = buildNotificationEmail(job(), { ...enquiry, email: "bad@x.com>, evil@y.com" })
    expect(replyTo).toBeUndefined()
  })

  it("escapes all HTML-significant characters", () => {
    expect(escapeHtml(`<a href="x" onclick='y'>&</a>`)).toBe("&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;")
  })
})
