// Server-side validation and normalisation of public enquiry submissions.
// The database constraints are the final word; this keeps errors friendly.

export const EMAIL_PATTERN = /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i

const TYPES = ["lesson", "location_interest", "general"] as const
const INSTRUMENTS = ["piano", "keyboard", "violin", "unsure"] as const
const LEARNER_GROUPS = ["child", "teen", "adult"] as const
const EXPERIENCE = ["beginner", "some_experience", "experienced"] as const
const CLASS_PREFERENCES = ["online", "in_person", "either_guidance"] as const
const PREFERRED_CONTACT = ["email", "phone", "either"] as const

export interface NormalisedEnquiry {
  type: (typeof TYPES)[number]
  contactName: string
  email: string | null
  phone: string | null
  preferredContact: (typeof PREFERRED_CONTACT)[number]
  instrument: (typeof INSTRUMENTS)[number] | null
  learnerGroup: (typeof LEARNER_GROUPS)[number] | null
  learnerName: string | null
  experience: (typeof EXPERIENCE)[number] | null
  classPreference: (typeof CLASS_PREFERENCES)[number] | null
  preferredTimes: string | null
  message: string | null
  source: string
  locationUpdates: boolean
  consentVersion: string
  idempotencyKey: string | null
  turnstileToken: string | undefined
}

export type ParseResult =
  | { ok: true; value: NormalisedEnquiry; honeypot: false }
  | { ok: true; honeypot: true }
  | { ok: false; error: string }

function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed ? trimmed.slice(0, max) : null
}

function oneOf<T extends readonly string[]>(value: unknown, allowed: T): T[number] | null | undefined {
  if (value === undefined || value === null || value === "") return null
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T[number]) : undefined
}

export function parseEnquiryInput(raw: unknown): ParseResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "Invalid request body." }
  }
  const data = raw as Record<string, unknown>

  // Honeypot fields must be empty. The caller returns a decoy success.
  if (text(data._hp, 500) || text(data.honeypot, 500)) return { ok: true, honeypot: true }

  const type = oneOf(data.type, TYPES)
  if (!type) return { ok: false, error: "Invalid enquiry type specified." }

  const contactName = typeof data.contactName === "string" ? data.contactName.trim() : ""
  if (contactName.length < 2 || contactName.length > 120) {
    return { ok: false, error: "Please provide a valid contact name (2-120 characters)." }
  }

  const email = text(data.email, 255)?.toLowerCase() ?? null
  if (email && !EMAIL_PATTERN.test(email)) {
    return { ok: false, error: "Please provide a valid email address." }
  }

  const rawPhone = typeof data.phone === "string" ? data.phone.replace(/[^0-9+() -]/g, "").trim() : ""
  const phone = rawPhone || null
  if (phone && (phone.length > 30 || (phone.match(/\d/g) ?? []).length < 7)) {
    return { ok: false, error: "Please provide a valid phone number." }
  }

  if (!email && !phone) {
    return { ok: false, error: "Please provide at least one contact method (email or phone)." }
  }

  if (data.contactConsent !== true) {
    return { ok: false, error: "You must consent to be contacted regarding your enquiry." }
  }

  const instrument = oneOf(data.instrument, INSTRUMENTS)
  if (instrument === undefined) return { ok: false, error: "Invalid instrument selection." }
  const learnerGroup = oneOf(data.learnerGroup, LEARNER_GROUPS)
  if (learnerGroup === undefined) return { ok: false, error: "Invalid learner group selection." }
  const experience = oneOf(data.experience, EXPERIENCE)
  if (experience === undefined) return { ok: false, error: "Invalid experience selection." }
  const classPreference = oneOf(data.classPreference, CLASS_PREFERENCES)
  if (classPreference === undefined || (type === "lesson" && !classPreference)) {
    return { ok: false, error: "Please select your class preference: Online, In-person, or Either / I’d like guidance." }
  }
  const preferredContact = oneOf(data.preferredContact, PREFERRED_CONTACT)
  if (preferredContact === undefined) return { ok: false, error: "Invalid preferred contact method." }

  const idempotencyKey = text(data.idempotencyKey, 200)
  if (idempotencyKey && !/^[A-Za-z0-9_-]{8,100}$/.test(idempotencyKey)) {
    return { ok: false, error: "Invalid submission key. Please reload the page and try again." }
  }

  const consentVersion = text(data.consentVersion, 20) ?? "v1"
  if (!/^[A-Za-z0-9._-]+$/.test(consentVersion)) {
    return { ok: false, error: "Invalid consent version." }
  }

  return {
    ok: true,
    honeypot: false,
    value: {
      type,
      contactName,
      email,
      phone,
      preferredContact: preferredContact ?? (email && phone ? "either" : email ? "email" : "phone"),
      instrument,
      learnerGroup,
      learnerName: text(data.learnerName, 80),
      experience,
      classPreference,
      preferredTimes: text(data.preferredTimes, 300),
      message: text(data.message, 3000),
      source: text(data.source, 80) ?? "website_form",
      locationUpdates: data.locationUpdates === true,
      consentVersion,
      idempotencyKey,
      turnstileToken: typeof data.turnstileToken === "string" ? data.turnstileToken : undefined,
    },
  }
}
