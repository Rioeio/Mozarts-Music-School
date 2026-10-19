export type EnquiryType = "lesson" | "location_interest" | "general"

export type EnquiryStatus =
  | "new"
  | "contacted"
  | "awaiting_reply"
  | "enrolled"
  | "closed"
  | "spam"

export type InstrumentType = "piano" | "keyboard" | "violin" | "unsure"

export type LearnerGroupType = "child" | "teen" | "adult"

export type ExperienceLevelType = "beginner" | "some_experience" | "experienced"

export type ClassPreference = "online" | "in_person" | "either_guidance"

export type StaffRole = "admin" | "staff"

export type StaffInvitationStatus = "active" | "invited" | "revoked"

export interface StaffMember {
  id: string
  user_id: string | null
  name: string
  email: string
  role: StaffRole
  invitation_status: StaffInvitationStatus
  invited_at: string
  invite_expires_at?: string | null
  accepted_at?: string | null
  created_at: string
}

export interface Enquiry {
  id: string
  created_at: string
  updated_at: string
  type: EnquiryType
  contact_name: string
  email: string | null
  phone: string | null
  preferred_contact: "email" | "phone" | "either" | null
  instrument: InstrumentType | null
  learner_group: LearnerGroupType | null
  learner_name: string | null
  experience: ExperienceLevelType | null
  class_preference: ClassPreference | null
  preferred_times: string | null
  message: string | null
  status: EnquiryStatus
  source: string
  contact_consent: boolean
  location_updates: boolean
  consent_version: string
  consented_at: string
  idempotency_key: string | null
  metadata: Record<string, any>
  notes?: EnquiryNote[]
  notification_jobs?: NotificationJob[]
}

export interface EnquiryNote {
  id: string
  enquiry_id: string
  admin_user_id: string
  admin_email: string | null
  note: string
  created_at: string
}

export interface NotificationJob {
  id: string
  enquiry_id: string
  kind: "owner_alert" | "visitor_acknowledgement"
  status: "pending" | "processing" | "sent" | "failed"
  recipient: string
  subject: string
  attempts: number
  next_attempt_at: string
  last_error: string | null
  provider_message_id: string | null
  created_at: string
}

export interface SubmissionPayload {
  type: EnquiryType
  contactName: string
  email?: string
  phone?: string
  preferredContact?: "email" | "phone" | "either"
  instrument?: InstrumentType
  learnerGroup?: LearnerGroupType
  learnerName?: string
  experience?: ExperienceLevelType
  classPreference?: ClassPreference
  preferredTimes?: string
  message?: string
  source?: string
  contactConsent: boolean
  locationUpdates?: boolean
  consentVersion?: string
  turnstileToken?: string
  idempotencyKey?: string
  _hp?: string // Honeypot
}

export interface AdminUser {
  user_id: string
  role: StaffRole
  created_at: string
}
