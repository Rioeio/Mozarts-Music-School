// Data access for the staff dashboard. The live backend relies on Supabase Auth
// sessions and database policies for every decision; the UI only mirrors them.
import { Enquiry, EnquiryStatus, StaffMember, StaffRole } from "./types"
import { appConfig } from "./config"
import { supabase, loadMockBackend } from "./supabase"
import { authRedirectUrl, type AuthLinkType } from "./authCallback"
import { readFunctionError } from "./api"

export interface StaffSession {
  userId: string
  staffId: string
  email: string
  name: string
  role: StaffRole
}

export type MembershipStatus = "active" | "pending" | "password_required" | "expired" | "revoked" | "none"

export interface Membership {
  status: MembershipStatus
  staff: StaffSession | null
}

export type StaffAction =
  | { action: "invite"; name: string; email: string; role: StaffRole }
  | { action: "resend" | "revoke" | "reactivate"; staffId: string }

export type AuthEvent = "SIGNED_IN" | "SIGNED_OUT" | "PASSWORD_RECOVERY" | "TOKEN_REFRESHED" | "USER_UPDATED" | "OTHER"

export interface AdminBackend {
  kind: "live" | "mock"
  hasSession(): Promise<boolean>
  onAuthChange(listener: (event: AuthEvent) => void): () => void
  signIn(email: string, password: string): Promise<void>
  signOut(): Promise<void>
  resolveMembership(): Promise<Membership>
  requestPasswordReset(email: string): Promise<void>
  verifyEmailLink(tokenHash: string, type: AuthLinkType): Promise<void>
  updatePassword(password: string): Promise<void>
  listEnquiries(includeNotifications: boolean): Promise<Enquiry[]>
  updateStatus(enquiryId: string, status: EnquiryStatus): Promise<void>
  addNote(enquiryId: string, note: string): Promise<void>
  deleteEnquiry(enquiryId: string): Promise<void>
  retryNotification(jobId: string): Promise<void>
  listStaff(): Promise<StaffMember[]>
  manageStaff(request: StaffAction): Promise<string>
  // Demo mode only.
  quickLogin?(role: StaffRole): Promise<void>
}

// Raised when the database says the session may no longer do something; the
// dashboard re-checks membership when it sees one.
export class PermissionError extends Error {}

export const MIN_PASSWORD_LENGTH = 10

const NOTIFICATION_COLUMNS = "id, enquiry_id, kind, status, recipient, subject, attempts, next_attempt_at, last_error, provider_message_id, created_at"

function fail(error: { message: string; code?: string } | null): void {
  if (!error) return
  if (error.code === "42501" || error.code === "PGRST301" || /permission denied|JWT/i.test(error.message)) {
    throw new PermissionError(error.message)
  }
  throw new Error(error.message)
}

function createLiveBackend(): AdminBackend {
  const client = supabase!
  return {
    kind: "live",
    async hasSession() {
      const { data } = await client.auth.getSession()
      return Boolean(data.session)
    },
    onAuthChange(listener) {
      const { data } = client.auth.onAuthStateChange((event) => {
        const known: AuthEvent[] = ["SIGNED_IN", "SIGNED_OUT", "PASSWORD_RECOVERY", "TOKEN_REFRESHED", "USER_UPDATED"]
        listener(known.includes(event as AuthEvent) ? (event as AuthEvent) : "OTHER")
      })
      return () => data.subscription.unsubscribe()
    },
    async signIn(email, password) {
      const { error } = await client.auth.signInWithPassword({ email: email.trim().toLowerCase(), password })
      if (error) throw new Error(error.message)
    },
    async signOut() {
      await client.auth.signOut()
    },
    async resolveMembership() {
      // getUser() validates the session with the Auth server instead of trusting storage.
      const { data: userData, error: userError } = await client.auth.getUser()
      if (userError || !userData.user) return { status: "none", staff: null }
      const { data, error } = await client.rpc("activate_staff_membership")
      if (error) throw new Error(error.message)
      const result = (data ?? {}) as { status?: MembershipStatus; staff_id?: string; name?: string; email?: string; role?: StaffRole }
      const status = result.status ?? "none"
      if (status !== "active" || !result.staff_id || !result.role) return { status, staff: null }
      return {
        status,
        staff: {
          userId: userData.user.id,
          staffId: result.staff_id,
          email: result.email ?? userData.user.email ?? "",
          name: result.name ?? "",
          role: result.role,
        },
      }
    },
    async requestPasswordReset(email) {
      const { error } = await client.auth.resetPasswordForEmail(email.trim().toLowerCase(), {
        redirectTo: authRedirectUrl(window.location.origin),
      })
      if (error) throw new Error(error.message)
    },
    async verifyEmailLink(tokenHash, type) {
      const { error } = await client.auth.verifyOtp({ token_hash: tokenHash, type })
      if (error) throw new Error(error.message)
    },
    async updatePassword(password) {
      const { error } = await client.auth.updateUser({ password })
      if (error) throw new Error(error.message)
    },
    async listEnquiries(includeNotifications) {
      const select = includeNotifications
        ? `*, enquiry_notes(*), notification_jobs(${NOTIFICATION_COLUMNS})`
        : "*, enquiry_notes(*)"
      const { data, error } = await client.from("enquiries").select(select).order("created_at", { ascending: false })
      fail(error)
      return ((data ?? []) as any[]).map((item) => ({
        ...item,
        notes: item.enquiry_notes || [],
        notification_jobs: item.notification_jobs || [],
      }))
    },
    async updateStatus(enquiryId, status) {
      // Only the status column is writable; updated_at is set by a trigger.
      const { data, error } = await client.from("enquiries").update({ status }).eq("id", enquiryId).select("id")
      fail(error)
      if (!data?.length) throw new PermissionError("The enquiry could not be updated.")
    },
    async addNote(enquiryId, note) {
      // Author fields are filled in by the database from the session.
      const { error } = await client.from("enquiry_notes").insert({ enquiry_id: enquiryId, note })
      fail(error)
    },
    async deleteEnquiry(enquiryId) {
      const { data, error } = await client.from("enquiries").delete().eq("id", enquiryId).select("id")
      fail(error)
      if (!data?.length) throw new PermissionError("Only administrators can delete enquiries.")
    },
    async retryNotification(jobId) {
      const { error } = await client.rpc("retry_notification_job", { p_job_id: jobId })
      fail(error)
    },
    async listStaff() {
      const { data, error } = await client.from("staff_members").select("*").order("created_at", { ascending: false })
      fail(error)
      return (data ?? []) as StaffMember[]
    },
    async manageStaff(request) {
      const { data, error } = await client.functions.invoke("manage-staff", { body: request })
      if (error) {
        const detail = await readFunctionError(error)
        throw new Error(detail.message || "Staff management is unavailable. Please try again.")
      }
      if (!data?.ok) throw new Error(data?.error || "Staff management failed.")
      return String(data.message)
    },
  }
}

function createMockBackend(): AdminBackend {
  const listeners = new Set<(event: AuthEvent) => void>()
  const emit = (event: AuthEvent) => listeners.forEach((listener) => listener(event))
  const DEMO_ONLY = "Demo mode: use the demo sign-in buttons. Passwords are not checked in demo mode."

  return {
    kind: "mock",
    async hasSession() {
      return Boolean((await loadMockBackend()).getMockUser())
    },
    onAuthChange(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async signIn() {
      throw new Error(DEMO_ONLY)
    },
    async quickLogin(role) {
      const mock = await loadMockBackend()
      const staff = mock.getStaffMembers().find((s) => s.role === role && s.invitation_status === "active")
      if (!staff) throw new Error("No active demo account for that role.")
      mock.setMockUser({ id: staff.id, email: staff.email, role: staff.role, name: staff.name })
      emit("SIGNED_IN")
    },
    async signOut() {
      ;(await loadMockBackend()).setMockUser(null)
      emit("SIGNED_OUT")
    },
    async resolveMembership() {
      const mock = await loadMockBackend()
      const user = mock.getMockUser()
      const staff = user ? mock.getStaffMembers().find((s) => s.id === user.id) : undefined
      if (!user || !staff) return { status: "none", staff: null }
      if (staff.invitation_status !== "active") return { status: staff.invitation_status === "revoked" ? "revoked" : "pending", staff: null }
      return { status: "active", staff: { userId: staff.id, staffId: staff.id, email: staff.email, name: staff.name, role: staff.role } }
    },
    async requestPasswordReset() {
      throw new Error("Demo mode: password reset emails are not sent.")
    },
    async verifyEmailLink() {
      throw new Error("Demo mode: email links are not supported.")
    },
    async updatePassword() {
      throw new Error("Demo mode: passwords are not stored.")
    },
    async listEnquiries(includeNotifications) {
      const items = (await loadMockBackend()).getEnquiries()
      return includeNotifications ? items : items.map((item) => ({ ...item, notification_jobs: [] }))
    },
    async updateStatus(enquiryId, status) {
      ;(await loadMockBackend()).updateStatus(enquiryId, status)
    },
    async addNote(enquiryId, note) {
      const mock = await loadMockBackend()
      mock.addNote(enquiryId, note, mock.getMockUser()?.email ?? "demo")
    },
    async deleteEnquiry(enquiryId) {
      ;(await loadMockBackend()).deleteEnquiry(enquiryId)
    },
    async retryNotification(jobId) {
      ;(await loadMockBackend()).retryNotification(jobId)
    },
    async listStaff() {
      return (await loadMockBackend()).getStaffMembers()
    },
    async manageStaff(request) {
      const mock = await loadMockBackend()
      if (request.action === "invite") {
        mock.inviteStaff(request.name, request.email, request.role)
        return `Demo mode: ${request.email.trim().toLowerCase()} was added locally. No email was sent.`
      }
      const staff = mock.getStaffMembers().find((s) => s.id === request.staffId)
      if (!staff) throw new Error("Staff record not found.")
      if (request.action === "resend") mock.resendInvite(staff.id)
      if (request.action === "revoke") mock.revokeStaff(staff.id)
      if (request.action === "reactivate") mock.reactivateStaff(staff.id)
      return `Demo mode: ${request.action} applied to ${staff.email} locally. No email was sent.`
    },
  }
}

export const adminBackend: AdminBackend | null =
  appConfig.mode === "live" ? createLiveBackend() : appConfig.mode === "mock" ? createMockBackend() : null
