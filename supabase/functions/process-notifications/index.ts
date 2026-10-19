// Notification worker, invoked by pg_cron (see supabase/sql/schedule_process_notifications.sql).
// Authorised by the x-cron-secret header, not by JWT: any visitor can obtain a valid
// anon JWT, so verify_jwt alone would not stop ordinary callers.
import { createClient } from "npm:@supabase/supabase-js@2.117.2"
import type { EnquiryRow } from "../_shared/email.ts"
import { createProcessNotificationsHandler } from "../_shared/processNotifications.ts"

const url = Deno.env.get("SUPABASE_URL")
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")
const supabase = url && serviceRoleKey
  ? createClient(url, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } })
  : null

Deno.serve(
  createProcessNotificationsHandler({
    env: { get: (name) => Deno.env.get(name) },
    rpc: supabase ? async (fn, args) => await supabase.rpc(fn, args) : null,
    getEnquiry: supabase
      ? async (id) => {
        const { data, error } = await supabase.from("enquiries").select("*").eq("id", id).maybeSingle()
        if (error) throw new Error(`Could not load enquiry ${id}: ${error.message}`)
        return data as EnquiryRow | null
      }
      : null,
    fetch,
  }),
)
