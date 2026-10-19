import { SubmissionPayload } from "./types"
import { supabase, loadMockBackend } from "./supabase"
import { appConfig, BackendMode, CONTACT_FALLBACK } from "./config"
import { validateEnquiryPayload } from "./validation"

export interface ApiResponse {
  ok: boolean
  message: string
  error?: string
  // Set when the server rejected the Turnstile token; the widget must be solved again.
  code?: "turnstile_failed" | "config" | "validation"
}

export function generateIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID()
  }
  return "key-" + Math.random().toString(36).substring(2, 15) + Date.now().toString(36)
}

type Invoke = (body: SubmissionPayload) => Promise<{ data: any; error: any }>

export interface SubmitterDeps {
  mode: BackendMode
  invoke: Invoke | null
  loadMock: typeof loadMockBackend
}

// Reads the JSON error body of a non-2xx Edge Function response.
export async function readFunctionError(error: any): Promise<{ message: string; code?: string }> {
  const response = error?.context
  if (response && typeof response.json === "function") {
    try {
      const body = await response.clone().json()
      if (body?.error) return { message: String(body.error), code: body.code }
    } catch {
      // fall through
    }
  }
  return { message: "" }
}

export function createEnquirySubmitter(deps: SubmitterDeps) {
  return async function submit(payload: SubmissionPayload): Promise<ApiResponse> {
    const validation = validateEnquiryPayload(payload)
    if (!validation.isValid) {
      return {
        ok: false,
        code: "validation",
        message: validation.errors[0]?.message || "Validation failed.",
        error: validation.errors[0]?.message,
      }
    }

    const completePayload: SubmissionPayload = {
      ...payload,
      idempotencyKey: payload.idempotencyKey || generateIdempotencyKey(),
      consentVersion: payload.consentVersion || "v1",
    }

    if (deps.mode === "misconfigured" || (deps.mode === "live" && !deps.invoke)) {
      return {
        ok: false,
        code: "config",
        message: `Online enquiries are temporarily unavailable. ${CONTACT_FALLBACK}`,
      }
    }

    if (deps.mode === "mock") {
      const mock = await deps.loadMock()
      mock.addEnquiry({
        type: completePayload.type,
        contact_name: completePayload.contactName,
        email: completePayload.email ? completePayload.email.trim().toLowerCase() : null,
        phone: completePayload.phone ? completePayload.phone.trim() : null,
        preferred_contact: completePayload.preferredContact || (completePayload.email && completePayload.phone ? "either" : completePayload.email ? "email" : "phone"),
        instrument: completePayload.instrument || null,
        learner_group: completePayload.learnerGroup || null,
        learner_name: completePayload.learnerName ? completePayload.learnerName.trim() : null,
        experience: completePayload.experience || null,
        class_preference: completePayload.classPreference || null,
        preferred_times: completePayload.preferredTimes ? completePayload.preferredTimes.trim() : null,
        message: completePayload.message ? completePayload.message.trim() : null,
        status: "new",
        source: completePayload.source || "website_form",
        contact_consent: completePayload.contactConsent,
        location_updates: Boolean(completePayload.locationUpdates),
        consent_version: "v1",
        consented_at: new Date().toISOString(),
        idempotency_key: completePayload.idempotencyKey || null,
        metadata: { isPreviewMock: true },
      })
      return {
        ok: true,
        message: "Demo mode: this enquiry was saved only in this browser. It was not sent to the school and nobody will reply.",
      }
    }

    if (!completePayload.turnstileToken) {
      return { ok: false, code: "turnstile_failed", message: "Please complete the spam check before submitting." }
    }

    try {
      const { data, error } = await deps.invoke!(completePayload)
      if (error) {
        const detail = await readFunctionError(error)
        console.error("Edge function error:", error)
        return {
          ok: false,
          code: detail.code === "turnstile_failed" ? "turnstile_failed" : undefined,
          message: detail.message || `We could not submit your enquiry. ${CONTACT_FALLBACK}`,
          error: detail.message || error.message,
        }
      }
      if (!data?.ok) {
        return { ok: false, message: data?.error || `We could not submit your enquiry. ${CONTACT_FALLBACK}` }
      }
      return { ok: true, message: data.message || "Thank you. Your enquiry has been received." }
    } catch (err: any) {
      console.error("Network error during submission:", err)
      return {
        ok: false,
        message: `Network error. Please try again, or reach us directly. ${CONTACT_FALLBACK}`,
        error: err?.message,
      }
    }
  }
}

export const submitEnquiry = createEnquirySubmitter({
  mode: appConfig.mode,
  invoke: supabase ? (body) => supabase!.functions.invoke("submit-enquiry", { body }) : null,
  loadMock: loadMockBackend,
})
