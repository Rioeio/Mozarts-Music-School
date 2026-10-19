// Development-only demo backend backed by browser storage. Loaded through
// loadMockBackend() in supabase.ts, which is compiled out of production builds.
// Nothing stored here reaches the school.
import { Enquiry, EnquiryNote, NotificationJob, StaffMember, StaffRole } from "./types"

const STORAGE_KEY_ENQUIRIES = "mozart_school_mock_enquiries"
const STORAGE_KEY_NOTES = "mozart_school_mock_notes"
const STORAGE_KEY_JOBS = "mozart_school_mock_jobs"
const STORAGE_KEY_AUTH = "mozart_school_mock_auth_user"
const STORAGE_KEY_STAFF = "mozart_school_mock_staff"

const SEED_STAFF: StaffMember[] = [
  {
    id: "staff-01",
    user_id: "user-srinivas",
    name: "Srinivas Chetty",
    email: "srinivaschetty@gmail.com",
    role: "admin",
    invitation_status: "active",
    invited_at: new Date(Date.now() - 3600 * 1000 * 24 * 30).toISOString(),
    created_at: new Date(Date.now() - 3600 * 1000 * 24 * 30).toISOString(),
  },
  {
    id: "staff-02",
    user_id: "user-radhika",
    name: "Radhika K.",
    email: "radhika@mozartmusic.org",
    role: "staff",
    invitation_status: "active",
    invited_at: new Date(Date.now() - 3600 * 1000 * 24 * 14).toISOString(),
    created_at: new Date(Date.now() - 3600 * 1000 * 24 * 14).toISOString(),
  },
  {
    id: "staff-03",
    user_id: null,
    name: "Anand M.",
    email: "anand@mozartmusic.org",
    role: "staff",
    invitation_status: "invited",
    invited_at: new Date(Date.now() - 3600 * 1000 * 24 * 3).toISOString(),
    created_at: new Date(Date.now() - 3600 * 1000 * 24 * 3).toISOString(),
  },
]

const SEED_ENQUIRIES: Enquiry[] = [
  {
    id: "e100-demo-piano",
    created_at: new Date(Date.now() - 3600 * 1000 * 4).toISOString(),
    updated_at: new Date(Date.now() - 3600 * 1000 * 4).toISOString(),
    type: "lesson",
    contact_name: "Anita Ramanathan",
    email: "anita.r@example.com",
    phone: "9840123456",
    preferred_contact: "either",
    instrument: "piano",
    learner_group: "child",
    learner_name: "Maya",
    experience: "beginner",
    class_preference: "online",
    preferred_times: "Weekday afternoons after 4 PM",
    message: "Looking for beginner piano guidance for my 8-year-old. Interested in Western classical fundamentals online.",
    status: "new",
    source: "piano_card",
    contact_consent: true,
    location_updates: false,
    consent_version: "v1",
    consented_at: new Date(Date.now() - 3600 * 1000 * 4).toISOString(),
    idempotency_key: "demo-key-1",
    metadata: { sourceCta: "piano_card" },
  },
  {
    id: "e101-demo-location",
    created_at: new Date(Date.now() - 3600 * 1000 * 24).toISOString(),
    updated_at: new Date(Date.now() - 3600 * 1000 * 24).toISOString(),
    type: "location_interest",
    contact_name: "Vikram Sundaram",
    email: "vikram.sundaram@example.com",
    phone: "9884567890",
    preferred_contact: "email",
    instrument: "violin",
    learner_group: "adult",
    learner_name: null,
    experience: "some_experience",
    class_preference: "in_person",
    preferred_times: "Saturday mornings",
    message: "Would love to know when the new studio opens. Interested in adult in-person violin classes.",
    status: "contacted",
    source: "location_interest",
    contact_consent: true,
    location_updates: true,
    consent_version: "v1",
    consented_at: new Date(Date.now() - 3600 * 1000 * 24).toISOString(),
    idempotency_key: "demo-key-2",
    metadata: { sourceCta: "location_interest" },
  },
  {
    id: "e102-demo-keyboard",
    created_at: new Date(Date.now() - 3600 * 1000 * 48).toISOString(),
    updated_at: new Date(Date.now() - 3600 * 1000 * 12).toISOString(),
    type: "lesson",
    contact_name: "Siddharth Menon",
    email: "siddharth.m@example.com",
    phone: "9444112233",
    preferred_contact: "phone",
    instrument: "keyboard",
    learner_group: "teen",
    learner_name: "Arjun",
    experience: "beginner",
    class_preference: "either_guidance",
    preferred_times: "Sunday mornings",
    message: "Teen interested in keyboard theory and notation. Open to online or in-person.",
    status: "awaiting_reply",
    source: "keyboard_card",
    contact_consent: true,
    location_updates: false,
    consent_version: "v1",
    consented_at: new Date(Date.now() - 3600 * 1000 * 48).toISOString(),
    idempotency_key: "demo-key-3",
    metadata: { sourceCta: "keyboard_card" },
  },
]

const SEED_NOTES: EnquiryNote[] = [
  {
    id: "note-1",
    enquiry_id: "e101-demo-location",
    admin_user_id: "staff-1",
    admin_email: "srinivaschetty@gmail.com",
    note: "Sent a welcoming update regarding the upcoming in-person space schedule. Marked as contacted.",
    created_at: new Date(Date.now() - 3600 * 1000 * 18).toISOString(),
  },
]

const SEED_JOBS: NotificationJob[] = [
  {
    id: "job-1",
    enquiry_id: "e100-demo-piano",
    kind: "owner_alert",
    status: "sent",
    recipient: "srinivaschetty@gmail.com",
    subject: "New lesson enquiry — Piano — Child (Online)",
    attempts: 1,
    next_attempt_at: new Date().toISOString(),
    last_error: null,
    provider_message_id: "mock_resend_101",
    created_at: new Date(Date.now() - 3600 * 1000 * 4).toISOString(),
  },
  {
    id: "job-2",
    enquiry_id: "e100-demo-piano",
    kind: "visitor_acknowledgement",
    status: "sent",
    recipient: "anita.r@example.com",
    subject: "Thank you for your enquiry — Mozart School Of Western Classical Music",
    attempts: 1,
    next_attempt_at: new Date().toISOString(),
    last_error: null,
    provider_message_id: "mock_resend_102",
    created_at: new Date(Date.now() - 3600 * 1000 * 4).toISOString(),
  },
]

const memoryStorage: Record<string, string> = {}

function getStored<T>(key: string, seed: T): T {
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      const raw = window.localStorage.getItem(key)
      if (!raw) {
        window.localStorage.setItem(key, JSON.stringify(seed))
        return seed
      }
      return JSON.parse(raw)
    }
    const mem = memoryStorage[key]
    if (!mem) {
      memoryStorage[key] = JSON.stringify(seed)
      return seed
    }
    return JSON.parse(mem)
  } catch {
    return seed
  }
}

function setStored<T>(key: string, data: T) {
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      window.localStorage.setItem(key, JSON.stringify(data))
    } else {
      memoryStorage[key] = JSON.stringify(data)
    }
  } catch {
    memoryStorage[key] = JSON.stringify(data)
  }
}

export const mockBackend = {
  getEnquiries(): Enquiry[] {
    const enquiries = getStored<Enquiry[]>(STORAGE_KEY_ENQUIRIES, SEED_ENQUIRIES)
    const notes = getStored<EnquiryNote[]>(STORAGE_KEY_NOTES, SEED_NOTES)
    const jobs = getStored<NotificationJob[]>(STORAGE_KEY_JOBS, SEED_JOBS)

    return enquiries.map((e) => ({
      ...e,
      notes: notes.filter((n) => n.enquiry_id === e.id),
      notification_jobs: jobs.filter((j) => j.enquiry_id === e.id),
    }))
  },

  addEnquiry(item: Omit<Enquiry, "id" | "created_at" | "updated_at">): Enquiry {
    const enquiries = getStored<Enquiry[]>(STORAGE_KEY_ENQUIRIES, SEED_ENQUIRIES)
    const newEnquiry: Enquiry = {
      ...item,
      id: "enq-" + Math.random().toString(36).substring(2, 9),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }
    enquiries.unshift(newEnquiry)
    setStored(STORAGE_KEY_ENQUIRIES, enquiries)

    // Queue demo notification jobs (never delivered in demo mode)
    const jobs = getStored<NotificationJob[]>(STORAGE_KEY_JOBS, SEED_JOBS)
    jobs.push({
      id: "job-" + Math.random().toString(36).substring(2, 9),
      enquiry_id: newEnquiry.id,
      kind: "owner_alert",
      status: "pending",
      recipient: "srinivaschetty@gmail.com",
      subject: `New enquiry from ${newEnquiry.contact_name}`,
      attempts: 1,
      next_attempt_at: new Date().toISOString(),
      last_error: null,
      provider_message_id: null,
      created_at: new Date().toISOString(),
    })
    if (newEnquiry.email) {
      jobs.push({
        id: "job-" + Math.random().toString(36).substring(2, 9),
        enquiry_id: newEnquiry.id,
        kind: "visitor_acknowledgement",
        status: "pending",
        recipient: newEnquiry.email,
        subject: "Thank you for your enquiry — Mozart School",
        attempts: 1,
        next_attempt_at: new Date().toISOString(),
        last_error: null,
        provider_message_id: null,
        created_at: new Date().toISOString(),
      })
    }
    setStored(STORAGE_KEY_JOBS, jobs)

    return newEnquiry
  },

  updateStatus(id: string, status: Enquiry["status"]): boolean {
    const enquiries = getStored<Enquiry[]>(STORAGE_KEY_ENQUIRIES, SEED_ENQUIRIES)
    const target = enquiries.find((e) => e.id === id)
    if (!target) return false
    target.status = status
    target.updated_at = new Date().toISOString()
    setStored(STORAGE_KEY_ENQUIRIES, enquiries)
    return true
  },

  addNote(enquiryId: string, noteText: string, adminEmail: string): EnquiryNote {
    const notes = getStored<EnquiryNote[]>(STORAGE_KEY_NOTES, SEED_NOTES)
    const newNote: EnquiryNote = {
      id: "note-" + Math.random().toString(36).substring(2, 9),
      enquiry_id: enquiryId,
      admin_user_id: "mock-admin-id",
      admin_email: adminEmail,
      note: noteText,
      created_at: new Date().toISOString(),
    }
    notes.unshift(newNote)
    setStored(STORAGE_KEY_NOTES, notes)
    return newNote
  },

  deleteEnquiry(id: string): boolean {
    const enquiries = getStored<Enquiry[]>(STORAGE_KEY_ENQUIRIES, SEED_ENQUIRIES)
    const filtered = enquiries.filter((e) => e.id !== id)
    setStored(STORAGE_KEY_ENQUIRIES, filtered)
    return true
  },

  retryNotification(jobId: string): boolean {
    const jobs = getStored<NotificationJob[]>(STORAGE_KEY_JOBS, SEED_JOBS)
    const job = jobs.find((j) => j.id === jobId)
    if (!job) return false
    job.status = "pending"
    job.attempts = 0
    job.last_error = null
    setStored(STORAGE_KEY_JOBS, jobs)
    return true
  },

  // -------------------------------------------------------------
  // Staff Directory Management
  // -------------------------------------------------------------
  getStaffMembers(): StaffMember[] {
    return getStored<StaffMember[]>(STORAGE_KEY_STAFF, SEED_STAFF)
  },

  inviteStaff(name: string, email: string, role: StaffRole): StaffMember {
    const staffList = getStored<StaffMember[]>(STORAGE_KEY_STAFF, SEED_STAFF)
    const existing = staffList.find((s) => s.email.toLowerCase() === email.trim().toLowerCase())
    if (existing) {
      if (existing.invitation_status === "revoked") {
        existing.invitation_status = "invited"
        existing.role = role
        existing.name = name
        existing.invited_at = new Date().toISOString()
        setStored(STORAGE_KEY_STAFF, staffList)
        return existing
      }
      throw new Error("A staff member with this email already exists.")
    }

    const newStaff: StaffMember = {
      id: "staff-" + Math.random().toString(36).substring(2, 9),
      user_id: null,
      name: name.trim(),
      email: email.trim().toLowerCase(),
      role,
      invitation_status: "invited",
      invited_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    }
    staffList.push(newStaff)
    setStored(STORAGE_KEY_STAFF, staffList)
    return newStaff
  },

  resendInvite(id: string): boolean {
    const staffList = getStored<StaffMember[]>(STORAGE_KEY_STAFF, SEED_STAFF)
    const target = staffList.find((s) => s.id === id)
    if (!target) return false
    target.invited_at = new Date().toISOString()
    setStored(STORAGE_KEY_STAFF, staffList)
    return true
  },

  revokeStaff(id: string): boolean {
    const staffList = getStored<StaffMember[]>(STORAGE_KEY_STAFF, SEED_STAFF)
    const target = staffList.find((s) => s.id === id)
    if (!target) return false
    target.invitation_status = "revoked"
    setStored(STORAGE_KEY_STAFF, staffList)
    return true
  },

  reactivateStaff(id: string): boolean {
    const staffList = getStored<StaffMember[]>(STORAGE_KEY_STAFF, SEED_STAFF)
    const target = staffList.find((s) => s.id === id)
    if (!target) return false
    target.invitation_status = "active"
    setStored(STORAGE_KEY_STAFF, staffList)
    return true
  },

  // Auth mock
  getMockUser(): { id: string; email: string; role: StaffRole; name: string } | null {
    try {
      if (typeof window !== "undefined" && window.localStorage) {
        const raw = window.localStorage.getItem(STORAGE_KEY_AUTH)
        return raw ? JSON.parse(raw) : null
      }
      const mem = memoryStorage[STORAGE_KEY_AUTH]
      return mem ? JSON.parse(mem) : null
    } catch {
      return null
    }
  },

  setMockUser(user: { id: string; email: string; role: StaffRole; name: string } | null) {
    if (typeof window !== "undefined" && window.localStorage) {
      if (user) {
        window.localStorage.setItem(STORAGE_KEY_AUTH, JSON.stringify(user))
      } else {
        window.localStorage.removeItem(STORAGE_KEY_AUTH)
      }
    } else {
      if (user) {
        memoryStorage[STORAGE_KEY_AUTH] = JSON.stringify(user)
      } else {
        delete memoryStorage[STORAGE_KEY_AUTH]
      }
    }
  },
}
