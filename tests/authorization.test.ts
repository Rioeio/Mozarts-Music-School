import { describe, it, expect, vi } from "vitest"
import { createManageStaffHandler, type InviteOutcome, type ManageStaffDeps, type StaffRow } from "../supabase/functions/_shared/manageStaff.ts"
import { envOf, silentLog } from "./helpers"

// Row-level permissions for anon, unknown, invited, active, revoked, admin and
// service-role callers are tested against Postgres in tests/db (npm run test:db).
// These tests cover the server-side staff management and invitation flow.

const ORIGIN = "https://mozartmusic.org"
const ADMIN: StaffRow = { id: "11111111-1111-4111-8111-111111111111", user_id: "user-admin", name: "Admin", email: "admin@mozartmusic.org", role: "admin", invitation_status: "active" }
const STAFF: StaffRow = { id: "22222222-2222-4222-8222-222222222222", user_id: "user-staff", name: "Staff", email: "staff@mozartmusic.org", role: "staff", invitation_status: "active" }
const INVITED: StaffRow = { id: "33333333-3333-4333-8333-333333333333", user_id: null, name: "Invited", email: "invited@mozartmusic.org", role: "staff", invitation_status: "invited" }
const REVOKED_LINKED: StaffRow = { id: "44444444-4444-4444-8444-444444444444", user_id: "user-revoked", name: "Revoked", email: "revoked@mozartmusic.org", role: "staff", invitation_status: "revoked" }
const REVOKED_UNLINKED: StaffRow = { id: "55555555-5555-4555-8555-555555555555", user_id: null, name: "Never Joined", email: "never@mozartmusic.org", role: "staff", invitation_status: "revoked" }
const TOKENS: Record<string, string> = { "admin-jwt": "user-admin", "staff-jwt": "user-staff", "revoked-jwt": "user-revoked", "stranger-jwt": "user-stranger" }

function setup(options: { invite?: InviteOutcome; recoveryOk?: boolean; banOk?: boolean; rows?: StaffRow[] } = {}) {
  const rows = new Map((options.rows ?? [ADMIN, STAFF, INVITED, REVOKED_LINKED, REVOKED_UNLINKED]).map((r) => [r.id, { ...r }]))
  const invite = vi.fn(async () => options.invite ?? ({ ok: true } as InviteOutcome))
  const recovery = vi.fn(async () => (options.recoveryOk === false ? { ok: false, message: "smtp down" } : { ok: true }))
  const ban = vi.fn(async () => (options.banOk === false ? { ok: false, message: "auth down" } : { ok: true }))
  const deps: ManageStaffDeps = {
    env: envOf({ ALLOWED_ORIGINS: `${ORIGIN},http://localhost:8443`, SITE_URL: ORIGIN }),
    getUserIdFromJwt: async (jwt) => TOKENS[jwt] ?? null,
    db: {
      getStaffByUserId: async (userId) => [...rows.values()].find((r) => r.user_id === userId) ?? null,
      getStaffById: async (id) => rows.get(id) ?? null,
      getStaffByEmail: async (email) => [...rows.values()].find((r) => r.email === email) ?? null,
      countActiveAdmins: async () => [...rows.values()].filter((r) => r.role === "admin" && r.invitation_status === "active").length,
      insertStaff: async (row) => {
        const created: StaffRow = { id: "66666666-6666-4666-8666-666666666666", user_id: null, name: row.name, email: row.email, role: row.role, invitation_status: row.invitation_status }
        rows.set(created.id, created)
        return created
      },
      updateStaff: async (id, patch) => {
        rows.set(id, { ...rows.get(id)!, ...patch })
      },
      deleteStaff: async (id) => {
        rows.delete(id)
      },
    },
    auth: { inviteUserByEmail: invite, sendPasswordRecovery: recovery, setBanned: ban },
    now: () => new Date("2026-10-20T00:00:00Z"),
    log: silentLog,
  }
  const handler = createManageStaffHandler(deps)
  const call = async (body: unknown, jwt: string | null = "admin-jwt", origin = ORIGIN) => {
    const res = await handler(new Request("https://abc.supabase.co/functions/v1/manage-staff", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin, ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}) },
      body: JSON.stringify(body),
    }))
    return { status: res.status, body: await res.json() }
  }
  return { call, rows, invite, recovery, ban }
}

const inviteBody = { action: "invite", name: "New Teacher", email: "New.Teacher@MozartMusic.org", role: "staff" }

describe("manage-staff: caller authorization", () => {
  it("requires a valid session", async () => {
    const { call, invite } = setup()
    expect((await call(inviteBody, null)).status).toBe(401)
    expect((await call(inviteBody, "forged-jwt")).status).toBe(401)
    expect(invite).not.toHaveBeenCalled()
  })

  it("denies staff, revoked users and users without a staff record", async () => {
    const { call, invite, rows } = setup()
    for (const jwt of ["staff-jwt", "revoked-jwt", "stranger-jwt"]) {
      expect((await call(inviteBody, jwt)).status, jwt).toBe(403)
    }
    expect((await call({ action: "revoke", staffId: ADMIN.id }, "staff-jwt")).status).toBe(403)
    expect(invite).not.toHaveBeenCalled()
    expect(rows.get(ADMIN.id)!.invitation_status).toBe("active")
  })

  it("ignores role or identity fields smuggled into the request", async () => {
    const { call } = setup()
    const res = await call({ ...inviteBody, callerRole: "admin", userId: "user-admin" }, "staff-jwt")
    expect(res.status).toBe(403)
  })

  it("is not configured without SITE_URL", async () => {
    const handler = createManageStaffHandler({
      env: envOf({ ALLOWED_ORIGINS: ORIGIN }),
      getUserIdFromJwt: async () => "user-admin",
      db: null,
      auth: null,
      log: silentLog,
    })
    const res = await handler(new Request("https://x/functions/v1/manage-staff", { method: "POST", headers: { Origin: ORIGIN }, body: "{}" }))
    expect(res.status).toBe(503)
  })
})

describe("manage-staff: invitations", () => {
  it("creates an invited row and sends a Supabase invitation to the dashboard callback", async () => {
    const { call, rows, invite } = setup()
    const res = await call(inviteBody)
    expect(res.status).toBe(200)
    expect(res.body.message).toBe("Invitation email sent to new.teacher@mozartmusic.org.")
    expect(invite).toHaveBeenCalledWith("new.teacher@mozartmusic.org", `${ORIGIN}/admin/auth/callback`, "New Teacher")
    const created = [...rows.values()].find((r) => r.email === "new.teacher@mozartmusic.org")!
    expect(created).toMatchObject({ invitation_status: "invited", user_id: null, role: "staff" })
  })

  it("uses the admin's own allowed origin for the callback (localhost during development)", async () => {
    const { call, invite } = setup()
    await call(inviteBody, "admin-jwt", "http://localhost:8443")
    expect(invite).toHaveBeenCalledWith(expect.any(String), "http://localhost:8443/admin/auth/callback", expect.any(String))
  })

  it("removes the row and reports failure when the invitation email cannot be sent", async () => {
    const { call, rows } = setup({ invite: { ok: false, alreadyRegistered: false, message: "Email rate limit exceeded" } })
    const res = await call(inviteBody)
    expect(res.status).toBe(502)
    expect(res.body.error).toContain("Email rate limit exceeded")
    expect(res.body.error).toContain("No access was granted")
    expect([...rows.values()].some((r) => r.email === "new.teacher@mozartmusic.org")).toBe(false)
  })

  it("falls back to a password-reset email for existing accounts", async () => {
    const { call, recovery, rows } = setup({ invite: { ok: false, alreadyRegistered: true, message: "already registered" } })
    const res = await call(inviteBody)
    expect(res.status).toBe(200)
    expect(res.body.message).toContain("already has an account")
    expect(recovery).toHaveBeenCalledWith("new.teacher@mozartmusic.org", `${ORIGIN}/admin/auth/callback`)
    expect([...rows.values()].find((r) => r.email === "new.teacher@mozartmusic.org")!.invitation_status).toBe("invited")
  })

  it("rolls back when both the invitation and the fallback email fail", async () => {
    const { call, rows } = setup({ invite: { ok: false, alreadyRegistered: true, message: "already registered" }, recoveryOk: false })
    expect((await call(inviteBody)).status).toBe(502)
    expect([...rows.values()].some((r) => r.email === "new.teacher@mozartmusic.org")).toBe(false)
  })

  it("rejects duplicate invitations with a specific message", async () => {
    const { call, invite } = setup()
    expect((await call({ ...inviteBody, email: INVITED.email })).body.error).toContain("Resend Invite")
    expect((await call({ ...inviteBody, email: STAFF.email })).body.error).toContain("already has active access")
    expect((await call({ ...inviteBody, email: REVOKED_LINKED.email })).body.error).toContain("Reactivate")
    expect(invite).not.toHaveBeenCalled()
  })

  it("validates invitation input", async () => {
    const { call } = setup()
    expect((await call({ ...inviteBody, email: "not-an-email" })).status).toBe(400)
    expect((await call({ ...inviteBody, role: "owner" })).status).toBe(400)
    expect((await call({ ...inviteBody, name: "A" })).status).toBe(400)
    expect((await call({ action: "promote", staffId: STAFF.id })).status).toBe(400)
    expect((await call({ action: "revoke", staffId: "not-a-uuid" })).status).toBe(400)
  })

  it("resends only pending invitations and extends their expiry on success", async () => {
    const { call, rows, invite } = setup()
    const res = await call({ action: "resend", staffId: INVITED.id })
    expect(res.status).toBe(200)
    expect(invite).toHaveBeenCalledOnce()
    expect((rows.get(INVITED.id) as any).invite_expires_at).toBe("2026-10-27T00:00:00.000Z")
    expect((await call({ action: "resend", staffId: STAFF.id })).status).toBe(409)
  })

  it("does not extend the expiry when a resend fails", async () => {
    const { call, rows } = setup({ invite: { ok: false, alreadyRegistered: false, message: "smtp down" } })
    expect((await call({ action: "resend", staffId: INVITED.id })).status).toBe(502)
    expect((rows.get(INVITED.id) as any).invite_expires_at).toBeUndefined()
  })
})

describe("manage-staff: revoke and reactivate", () => {
  it("revokes access in the database and blocks sign-in", async () => {
    const { call, rows, ban } = setup()
    const res = await call({ action: "revoke", staffId: STAFF.id })
    expect(res.status).toBe(200)
    expect(rows.get(STAFF.id)!.invitation_status).toBe("revoked")
    expect(ban).toHaveBeenCalledWith("user-staff", true)
  })

  it("keeps the revocation when the sign-in block fails, and says so", async () => {
    const { call, rows } = setup({ banOk: false })
    const res = await call({ action: "revoke", staffId: STAFF.id })
    expect(res.status).toBe(200)
    expect(res.body.message).toContain("could not be blocked")
    expect(rows.get(STAFF.id)!.invitation_status).toBe("revoked")
  })

  it("prevents self-revocation, so an administrator always remains", async () => {
    const { call, rows } = setup()
    const res = await call({ action: "revoke", staffId: ADMIN.id })
    expect(res.status).toBe(400)
    expect(res.body.error).toContain("your own access")
    expect(rows.get(ADMIN.id)!.invitation_status).toBe("active")
  })

  it("lets an administrator revoke another administrator", async () => {
    const second: StaffRow = { ...ADMIN, id: "77777777-7777-4777-8777-777777777777", user_id: "user-admin-2", email: "admin2@mozartmusic.org" }
    const { call, rows } = setup({ rows: [ADMIN, second] })
    expect((await call({ action: "revoke", staffId: second.id })).status).toBe(200)
    expect(rows.get(second.id)!.invitation_status).toBe("revoked")
  })

  it("restores a linked account only after its sign-in is unblocked", async () => {
    const failed = setup({ banOk: false })
    expect((await failed.call({ action: "reactivate", staffId: REVOKED_LINKED.id })).status).toBe(502)
    expect(failed.rows.get(REVOKED_LINKED.id)!.invitation_status).toBe("revoked")

    const ok = setup()
    expect((await ok.call({ action: "reactivate", staffId: REVOKED_LINKED.id })).status).toBe(200)
    expect(ok.rows.get(REVOKED_LINKED.id)!.invitation_status).toBe("active")
    expect(ok.ban).toHaveBeenCalledWith("user-revoked", false)
  })

  it("re-invites a revoked person who never accepted, without granting access", async () => {
    const { call, rows, invite } = setup()
    const res = await call({ action: "reactivate", staffId: REVOKED_UNLINKED.id })
    expect(res.status).toBe(200)
    expect(invite).toHaveBeenCalledOnce()
    expect(rows.get(REVOKED_UNLINKED.id)!.invitation_status).toBe("invited")
  })
})
