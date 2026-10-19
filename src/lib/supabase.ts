import { createClient, SupabaseClient } from "@supabase/supabase-js"
import { appConfig } from "./config"
import { parseAuthCallback, type AuthCallback } from "./authCallback"
import type { mockBackend as MockBackend } from "./mockBackend"

// Captured before the client initialises, because supabase-js consumes and
// clears auth fragments from the URL.
export const initialAuthCallback: AuthCallback =
  typeof window !== "undefined" ? parseAuthCallback(window.location) : { kind: "none" }

export const isLiveSupabaseConfigured = appConfig.mode === "live"
export const isMockMode = appConfig.mode === "mock"

// Real client only with valid configuration. There is no silent fallback.
export const supabase: SupabaseClient | null = isLiveSupabaseConfigured
  ? createClient(appConfig.supabaseUrl, appConfig.supabaseAnonKey, {
    auth: {
      // Invitation and recovery emails sent by Supabase use the implicit flow.
      flowType: "implicit",
      detectSessionInUrl: true,
      persistSession: true,
      autoRefreshToken: true,
    },
  })
  : null

// The demo backend is only reachable from the Vite dev server. In builds
// import.meta.env.DEV is false, so this branch and the module are dropped.
export async function loadMockBackend(): Promise<typeof MockBackend> {
  if (import.meta.env.DEV && isMockMode) {
    return (await import("./mockBackend")).mockBackend
  }
  throw new Error("Demo mode is not available in this build.")
}
