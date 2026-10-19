import { SubmissionPayload } from "./types"

export interface ValidationError {
  field: string
  message: string
}

export function validateEnquiryPayload(payload: Partial<SubmissionPayload>): {
  isValid: boolean
  errors: ValidationError[]
} {
  const errors: ValidationError[] = []

  // Check Honeypot
  if (payload._hp) {
    errors.push({ field: "_hp", message: "Bot submission detected." })
    return { isValid: false, errors }
  }

  // Type validation
  if (!payload.type || !["lesson", "location_interest", "general"].includes(payload.type)) {
    errors.push({ field: "type", message: "Please specify a valid enquiry type." })
  }

  // Contact Name validation
  const contactName = (payload.contactName || "").trim()
  if (contactName.length < 2) {
    errors.push({ field: "contactName", message: "Contact name must be at least 2 characters." })
  } else if (contactName.length > 120) {
    errors.push({ field: "contactName", message: "Contact name cannot exceed 120 characters." })
  }

  // Email & Phone checks
  const email = (payload.email || "").trim()
  const phone = (payload.phone || "").trim()

  // Same rule as the database constraint, so valid-looking input is never rejected later.
  const emailRegex = /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i
  if (email && !emailRegex.test(email)) {
    errors.push({ field: "email", message: "Please enter a valid email address." })
  }

  if (phone) {
    const cleanedPhone = phone.replace(/[^0-9+() -]/g, "")
    const digits = cleanedPhone.replace(/\D/g, "").length
    if (digits < 7 || cleanedPhone.length > 30) {
      errors.push({ field: "phone", message: "Please enter a valid phone number (at least 7 digits)." })
    }
  }

  // At least one contact method is required
  if (!email && !phone) {
    errors.push({
      field: "contact",
      message: "Please provide at least one contact method (email or phone).",
    })
  }

  // Consent validation
  if (!payload.contactConsent) {
    errors.push({
      field: "contactConsent",
      message: "Please confirm your consent to be contacted regarding this enquiry.",
    })
  }

  // Specific validations for lesson enquiries
  if (payload.type === "lesson") {
    if (payload.instrument && !["piano", "keyboard", "violin", "unsure"].includes(payload.instrument)) {
      errors.push({ field: "instrument", message: "Please select a valid instrument." })
    }
    if (payload.learnerGroup && !["child", "teen", "adult"].includes(payload.learnerGroup)) {
      errors.push({ field: "learnerGroup", message: "Please select a valid learner group." })
    }
    if (payload.experience && !["beginner", "some_experience", "experienced"].includes(payload.experience)) {
      errors.push({ field: "experience", message: "Please select a valid experience level." })
    }
    if (!payload.classPreference || !["online", "in_person", "either_guidance"].includes(payload.classPreference)) {
      errors.push({
        field: "classPreference",
        message: "Please select your class preference: Online, In-person, or Either / I’d like guidance.",
      })
    }
  }

  return {
    isValid: errors.length === 0,
    errors,
  }
}
