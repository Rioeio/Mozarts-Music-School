// Parses Supabase Auth email-link callbacks. Works alongside the site's hash
// routes (#home, #admin): only fragments that carry auth parameters are treated
// as callbacks.
//
// Supported shapes:
//   /admin/auth/callback?token_hash=...&type=invite|recovery   (custom email templates)
//   /admin/auth/callback#access_token=...&type=invite|recovery (Supabase default links)
//   ...#error=access_denied&error_code=otp_expired&error_description=...

export const AUTH_CALLBACK_PATH = "/admin/auth/callback"

export type AuthLinkType = "invite" | "recovery"

export type AuthCallback =
  | { kind: "none" }
  | { kind: "token_hash"; tokenHash: string; type: AuthLinkType }
  | { kind: "session"; type: AuthLinkType | null }
  | { kind: "error"; code: string; description: string }

function linkType(value: string | null): AuthLinkType | null {
  return value === "invite" || value === "recovery" ? value : null
}

function hashParams(hash: string): URLSearchParams | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash
  return raw.includes("=") ? new URLSearchParams(raw) : null
}

export function parseAuthCallback(location: { search: string; hash: string }): AuthCallback {
  const query = new URLSearchParams(location.search)
  const fragment = hashParams(location.hash)

  const errorCode = fragment?.get("error_code") ?? query.get("error_code") ?? fragment?.get("error") ?? query.get("error")
  if (errorCode) {
    const description = fragment?.get("error_description") ?? query.get("error_description") ?? ""
    return { kind: "error", code: errorCode, description: description.replace(/\+/g, " ") }
  }

  const tokenHash = query.get("token_hash")
  const queryType = linkType(query.get("type"))
  if (tokenHash && queryType) return { kind: "token_hash", tokenHash, type: queryType }

  if (fragment?.get("access_token")) return { kind: "session", type: linkType(fragment.get("type")) }

  return { kind: "none" }
}

export function authErrorMessage(callback: Extract<AuthCallback, { kind: "error" }>): string {
  if (callback.code === "otp_expired") {
    return "This link has expired or was already used. Ask an administrator to resend your invitation, or request a new password reset below."
  }
  return callback.description || "This sign-in link is invalid. Please request a new one."
}

// Redirect target for invitation and password-reset emails. Must be listed under
// Supabase Auth > URL Configuration > Redirect URLs.
export function authRedirectUrl(origin: string): string {
  return `${origin}${AUTH_CALLBACK_PATH}`
}

// Removes tokens from the address bar once handled.
export function clearAuthCallbackFromUrl(): void {
  if (typeof window !== "undefined") window.history.replaceState(null, "", "/admin")
}
