// Staff invitations and access changes for administrators. The caller's JWT is
// verified with Supabase Auth inside the handler (verify_jwt = false so CORS
// preflight requests reach the function); the service-role key never leaves the server.
import { createClient } from "npm:@supabase/supabase-js@2.117.2"
import { createManageStaffHandler, type StaffRow } from "../_shared/manageStaff.ts"

const url = Deno.env.get("SUPABASE_URL")
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")
const supabase = url && serviceRoleKey
  ? createClient(url, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } })
  : null

const STAFF_COLUMNS = "id, user_id, name, email, role, invitation_status"

async function one(query: PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<StaffRow | null> {
  const { data, error } = await query
  if (error) throw new Error(error.message)
  return (data as StaffRow | null) ?? null
}

Deno.serve(
  createManageStaffHandler({
    env: { get: (name) => Deno.env.get(name) },
    getUserIdFromJwt: async (jwt) => {
      if (!supabase) return null
      const { data, error } = await supabase.auth.getUser(jwt)
      return error || !data.user ? null : data.user.id
    },
    db: supabase
      ? {
        getStaffByUserId: (userId) => one(supabase.from("staff_members").select(STAFF_COLUMNS).eq("user_id", userId).maybeSingle()),
        getStaffById: (id) => one(supabase.from("staff_members").select(STAFF_COLUMNS).eq("id", id).maybeSingle()),
        getStaffByEmail: (email) => one(supabase.from("staff_members").select(STAFF_COLUMNS).eq("email", email).maybeSingle()),
        countActiveAdmins: async () => {
          const { count, error } = await supabase
            .from("staff_members")
            .select("id", { count: "exact", head: true })
            .eq("role", "admin")
            .eq("invitation_status", "active")
          if (error) throw new Error(error.message)
          return count ?? 0
        },
        insertStaff: async (row) => {
          const created = await one(supabase.from("staff_members").insert(row).select(STAFF_COLUMNS).single())
          if (!created) throw new Error("Insert returned no row.")
          return created
        },
        updateStaff: async (id, patch) => {
          const { error } = await supabase.from("staff_members").update(patch).eq("id", id)
          if (error) throw new Error(error.message)
        },
        deleteStaff: async (id) => {
          const { error } = await supabase.from("staff_members").delete().eq("id", id)
          if (error) throw new Error(error.message)
        },
      }
      : null,
    auth: supabase
      ? {
        inviteUserByEmail: async (email, redirectTo, name) => {
          const { error } = await supabase.auth.admin.inviteUserByEmail(email, { redirectTo, data: { full_name: name } })
          if (!error) return { ok: true }
          const alreadyRegistered = error.code === "email_exists" || /already been registered/i.test(error.message)
          return { ok: false, alreadyRegistered, message: error.message }
        },
        sendPasswordRecovery: async (email, redirectTo) => {
          const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo })
          return error ? { ok: false, message: error.message } : { ok: true }
        },
        setBanned: async (userId, banned) => {
          const { error } = await supabase.auth.admin.updateUserById(userId, { ban_duration: banned ? "876000h" : "none" })
          return error ? { ok: false, message: error.message } : { ok: true }
        },
      }
      : null,
  }),
)
