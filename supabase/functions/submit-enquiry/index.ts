// Public enquiry endpoint (verify_jwt = false: visitors are not signed in).
// Validation, Turnstile, rate limits and CORS live in ../_shared/submitEnquiry.ts.
import { createClient } from "npm:@supabase/supabase-js@2.117.2"
import { createSubmitEnquiryHandler } from "../_shared/submitEnquiry.ts"

const url = Deno.env.get("SUPABASE_URL")
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")
const supabase = url && serviceRoleKey
  ? createClient(url, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } })
  : null

Deno.serve(
  createSubmitEnquiryHandler({
    env: { get: (name) => Deno.env.get(name) },
    rpc: supabase ? async (fn, args) => await supabase.rpc(fn, args) : null,
    fetch,
  }),
)
