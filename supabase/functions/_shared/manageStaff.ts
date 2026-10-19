// Staff access management for administrators: invite, resend, revoke, reactivate.
// Runs with the service role; the caller is authorised from their own JWT and
// their active admin row in staff_members, never from request fields.

import { EMAIL_PATTERN } from "./enquiry.ts"
import { type Env, parseAllowedOrigins, parseSiteUrl, readSetting } from "./env.ts"
import { bearerToken, buildCors, json } from "./http.ts"

export type StaffRole = "admin" | "staff"
export type StaffStatus = "active" | "invited" | "revoked"

export interface StaffRow {
  id: string
  user_id: string | null
  name: string
  email: string
  role: StaffRole
  invitation_status: StaffStatus
}

export type InviteOutcome =
  | { ok: true }
  | { ok: false; alreadyRegistered: boolean; message: string }

export interface ManageStaffDeps {
  env: Env
  getUserIdFromJwt(jwt: string): Promise<string | null>
  db: {
    getStaffByUserId(userId: string): Promise<StaffRow | null>
    getStaffById(id: string): Promise<StaffRow | null>
    getStaffByEmail(email: string): Promise<StaffRow | null>
    countActiveAdmins(): Promise<number>
    insertStaff(row: Omit<StaffRow, "id" | "user_id"> & { invited_at: string; invite_expires_at: string }): Promise<StaffRow>
    updateStaff(id: string, patch: Partial<StaffRow> & { invited_at?: string; invite_expires_at?: string }): Promise<void>
    deleteStaff(id: string): Promise<void>
  } | null
  auth: {
    inviteUserByEmail(email: string, redirectTo: string, name: string): Promise<InviteOutcome>
    sendPasswordRecovery(email: string, redirectTo: string): Promise<{ ok: boolean; message?: string }>
    setBanned(userId: string, banned: boolean): Promise<{ ok: boolean; message?: string }>
  } | null
  now?: () => Date
  log?: Pick<Console, "warn" | "error">
}

export const INVITE_VALIDITY_DAYS = 7
export const AUTH_CALLBACK_PATH = "/admin/auth/callback"

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

type Action =
  | { action: "invite"; name: string; email: string; role: StaffRole }
  | { action: "resend" | "revoke" | "reactivate"; staffId: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function parseAction(raw: unknown): Action {
  if (!raw || typeof raw !== "object") throw new HttpError(400, "Invalid request body.")
  const body = raw as Record<string, unknown>
  if (body.action === "invite") {
    const name = typeof body.name === "string" ? body.name.trim() : ""
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : ""
    if (name.length < 2 || name.length > 120) throw new HttpError(400, "Please provide the staff member's full name (2-120 characters).")
    if (!EMAIL_PATTERN.test(email) || email.length > 255) throw new HttpError(400, "Please provide a valid email address.")
    if (body.role !== "admin" && body.role !== "staff") throw new HttpError(400, "Please choose a valid role.")
    return { action: "invite", name, email, role: body.role }
  }
  if (body.action === "resend" || body.action === "revoke" || body.action === "reactivate") {
    if (typeof body.staffId !== "string" || !UUID.test(body.staffId)) throw new HttpError(400, "Invalid staff record.")
    return { action: body.action, staffId: body.staffId }
  }
  throw new HttpError(400, "Unknown action.")
}

export function createManageStaffHandler(deps: ManageStaffDeps) {
  const log = deps.log ?? console
  const now = deps.now ?? (() => new Date())

  return async function handle(req: Request): Promise<Response> {
    const allowedOrigins = parseAllowedOrigins(readSetting(deps.env, "ALLOWED_ORIGINS"))
    const cors = buildCors(req, allowedOrigins, "POST, OPTIONS")
    const reply = (body: Record<string, unknown>, status: number) => json(body, status, cors.headers)

    if (req.method === "OPTIONS") return new Response(null, { status: cors.allowed ? 204 : 403, headers: cors.headers })
    if (req.method !== "POST") return reply({ ok: false, error: "Method not allowed" }, 405)

    const siteUrl = parseSiteUrl(readSetting(deps.env, "SITE_URL"))
    const { db, auth } = deps
    if (!db || !auth || !siteUrl || allowedOrigins.length === 0) {
      log.error("manage-staff is not configured: requires SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SITE_URL and ALLOWED_ORIGINS.")
      return reply({ ok: false, error: "Staff management is not configured on the server." }, 503)
    }
    if (cors.origin !== null && !cors.allowed) return reply({ ok: false, error: "Origin not allowed." }, 403)

    try {
      const jwt = bearerToken(req)
      const callerId = jwt ? await deps.getUserIdFromJwt(jwt) : null
      if (!callerId) throw new HttpError(401, "Your session has expired. Please sign in again.")

      const caller = await db.getStaffByUserId(callerId)
      if (!caller || caller.role !== "admin" || caller.invitation_status !== "active") {
        throw new HttpError(403, "Only active administrators can manage staff access.")
      }

      let body: unknown
      try {
        body = await req.json()
      } catch {
        throw new HttpError(400, "Invalid request body.")
      }
      const action = parseAction(body)

      // Invitation links return to the dashboard the admin is using when that
      // origin is trusted (localhost during development), otherwise SITE_URL.
      const redirectTo = `${cors.allowed && cors.origin ? cors.origin : siteUrl}${AUTH_CALLBACK_PATH}`
      const expiry = () => {
        const current = now()
        return {
          invited_at: current.toISOString(),
          invite_expires_at: new Date(current.getTime() + INVITE_VALIDITY_DAYS * 86_400_000).toISOString(),
        }
      }

      // Sends the invitation, falling back to a password-reset email when the
      // address already has an account (Supabase cannot invite existing users).
      const deliverInvitation = async (email: string, name: string): Promise<string> => {
        const invite = await auth.inviteUserByEmail(email, redirectTo, name)
        if (invite.ok) return `Invitation email sent to ${email}.`
        if (invite.alreadyRegistered) {
          const recovery = await auth.sendPasswordRecovery(email, redirectTo)
          if (recovery.ok) {
            return `${email} already has an account, so a sign-in (password reset) link was emailed instead. Access activates when they sign in.`
          }
          throw new HttpError(502, `The sign-in email could not be sent: ${recovery.message ?? "unknown error"}. No access was granted.`)
        }
        throw new HttpError(502, `The invitation email could not be sent: ${invite.message}. No access was granted.`)
      }

      if (action.action === "invite") {
        const existing = await db.getStaffByEmail(action.email)
        if (existing) {
          const hint = existing.invitation_status === "active"
            ? "already has active access"
            : existing.invitation_status === "invited"
            ? "has already been invited. Use Resend Invite instead"
            : "had access revoked. Use Reactivate instead"
          throw new HttpError(409, `${action.email} ${hint}.`)
        }

        let row: StaffRow
        try {
          row = await db.insertStaff({
            name: action.name,
            email: action.email,
            role: action.role,
            invitation_status: "invited",
            ...expiry(),
          })
        } catch (err) {
          // A concurrent invite for the same address hit the unique constraint.
          log.warn("Staff insert failed:", err)
          throw new HttpError(409, `${action.email} has already been invited.`)
        }

        try {
          return reply({ ok: true, message: await deliverInvitation(action.email, action.name) }, 200)
        } catch (err) {
          // Undo the row so a failed invitation leaves no pending access behind.
          await db.deleteStaff(row.id).catch((cleanup) => log.error("Could not remove failed invitation row:", cleanup))
          throw err
        }
      }

      const target = await db.getStaffById(action.staffId)
      if (!target) throw new HttpError(404, "Staff record not found.")

      if (action.action === "resend") {
        if (target.invitation_status !== "invited") {
          throw new HttpError(409, `${target.email} is not awaiting an invitation.`)
        }
        const message = await deliverInvitation(target.email, target.name)
        await db.updateStaff(target.id, expiry())
        return reply({ ok: true, message }, 200)
      }

      if (action.action === "revoke") {
        if (target.user_id === callerId) throw new HttpError(400, "You cannot revoke your own access.")
        if (target.invitation_status === "revoked") throw new HttpError(409, `${target.email} is already revoked.`)
        if (target.role === "admin" && target.invitation_status === "active" && (await db.countActiveAdmins()) <= 1) {
          throw new HttpError(400, "At least one active administrator must remain.")
        }
        // The database row is authoritative and takes effect immediately; the ban
        // additionally stops the account signing in or refreshing its session.
        await db.updateStaff(target.id, { invitation_status: "revoked" })
        if (target.user_id) {
          const ban = await auth.setBanned(target.user_id, true)
          if (!ban.ok) {
            log.error(`Could not ban ${target.user_id}: ${ban.message}`)
            return reply({ ok: true, message: `Access revoked for ${target.email}. Their sign-in could not be blocked (${ban.message}), but the dashboard already denies them.` }, 200)
          }
        }
        return reply({ ok: true, message: `Access revoked for ${target.email}.` }, 200)
      }

      // reactivate
      if (target.invitation_status !== "revoked") throw new HttpError(409, `${target.email} is not revoked.`)
      if (target.user_id) {
        const unban = await auth.setBanned(target.user_id, false)
        if (!unban.ok) throw new HttpError(502, `Could not restore sign-in for ${target.email}: ${unban.message}. Access was not restored.`)
        await db.updateStaff(target.id, { invitation_status: "active" })
        return reply({ ok: true, message: `Access restored for ${target.email}.` }, 200)
      }
      // Never accepted: reactivating means inviting again.
      const message = await deliverInvitation(target.email, target.name)
      await db.updateStaff(target.id, { invitation_status: "invited", ...expiry() })
      return reply({ ok: true, message }, 200)
    } catch (err) {
      if (err instanceof HttpError) return reply({ ok: false, error: err.message }, err.status)
      log.error("manage-staff failed:", err)
      return reply({ ok: false, error: "Staff management failed unexpectedly. No changes were confirmed." }, 500)
    }
  }
}
