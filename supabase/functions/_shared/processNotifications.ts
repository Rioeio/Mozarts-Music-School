import { buildNotificationEmail, type EmailMessage, type EnquiryRow, type NotificationJobRow } from "./email.ts"
import { type Env, isLocalSupabaseUrl, readSetting } from "./env.ts"
import { json, secretsEqual } from "./http.ts"
import type { Rpc } from "./submitEnquiry.ts"

export interface ProcessNotificationsDeps {
  env: Env
  rpc: Rpc | null
  getEnquiry: ((id: string) => Promise<EnquiryRow | null>) | null
  fetch: typeof fetch
  log?: Pick<Console, "info" | "warn" | "error">
}

export const BATCH_SIZE = 10
export const LEASE_SECONDS = 300
const MIN_SECRET_LENGTH = 32

type Sender = (message: EmailMessage) => Promise<string>

interface DeliveryConfig {
  sender: Sender | null
  problem: string | null
}

function deliveryConfig(deps: ProcessNotificationsDeps): DeliveryConfig {
  const mode = (readSetting(deps.env, "EMAIL_DELIVERY_MODE") ?? "resend").toLowerCase()

  if (mode === "log") {
    // Local development only: nothing is delivered, so never allow it against a hosted project.
    if (!isLocalSupabaseUrl(readSetting(deps.env, "SUPABASE_URL"))) {
      return { sender: null, problem: "EMAIL_DELIVERY_MODE=log is only allowed with a local Supabase stack." }
    }
    return {
      sender: async (message) => {
        deps.log?.info(`[local email log] to=${message.to} subject="${message.subject}"`)
        return `local-log-${crypto.randomUUID()}`
      },
      problem: null,
    }
  }

  if (mode !== "resend") return { sender: null, problem: `Unknown EMAIL_DELIVERY_MODE "${mode}".` }

  const apiKey = readSetting(deps.env, "RESEND_API_KEY")
  const from = readSetting(deps.env, "FROM_EMAIL")
  if (!apiKey || !apiKey.startsWith("re_")) return { sender: null, problem: "RESEND_API_KEY is missing or invalid." }
  if (!from || !/[^\s@<]+@[^\s@>]+\.[^\s@>]+/.test(from)) return { sender: null, problem: "FROM_EMAIL is missing or invalid." }

  return {
    sender: async (message) => {
      const response = await deps.fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from,
          to: [message.to],
          reply_to: message.replyTo,
          subject: message.subject,
          html: message.html,
        }),
        signal: AbortSignal.timeout(15_000),
      })
      const data = (await response.json().catch(() => ({}))) as { id?: string; message?: string; name?: string }
      if (!response.ok) {
        throw new Error(`Resend API error (${response.status}): ${data.name ?? ""} ${data.message ?? ""}`.trim())
      }
      if (!data.id) throw new Error("Resend accepted the request but returned no message id.")
      return data.id
    },
    problem: null,
  }
}

export function createProcessNotificationsHandler(deps: ProcessNotificationsDeps) {
  const log = deps.log ?? console

  return async function handle(req: Request): Promise<Response> {
    if (req.method !== "POST") return json({ error: "Method not allowed" }, 405)

    const expected = readSetting(deps.env, "NOTIFICATIONS_CRON_SECRET")
    if (!expected || expected.length < MIN_SECRET_LENGTH) {
      log.error(`NOTIFICATIONS_CRON_SECRET is missing or shorter than ${MIN_SECRET_LENGTH} characters.`)
      return json({ error: "Notification worker is not configured." }, 503)
    }
    const provided = req.headers.get("x-cron-secret") ?? ""
    if (!provided || !(await secretsEqual(provided, expected))) {
      return json({ error: "Unauthorized" }, 401)
    }

    if (!deps.rpc || !deps.getEnquiry) {
      log.error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are missing.")
      return json({ error: "Notification worker is not configured." }, 503)
    }

    // Check delivery before claiming, so jobs are never consumed without a real provider.
    const delivery = deliveryConfig(deps)
    if (!delivery.sender) {
      log.error(`Email delivery is not configured: ${delivery.problem}`)
      return json({ error: "Email delivery is not configured.", detail: delivery.problem }, 503)
    }

    const { data, error } = await deps.rpc("claim_notification_jobs", {
      p_batch_size: BATCH_SIZE,
      p_lease_seconds: LEASE_SECONDS,
    })
    if (error) {
      log.error("Error claiming jobs:", error.message)
      return json({ error: "Could not claim notification jobs." }, 500)
    }

    const jobs = (Array.isArray(data) ? data : []) as NotificationJobRow[]
    const results: { id: string; outcome: string }[] = []

    for (const job of jobs) {
      let sent = false
      let providerMessageId: string | null = null
      let failure: string | null = null
      try {
        const enquiry = await deps.getEnquiry(job.enquiry_id)
        if (!enquiry) throw new Error(`Enquiry ${job.enquiry_id} not found.`)
        providerMessageId = await delivery.sender(buildNotificationEmail(job, enquiry))
        sent = true
      } catch (err) {
        failure = err instanceof Error ? err.message : String(err)
        log.error(`Failed to deliver notification ${job.id}: ${failure}`)
      }

      const finish = await deps.rpc("finish_notification_job", {
        p_job_id: job.id,
        p_processing_token: job.processing_token,
        p_sent: sent,
        p_provider_message_id: providerMessageId,
        p_error: failure,
      })
      if (finish.error) {
        log.error(`Could not record the outcome of ${job.id}: ${finish.error.message}`)
        results.push({ id: job.id, outcome: "record_failed" })
        continue
      }
      if (finish.data === "lease_lost") log.warn(`Lease for ${job.id} was lost; another worker owns it now.`)
      results.push({ id: job.id, outcome: String(finish.data) })
    }

    return json({ processed: results.length, results }, 200)
  }
}
