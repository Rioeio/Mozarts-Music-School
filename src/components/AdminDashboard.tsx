import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Enquiry, EnquiryStatus, StaffMember, StaffRole } from "../lib/types"
import { initialAuthCallback } from "../lib/supabase"
import { appConfig } from "../lib/config"
import { adminBackend, MembershipStatus, MIN_PASSWORD_LENGTH, PermissionError, StaffAction } from "../lib/adminBackend"
import { authErrorMessage, clearAuthCallbackFromUrl, type AuthLinkType } from "../lib/authCallback"
import { exportEnquiriesToCsv, downloadCsvFile } from "../lib/csv"

type AuthView = "loading" | "signin" | "set_password" | "dashboard"

// Email links are single-use; handle the one in the URL once per page load
// (React StrictMode runs effects twice in development).
let authCallbackConsumed = false

function membershipMessage(status: MembershipStatus): string {
  switch (status) {
    case "revoked":
      return "Access revoked: This account is no longer authorized."
    case "expired":
      return "Your invitation has expired. Ask an administrator to resend it."
    case "pending":
      return "Your invitation has not been activated yet. Use the link in your invitation email."
    default:
      return "Access denied: Your account is not in the authorized staff directory."
  }
}

export default function AdminDashboard({ onExit }: { onExit: () => void }) {
  const backend = adminBackend

  // Auth state. currentUser comes from the database membership check, never from
  // the browser session alone.
  const [currentUser, setCurrentUser] = useState<{ id: string; staffId: string; email: string; role: StaffRole; name: string } | null>(null)
  const [authView, setAuthView] = useState<AuthView>(backend ? "loading" : "signin")
  const [authEmail, setAuthEmail] = useState("")
  const [authPassword, setAuthPassword] = useState("")
  const [authLoading, setAuthLoading] = useState(false)
  const [authError, setAuthError] = useState<string | null>(null)
  const [passwordResetSent, setPasswordResetSent] = useState(false)

  // Password setup after an invitation or recovery link
  const [passwordMode, setPasswordMode] = useState<AuthLinkType>("invite")
  const [newPassword, setNewPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  // True while an invite/recovery session must set a password before entering.
  const pendingPasswordRef = useRef(false)

  // Navigation tab: 'enquiries' or 'staff'
  const [currentTab, setCurrentTab] = useState<"enquiries" | "staff">("enquiries")

  // Enquiries & management state
  const [enquiries, setEnquiries] = useState<Enquiry[]>([])
  const [selectedEnquiry, setSelectedEnquiry] = useState<Enquiry | null>(null)
  const [loadingData, setLoadingData] = useState(false)
  const [actionMessage, setActionMessage] = useState<string | null>(null)

  // Filters & Search for Enquiries
  const [searchQuery, setSearchQuery] = useState("")
  const [filterType, setFilterType] = useState<string>("all")
  const [filterStatus, setFilterStatus] = useState<string>("all")
  const [filterInstrument, setFilterInstrument] = useState<string>("all")

  // Note authoring state
  const [newNoteText, setNewNoteText] = useState("")
  const [isSubmittingNote, setIsSubmittingNote] = useState(false)

  // Deletion confirmation state
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null)

  // Staff Management state
  const [staffMembers, setStaffMembers] = useState<StaffMember[]>([])
  const [loadingStaff, setLoadingStaff] = useState(false)
  const [showInviteForm, setShowInviteForm] = useState(false)
  const [inviteName, setInviteName] = useState("")
  const [inviteEmail, setInviteEmail] = useState("")
  const [inviteRole, setInviteRole] = useState<StaffRole>("staff")
  const [inviteLoading, setInviteLoading] = useState(false)
  const [inviteError, setInviteError] = useState<string | null>(null)
  const [inviteSuccess, setInviteSuccess] = useState<string | null>(null)
  const [revokeConfirmId, setRevokeConfirmId] = useState<string | null>(null)
  const [staffActionId, setStaffActionId] = useState<string | null>(null)

  const isAdmin = currentUser?.role === "admin"

  const clearSession = useCallback(() => {
    setCurrentUser(null)
    setSelectedEnquiry(null)
    setEnquiries([])
    setStaffMembers([])
  }, [])

  // Asks the database who the signed-in user is. Called on load, sign-in, token
  // refresh, focus and whenever the database refuses an action.
  const refreshMembership = useCallback(async () => {
    if (!backend || pendingPasswordRef.current) return
    try {
      if (!(await backend.hasSession())) {
        clearSession()
        setAuthView("signin")
        return
      }
      const membership = await backend.resolveMembership()
      if (membership.status === "active" && membership.staff) {
        const staff = membership.staff
        setCurrentUser((previous) =>
          previous && previous.id === staff.userId && previous.role === staff.role && previous.name === staff.name
            ? previous
            : { id: staff.userId, staffId: staff.staffId, email: staff.email, role: staff.role, name: staff.name },
        )
        setAuthView("dashboard")
        return
      }
      if (membership.status === "password_required") {
        pendingPasswordRef.current = true
        setPasswordMode("invite")
        setAuthView("set_password")
        return
      }
      await backend.signOut()
      clearSession()
      setAuthError(membershipMessage(membership.status))
      setAuthView("signin")
    } catch (err: any) {
      clearSession()
      setAuthError("Could not verify your access: " + (err?.message || "unknown error"))
      setAuthView("signin")
    }
  }, [backend, clearSession])

  // Session bootstrap, email-link callbacks and auth events
  useEffect(() => {
    if (!backend) return
    const unsubscribe = backend.onAuthChange((event) => {
      if (event === "SIGNED_OUT") {
        pendingPasswordRef.current = false
        clearSession()
        setAuthView("signin")
      } else if (event === "PASSWORD_RECOVERY") {
        pendingPasswordRef.current = true
        setPasswordMode("recovery")
        setAuthView("set_password")
      } else if (event === "SIGNED_IN" || event === "TOKEN_REFRESHED" || event === "USER_UPDATED") {
        refreshMembership()
      }
    })

    async function start() {
      const callback = authCallbackConsumed ? ({ kind: "none" } as const) : initialAuthCallback
      authCallbackConsumed = true
      try {
        if (callback.kind === "error") {
          setAuthError(authErrorMessage(callback))
          clearAuthCallbackFromUrl()
        } else if (callback.kind === "token_hash") {
          pendingPasswordRef.current = true
          await backend!.verifyEmailLink(callback.tokenHash, callback.type)
          clearAuthCallbackFromUrl()
          setPasswordMode(callback.type)
          setAuthView("set_password")
          return
        } else if (callback.kind === "session") {
          clearAuthCallbackFromUrl()
          if (callback.type) {
            pendingPasswordRef.current = true
            if (await backend!.hasSession()) {
              setPasswordMode(callback.type)
              setAuthView("set_password")
              return
            }
            pendingPasswordRef.current = false
          }
        }
      } catch (err: any) {
        pendingPasswordRef.current = false
        clearAuthCallbackFromUrl()
        setAuthError("This link could not be verified: " + (err?.message || "it may have expired") + ". Request a new one below or ask an administrator to resend your invitation.")
      }
      await refreshMembership()
    }
    start()

    return unsubscribe
  }, [backend, clearSession, refreshMembership])

  // Authorization can change while the dashboard is open; re-check on focus.
  useEffect(() => {
    if (authView !== "dashboard") return
    const onFocus = () => refreshMembership()
    window.addEventListener("focus", onFocus)
    const interval = window.setInterval(onFocus, 5 * 60 * 1000)
    return () => {
      window.removeEventListener("focus", onFocus)
      window.clearInterval(interval)
    }
  }, [authView, refreshMembership])

  // Shows the failure; a permission failure triggers a membership re-check.
  const reportFailure = (prefix: string, err: any) => {
    setActionMessage(`${prefix}: ${err?.message || "unknown error"}`)
    if (err instanceof PermissionError) refreshMembership()
  }

  // Load enquiries
  const fetchEnquiries = async () => {
    if (!currentUser || !backend) return
    setLoadingData(true)
    try {
      const items = await backend.listEnquiries(currentUser.role === "admin")
      setEnquiries(items)
      setSelectedEnquiry((selected) => (selected ? items.find((e) => e.id === selected.id) ?? null : null))
    } catch (err: any) {
      console.error("Failed to load enquiries:", err)
      reportFailure("Error fetching enquiries", err)
    } finally {
      setLoadingData(false)
    }
  }

  // Load staff
  const fetchStaff = async () => {
    if (!currentUser || !backend || currentUser.role !== "admin") return
    setLoadingStaff(true)
    try {
      setStaffMembers(await backend.listStaff())
    } catch (err: any) {
      console.error("Failed to load staff members:", err)
      reportFailure("Error fetching staff", err)
    } finally {
      setLoadingStaff(false)
    }
  }

  useEffect(() => {
    if (currentUser) {
      fetchEnquiries()
      fetchStaff()
    }
  }, [currentUser])

  // Sign In handler
  const handleSignIn = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!backend) return
    setAuthLoading(true)
    setAuthError(null)
    try {
      await backend.signIn(authEmail, authPassword)
      setAuthPassword("")
      await refreshMembership()
    } catch (err: any) {
      setAuthError(err?.message || "An unexpected error occurred.")
    } finally {
      setAuthLoading(false)
    }
  }

  // Demo mode only
  const handleQuickLogin = async (role: StaffRole) => {
    if (!backend?.quickLogin) return
    setAuthError(null)
    try {
      await backend.quickLogin(role)
      await refreshMembership()
    } catch (err: any) {
      setAuthError(err?.message || "Demo sign-in failed.")
    }
  }

  // Password Recovery handler
  const handlePasswordReset = async () => {
    if (!backend) return
    if (!authEmail) {
      setAuthError("Please enter your staff email above to request a reset link.")
      return
    }
    setAuthLoading(true)
    setAuthError(null)
    try {
      await backend.requestPasswordReset(authEmail)
      setPasswordResetSent(true)
    } catch (err: any) {
      setAuthError(err?.message || "Could not send a reset link. Please try again later.")
    } finally {
      setAuthLoading(false)
    }
  }

  // New password after an invitation or recovery link
  const handleSetPassword = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!backend) return
    setAuthError(null)
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      setAuthError(`Please choose a password of at least ${MIN_PASSWORD_LENGTH} characters.`)
      return
    }
    if (newPassword !== confirmPassword) {
      setAuthError("The two passwords do not match.")
      return
    }
    setAuthLoading(true)
    try {
      await backend.updatePassword(newPassword)
      setNewPassword("")
      setConfirmPassword("")
      pendingPasswordRef.current = false
      await refreshMembership()
    } catch (err: any) {
      setAuthError(err?.message || "Could not save your password. Please try again.")
    } finally {
      setAuthLoading(false)
    }
  }

  // Sign out handler
  const handleSignOut = async () => {
    pendingPasswordRef.current = false
    await backend?.signOut()
    clearSession()
    setAuthView("signin")
  }

  // Update Enquiry Status handler
  const handleStatusChange = async (enquiryId: string, newStatus: EnquiryStatus) => {
    if (!backend) return
    try {
      await backend.updateStatus(enquiryId, newStatus)
      fetchEnquiries()
    } catch (err: any) {
      reportFailure("Failed to update status", err)
    }
  }

  // Add Note handler
  const handleAddNote = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!selectedEnquiry || !newNoteText.trim() || !currentUser || !backend) return

    setIsSubmittingNote(true)
    try {
      await backend.addNote(selectedEnquiry.id, newNoteText.trim())
      setNewNoteText("")
      fetchEnquiries()
    } catch (err: any) {
      reportFailure("Error saving note", err)
    } finally {
      setIsSubmittingNote(false)
    }
  }

  // Delete Enquiry handler (admin only; enforced by the database)
  const handleDeleteEnquiry = async (id: string) => {
    if (!backend) return
    try {
      await backend.deleteEnquiry(id)
      setDeleteConfirmId(null)
      if (selectedEnquiry?.id === id) setSelectedEnquiry(null)
      fetchEnquiries()
    } catch (err: any) {
      reportFailure("Failed to delete record", err)
    }
  }

  // Retry notification handler (admin only; enforced by the database)
  const handleRetryNotification = async (jobId: string) => {
    if (!backend) return
    try {
      await backend.retryNotification(jobId)
      setActionMessage("Notification re-queued for delivery.")
      fetchEnquiries()
    } catch (err: any) {
      reportFailure("Failed to queue retry", err)
    }
  }

  // -------------------------------------------------------------
  // Staff Management Actions (Admin Only, performed by the manage-staff Edge Function)
  // -------------------------------------------------------------
  const runStaffAction = async (request: StaffAction, staffId: string | null) => {
    if (!backend) throw new Error("Staff management is unavailable.")
    setStaffActionId(staffId)
    try {
      return await backend.manageStaff(request)
    } finally {
      setStaffActionId(null)
      fetchStaff()
    }
  }

  const handleInviteStaff = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!currentUser || currentUser.role !== "admin") {
      setInviteError("Unauthorized: Only administrators can invite new staff members.")
      return
    }

    if (!inviteName.trim()) {
      setInviteError("Please provide the staff member's full name.")
      return
    }

    if (!inviteEmail.trim() || !inviteEmail.includes("@")) {
      setInviteError("Please provide a valid email address.")
      return
    }

    setInviteLoading(true)
    setInviteError(null)
    setInviteSuccess(null)

    try {
      const message = await runStaffAction({ action: "invite", name: inviteName.trim(), email: inviteEmail.trim().toLowerCase(), role: inviteRole }, null)
      setInviteSuccess(message)
      setInviteName("")
      setInviteEmail("")
      setShowInviteForm(false)
    } catch (err: any) {
      setInviteError(err?.message || "Failed to invite staff member.")
    } finally {
      setInviteLoading(false)
    }
  }

  const handleResendInvite = async (id: string) => {
    if (!isAdmin) return
    try {
      setActionMessage(await runStaffAction({ action: "resend", staffId: id }, id))
    } catch (err: any) {
      setActionMessage("Failed to resend invitation: " + err.message)
    }
  }

  const handleRevokeStaff = async (id: string) => {
    if (!isAdmin) return
    try {
      setActionMessage(await runStaffAction({ action: "revoke", staffId: id }, id))
      setRevokeConfirmId(null)
    } catch (err: any) {
      setActionMessage("Failed to revoke staff access: " + err.message)
    }
  }

  const handleReactivateStaff = async (id: string) => {
    if (!isAdmin) return
    try {
      setActionMessage(await runStaffAction({ action: "reactivate", staffId: id }, id))
    } catch (err: any) {
      setActionMessage("Failed to restore access: " + err.message)
    }
  }

  // Filtered and searched enquiries
  const filteredEnquiries = useMemo(() => {
    return enquiries.filter((item) => {
      if (filterType !== "all" && item.type !== filterType) return false
      if (filterStatus !== "all" && item.status !== filterStatus) return false
      if (filterInstrument !== "all" && item.instrument !== filterInstrument) return false

      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase()
        const matchesName = item.contact_name?.toLowerCase().includes(q)
        const matchesEmail = item.email?.toLowerCase().includes(q)
        const matchesPhone = item.phone?.toLowerCase().includes(q)
        const matchesMsg = item.message?.toLowerCase().includes(q)
        if (!matchesName && !matchesEmail && !matchesPhone && !matchesMsg) return false
      }

      return true
    })
  }, [enquiries, filterType, filterStatus, filterInstrument, searchQuery])

  // CSV Export handler
  const handleExportCsv = () => {
    const csvContent = exportEnquiriesToCsv(filteredEnquiries)
    downloadCsvFile(csvContent, `mozart-school-enquiries-${new Date().toISOString().split("T")[0]}.csv`)
  }

  // -------------------------------------------------------------
  // VIEW: Login Screen
  // -------------------------------------------------------------
  if (authView !== "dashboard" || !currentUser) {
    return (
      <div className="min-h-screen bg-white text-black flex flex-col justify-center items-center p-4 sm:p-6 selection:bg-black selection:text-white">
        <div className="w-full max-w-md border border-black p-6 sm:p-10 shadow-lg">
          <div className="text-center mb-8">
            <span className="inline-block text-3xl font-serif mb-1">M</span>
            <p className="text-[10px] tracking-[0.25em] font-semibold text-neutral-500 uppercase">
              Mozart School Of Western Classical Music
            </p>
            <h1 className="text-[clamp(1.625rem,7vw,2rem)] leading-[1.15] tracking-[-0.01em] font-serif font-medium mt-3">
              Staff Administration
            </h1>
            <p className="text-xs text-neutral-600 mt-2">
              Invite-only portal for school staff and enquiry management.
            </p>
            {backend?.kind === "mock" && (
              <div className="mt-4 p-3 bg-neutral-100 border border-black/20 text-[11px] text-neutral-700 text-left space-y-2">
                <p className="font-semibold text-black">Demo Mode (local development only):</p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => handleQuickLogin("admin")}
                    className="flex-1 py-1.5 px-2 bg-black text-white text-[10px] uppercase tracking-wider font-medium hover:bg-neutral-800 transition"
                  >
                    Login as Admin
                  </button>
                  <button
                    type="button"
                    onClick={() => handleQuickLogin("staff")}
                    className="flex-1 py-1.5 px-2 border border-black text-black text-[10px] uppercase tracking-wider font-medium hover:bg-neutral-100 transition"
                  >
                    Login as Staff
                  </button>
                </div>
                <p className="text-[10px] text-neutral-500">
                  Demo data is stored only in this browser. Nothing is sent to the school.
                </p>
              </div>
            )}
          </div>

          {authError && (
            <div className="mb-6 p-3 bg-neutral-100 border-l-2 border-black text-xs text-black">
              {authError}
            </div>
          )}

          {!backend ? (
            <div className="mb-6 p-4 bg-neutral-100 text-xs text-neutral-800 space-y-2 border border-black/20">
              <p className="font-semibold text-black">Staff dashboard unavailable</p>
              <p>This site has not been configured with its Supabase project, so sign-in is disabled.</p>
              <p className="text-[11px] text-neutral-600">
                Missing or invalid build settings: {appConfig.errors.join(", ")}. See DEPLOYMENT.md.
              </p>
            </div>
          ) : authView === "loading" ? (
            <p className="mb-6 text-xs text-neutral-600 text-center">Checking your session…</p>
          ) : authView === "set_password" ? (
            <form onSubmit={handleSetPassword} className="space-y-4 text-xs">
              <div className="p-3 bg-neutral-100 border border-black/20 text-[11px] text-neutral-700">
                <p className="font-semibold text-black">
                  {passwordMode === "invite" ? "Welcome — choose a password to activate your staff access" : "Set a new password"}
                </p>
                <p className="mt-0.5">At least {MIN_PASSWORD_LENGTH} characters. You will use it with your email to sign in.</p>
              </div>
              <div>
                <label className="block text-[11px] font-semibold uppercase tracking-wider mb-1">
                  New Password
                </label>
                <input
                  type="password"
                  required
                  autoComplete="new-password"
                  minLength={MIN_PASSWORD_LENGTH}
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  className="w-full border border-black/30 p-2 text-xs focus:outline-hidden focus:border-black"
                />
              </div>
              <div>
                <label className="block text-[11px] font-semibold uppercase tracking-wider mb-1">
                  Confirm Password
                </label>
                <input
                  type="password"
                  required
                  autoComplete="new-password"
                  minLength={MIN_PASSWORD_LENGTH}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  className="w-full border border-black/30 p-2 text-xs focus:outline-hidden focus:border-black"
                />
              </div>
              <div className="pt-2 space-y-2">
                <button
                  type="submit"
                  disabled={authLoading}
                  className="w-full py-2.5 bg-black text-white text-xs font-semibold uppercase tracking-wider hover:bg-neutral-800 transition disabled:opacity-50"
                >
                  {authLoading ? "Saving..." : passwordMode === "invite" ? "Save Password & Continue" : "Save New Password"}
                </button>
                <button
                  type="button"
                  onClick={handleSignOut}
                  className="w-full text-[11px] text-neutral-600 hover:text-black underline"
                >
                  Cancel and sign out
                </button>
              </div>
            </form>
          ) : passwordResetSent ? (
            <div className="mb-6 p-4 bg-neutral-100 text-xs text-neutral-800 space-y-2 border border-black/20">
              <p className="font-semibold text-black">Password reset requested</p>
              <p>If a staff account exists for {authEmail}, a password reset link has been emailed. It opens this dashboard so you can choose a new password.</p>
              <button
                type="button"
                onClick={() => setPasswordResetSent(false)}
                className="text-[11px] font-semibold underline mt-2 block"
              >
                Back to sign in
              </button>
            </div>
          ) : (
            <form onSubmit={handleSignIn} className="space-y-4 text-xs">
              <div>
                <label className="block text-[11px] font-semibold uppercase tracking-wider mb-1">
                  Staff Email
                </label>
                <input
                  type="email"
                  required
                  value={authEmail}
                  onChange={(e) => setAuthEmail(e.target.value)}
                  placeholder="srinivaschetty@gmail.com"
                  className="w-full border border-black/30 p-2 text-xs focus:outline-hidden focus:border-black"
                />
              </div>

              <div>
                <div className="flex justify-between items-center mb-1">
                  <label className="text-[11px] font-semibold uppercase tracking-wider">
                    Password
                  </label>
                  <button
                    type="button"
                    onClick={handlePasswordReset}
                    className="text-[10px] text-neutral-500 hover:text-black underline"
                  >
                    Forgot?
                  </button>
                </div>
                <input
                  type="password"
                  required
                  value={authPassword}
                  onChange={(e) => setAuthPassword(e.target.value)}
                  placeholder="••••••••"
                  className="w-full border border-black/30 p-2 text-xs focus:outline-hidden focus:border-black"
                />
              </div>

              <div className="pt-2">
                <button
                  type="submit"
                  disabled={authLoading}
                  className="w-full py-2.5 bg-black text-white text-xs font-semibold uppercase tracking-wider hover:bg-neutral-800 transition disabled:opacity-50"
                >
                  {authLoading ? "Authenticating..." : "Sign In to Dashboard"}
                </button>
              </div>
            </form>
          )}

          <div className="mt-8 pt-4 border-t border-black/15 text-center">
            <button
              type="button"
              onClick={onExit}
              className="text-xs text-neutral-600 hover:text-black hover:underline"
            >
              ← Return to public website
            </button>
          </div>
        </div>
      </div>
    )
  }

  // -------------------------------------------------------------
  // VIEW: Main Authenticated Dashboard
  // -------------------------------------------------------------
  return (
    <div className="min-h-screen bg-white text-black font-sans flex flex-col">
      {/* Top Header */}
      <header className="border-b border-black px-6 py-4 flex flex-wrap justify-between items-center gap-4 bg-white sticky top-0 z-20">
        <div className="flex items-center gap-4">
          <span className="font-serif text-2xl font-semibold">M</span>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="font-sans text-sm font-semibold tracking-wide uppercase">
                Mozart School Administration
              </h1>
              <span className={`px-2 py-0.5 text-[9px] uppercase tracking-wider font-semibold ${
                currentUser.role === "admin"
                  ? "bg-black text-white"
                  : "border border-black text-black"
              }`}>
                {currentUser.role === "admin" ? "Admin" : "Staff"}
              </span>
            </div>
            <p className="text-[11px] text-neutral-600 mt-0.5">
              Logged in as <span className="font-medium text-black">{currentUser.email}</span>
              {" "}·{" "}
              <span className="inline-block px-1.5 py-0.2 border border-black/30 text-[9px] uppercase tracking-wider">
                {backend?.kind === "mock" ? "Demo Mode · Browser Only" : "Live Supabase"}
              </span>
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {currentTab === "enquiries" && (
            <button
              type="button"
              onClick={handleExportCsv}
              className="px-3 py-1.5 border border-black text-xs font-medium hover:bg-neutral-100 transition flex items-center gap-1.5"
              title="Export filtered records safe from formula injection"
            >
              <span>↓</span> Export Safe CSV
            </button>
          )}
          <button
            type="button"
            onClick={onExit}
            className="px-3 py-1.5 border border-black/30 text-xs font-medium hover:bg-neutral-100 transition"
          >
            Public Site
          </button>
          <button
            type="button"
            onClick={handleSignOut}
            className="px-3 py-1.5 bg-black text-white text-xs font-medium hover:bg-neutral-800 transition"
          >
            Sign Out
          </button>
        </div>
      </header>

      {/* Tab Navigation */}
      <div className="flex border-b border-black bg-white px-2 sm:px-6 overflow-x-auto">
        <button
          type="button"
          onClick={() => setCurrentTab("enquiries")}
          className={`py-3 px-3 sm:px-5 whitespace-nowrap text-xs font-semibold uppercase tracking-wider border-b-2 transition -mb-px flex items-center gap-2 ${
            currentTab === "enquiries"
              ? "border-black text-black"
              : "border-transparent text-neutral-500 hover:text-black"
          }`}
        >
          <span>Enquiries</span>
          <span className="px-1.5 py-0.2 bg-neutral-100 text-black text-[10px] border border-black/20">
            {enquiries.length}
          </span>
        </button>
        <button
          type="button"
          onClick={() => setCurrentTab("staff")}
          className={`py-3 px-3 sm:px-5 whitespace-nowrap text-xs font-semibold uppercase tracking-wider border-b-2 transition -mb-px flex items-center gap-2 ${
            currentTab === "staff"
              ? "border-black text-black"
              : "border-transparent text-neutral-500 hover:text-black"
          }`}
        >
          <span>Staff Management</span>
          <span className="px-1.5 py-0.2 bg-neutral-100 text-black text-[10px] border border-black/20">
            {staffMembers.length}
          </span>
          {currentUser.role !== "admin" && (
            <span className="text-[9px] uppercase tracking-wider text-neutral-400 font-normal">
              (Admin Only)
            </span>
          )}
        </button>
      </div>

      {/* Action Notification Banner */}
      {actionMessage && (
        <div className="bg-neutral-100 border-b border-black/20 px-6 py-2 text-xs flex justify-between items-center">
          <span>{actionMessage}</span>
          <button
            type="button"
            onClick={() => setActionMessage(null)}
            className="text-neutral-500 hover:text-black font-bold ml-4"
          >
            ✕
          </button>
        </div>
      )}

      {/* ------------------------------------------------------------- */}
      {/* TAB 1: ENQUIRIES VIEW */}
      {/* ------------------------------------------------------------- */}
      {currentTab === "enquiries" && (
        <div className="flex-1 flex flex-col lg:flex-row overflow-hidden">
          {/* Left Column: Filter Controls and List */}
          <div className="w-full lg:w-5/12 xl:w-4/12 border-r border-black/20 flex flex-col h-auto lg:h-[calc(100vh-117px)] bg-neutral-50/50">
            {/* Search & Filter Toolbar */}
            <div className="p-4 border-b border-black/15 bg-white space-y-3">
              <div>
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search by name, email, phone, or message..."
                  className="w-full border border-black/30 p-2 text-xs focus:outline-hidden focus:border-black"
                />
              </div>

              <div className="grid grid-cols-3 gap-2 text-xs">
                <div>
                  <label className="block text-[10px] uppercase font-semibold text-neutral-500 mb-0.5">Type</label>
                  <select
                    value={filterType}
                    onChange={(e) => setFilterType(e.target.value)}
                    className="w-full border border-black/30 p-1.5 text-xs bg-white focus:outline-hidden"
                  >
                    <option value="all">All Types</option>
                    <option value="lesson">Lesson</option>
                    <option value="location_interest">Location</option>
                    <option value="general">General</option>
                  </select>
                </div>

                <div>
                  <label className="block text-[10px] uppercase font-semibold text-neutral-500 mb-0.5">Status</label>
                  <select
                    value={filterStatus}
                    onChange={(e) => setFilterStatus(e.target.value)}
                    className="w-full border border-black/30 p-1.5 text-xs bg-white focus:outline-hidden"
                  >
                    <option value="all">All Statuses</option>
                    <option value="new">New</option>
                    <option value="contacted">Contacted</option>
                    <option value="awaiting_reply">Awaiting Reply</option>
                    <option value="enrolled">Enrolled</option>
                    <option value="closed">Closed</option>
                    <option value="spam">Spam</option>
                  </select>
                </div>

                <div>
                  <label className="block text-[10px] uppercase font-semibold text-neutral-500 mb-0.5">Instrument</label>
                  <select
                    value={filterInstrument}
                    onChange={(e) => setFilterInstrument(e.target.value)}
                    className="w-full border border-black/30 p-1.5 text-xs bg-white focus:outline-hidden"
                  >
                    <option value="all">All</option>
                    <option value="piano">Piano</option>
                    <option value="keyboard">Keyboard</option>
                    <option value="violin">Violin</option>
                    <option value="unsure">Unsure</option>
                  </select>
                </div>
              </div>

              <div className="flex justify-between items-center text-[11px] text-neutral-500 pt-1">
                <span>Showing {filteredEnquiries.length} of {enquiries.length} enquiries</span>
                {loadingData && <span>Refreshing...</span>}
              </div>
            </div>

            {/* Enquiry List */}
            <div className="flex-1 overflow-y-auto divide-y divide-black/10">
              {filteredEnquiries.length === 0 ? (
                <div className="p-8 text-center text-xs text-neutral-500">
                  No matching enquiries found.
                </div>
              ) : (
                filteredEnquiries.map((item) => {
                  const isSelected = selectedEnquiry?.id === item.id
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => setSelectedEnquiry(item)}
                      className={`w-full text-left p-4 transition flex flex-col gap-1.5 ${
                        isSelected
                          ? "bg-black text-white"
                          : "hover:bg-neutral-100 text-black bg-white"
                      }`}
                    >
                      <div className="flex items-center justify-between text-[11px]">
                        <span className={`font-semibold ${isSelected ? "text-white" : "text-black"}`}>
                          {item.contact_name}
                        </span>
                        <span className={`text-[10px] ${isSelected ? "text-neutral-300" : "text-neutral-500"}`}>
                          {new Date(item.created_at).toLocaleDateString()}
                        </span>
                      </div>

                      <div className="flex items-center gap-1.5 text-[10px] flex-wrap">
                        <span
                          className={`px-1.5 py-0.5 font-medium uppercase tracking-wider ${
                            item.status === "new"
                              ? isSelected ? "bg-white text-black" : "bg-black text-white"
                              : isSelected ? "border border-neutral-400 text-neutral-200" : "border border-black/30 text-neutral-700"
                          }`}
                        >
                          {item.status}
                        </span>

                        <span className={`capitalize ${isSelected ? "text-neutral-300" : "text-neutral-600"}`}>
                          {item.type.replace("_", " ")}
                        </span>

                        {item.instrument && (
                          <span className={`capitalize ${isSelected ? "text-neutral-300" : "text-neutral-600"}`}>
                            · {item.instrument}
                          </span>
                        )}

                        {item.class_preference && (
                          <span className={`capitalize px-1 py-0.2 border text-[9px] ${
                            isSelected ? "border-neutral-400 text-neutral-200" : "border-black/30 text-neutral-700"
                          }`}>
                            {item.class_preference.replace("_", " ")}
                          </span>
                        )}
                      </div>

                      {item.message && (
                        <p className={`text-[11px] line-clamp-1 mt-0.5 ${isSelected ? "text-neutral-300" : "text-neutral-500"}`}>
                          {item.message}
                        </p>
                      )}
                    </button>
                  )
                })
              )}
            </div>
          </div>

          {/* Right Column: Detailed View */}
          <div className="flex-1 h-auto lg:h-[calc(100vh-117px)] overflow-y-auto p-6 lg:p-8 bg-white">
            {!selectedEnquiry ? (
              <div className="h-full flex flex-col items-center justify-center text-center p-8 text-neutral-400">
                <span className="text-4xl font-serif mb-2">♪</span>
                <p className="text-sm font-serif">Select an enquiry to view details</p>
                <p className="text-xs text-neutral-500 max-w-sm mt-1">
                  Manage contact status, review musical preferences, author private staff notes, and inspect notification delivery outcomes.
                </p>
              </div>
            ) : (
              <div className="max-w-3xl space-y-8">
                {/* Header Info */}
                <div className="border-b border-black pb-6 flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <div className="flex items-center gap-2 text-[10px] tracking-wider uppercase font-semibold text-neutral-500 mb-1">
                      <span>Enquiry ID: {selectedEnquiry.id}</span>
                      <span>·</span>
                      <span>Source: {selectedEnquiry.source}</span>
                    </div>
                    <h2 className="text-2xl font-serif font-medium">
                      {selectedEnquiry.contact_name}
                    </h2>
                    <p className="text-xs text-neutral-600 mt-1">
                      Submitted on {new Date(selectedEnquiry.created_at).toLocaleString()}
                    </p>
                  </div>

                  {/* Status Selector */}
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-neutral-600">
                      Status:
                    </span>
                    <select
                      value={selectedEnquiry.status}
                      onChange={(e) => handleStatusChange(selectedEnquiry.id, e.target.value as EnquiryStatus)}
                      className="border border-black p-1.5 text-xs font-semibold uppercase tracking-wider bg-white focus:outline-hidden"
                    >
                      <option value="new">New</option>
                      <option value="contacted">Contacted</option>
                      <option value="awaiting_reply">Awaiting Reply</option>
                      <option value="enrolled">Enrolled</option>
                      <option value="closed">Closed</option>
                      <option value="spam">Spam</option>
                    </select>
                  </div>
                </div>

                {/* Action Buttons: Click-to-call, click-to-email */}
                <div className="flex flex-wrap gap-3">
                  {selectedEnquiry.phone && (
                    <a
                      href={`tel:${selectedEnquiry.phone}`}
                      className="px-4 py-2 bg-black text-white text-xs font-semibold tracking-wider uppercase hover:bg-neutral-800 transition flex items-center gap-2"
                    >
                      <span>📞</span> Call {selectedEnquiry.phone}
                    </a>
                  )}
                  {selectedEnquiry.email && (
                    <a
                      href={`mailto:${selectedEnquiry.email}?subject=Mozart%20School%20Follow-up`}
                      className="px-4 py-2 border border-black text-xs font-semibold tracking-wider uppercase hover:bg-neutral-100 transition flex items-center gap-2"
                    >
                      <span>✉</span> Email {selectedEnquiry.email}
                    </a>
                  )}
                </div>

                {/* Main Details Grid */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 bg-neutral-50 p-6 border border-black/15 text-xs">
                  <div>
                    <span className="block text-[10px] uppercase font-semibold text-neutral-500 mb-0.5">
                      Contact Information
                    </span>
                    <p><strong>Name:</strong> {selectedEnquiry.contact_name}</p>
                    <p><strong>Email:</strong> {selectedEnquiry.email || "—"}</p>
                    <p><strong>Phone:</strong> {selectedEnquiry.phone || "—"}</p>
                    <p><strong>Preferred Contact:</strong> <span className="capitalize">{selectedEnquiry.preferred_contact || "Either"}</span></p>
                  </div>

                  <div>
                    <span className="block text-[10px] uppercase font-semibold text-neutral-500 mb-0.5">
                      Musical Request
                    </span>
                    <p><strong>Type:</strong> <span className="capitalize">{selectedEnquiry.type.replace("_", " ")}</span></p>
                    <p><strong>Instrument:</strong> <span className="capitalize">{selectedEnquiry.instrument || "—"}</span></p>
                    <p><strong>Learner Group:</strong> <span className="capitalize">{selectedEnquiry.learner_group || "—"}</span></p>
                    {selectedEnquiry.learner_name && (
                      <p><strong>Learner First Name:</strong> {selectedEnquiry.learner_name}</p>
                    )}
                    <p><strong>Experience:</strong> <span className="capitalize">{selectedEnquiry.experience?.replace("_", " ") || "—"}</span></p>
                    <p className="mt-1">
                      <strong>Class Preference:</strong>{" "}
                      <span className="capitalize font-medium">
                        {selectedEnquiry.class_preference
                          ? selectedEnquiry.class_preference.replace("_", " ")
                          : "Not specified"}
                      </span>
                    </p>
                    {selectedEnquiry.class_preference === "in_person" && (
                      <p className="mt-0.5 text-[10px] text-neutral-600 italic">
                        In-person classes are coming soon — A welcoming new space is on the way.
                      </p>
                    )}
                  </div>

                  {selectedEnquiry.preferred_times && (
                    <div className="sm:col-span-2">
                      <span className="block text-[10px] uppercase font-semibold text-neutral-500 mb-0.5">
                        Preferred Days / Times
                      </span>
                      <p className="italic text-neutral-800">{selectedEnquiry.preferred_times}</p>
                    </div>
                  )}

                  {selectedEnquiry.message && (
                    <div className="sm:col-span-2">
                      <span className="block text-[10px] uppercase font-semibold text-neutral-500 mb-0.5">
                        Visitor Note / Message
                      </span>
                      <p className="bg-white p-3 border border-black/15 text-neutral-800 whitespace-pre-line">
                        {selectedEnquiry.message}
                      </p>
                    </div>
                  )}

                  <div className="sm:col-span-2 pt-2 border-t border-black/10 flex flex-wrap gap-4 text-[11px] text-neutral-600">
                    <span><strong>Contact Consent:</strong> Granted ({new Date(selectedEnquiry.consented_at).toLocaleDateString()})</span>
                    <span><strong>Location Updates:</strong> {selectedEnquiry.location_updates ? "Opted In" : "Not requested"}</span>
                    <span><strong>Consent Version:</strong> {selectedEnquiry.consent_version}</span>
                  </div>
                </div>

                {/* Notification Jobs Section (administrators only) */}
                {isAdmin && (
                <div className="space-y-3">
                  <h3 className="font-sans text-xs font-semibold uppercase tracking-wider text-black">
                    Transactional Notifications
                  </h3>
                  {selectedEnquiry.notification_jobs && selectedEnquiry.notification_jobs.length > 0 ? (
                    <div className="border border-black/15 divide-y divide-black/10 text-xs">
                      {selectedEnquiry.notification_jobs.map((job) => (
                        <div key={job.id} className="p-3 flex items-center justify-between gap-4">
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="font-semibold capitalize">
                                {job.kind.replace("_", " ")}:
                              </span>
                              <span className="text-neutral-600">{job.recipient}</span>
                              <span
                                className={`px-1.5 py-0.2 text-[9px] uppercase font-bold tracking-wider ${
                                  job.status === "sent"
                                    ? "bg-black text-white"
                                    : job.status === "failed"
                                    ? "bg-neutral-200 text-black border border-black"
                                    : "bg-neutral-100 text-neutral-700"
                                }`}
                              >
                                {job.status}
                              </span>
                            </div>
                            {job.last_error && (
                              <p className="text-[11px] text-neutral-600 mt-0.5">
                                Error: {job.last_error}
                              </p>
                            )}
                            <p className="text-[10px] text-neutral-400 mt-0.5">
                              Attempts: {job.attempts} · Subject: "{job.subject}"
                            </p>
                          </div>

                          {job.status === "failed" && (
                            <button
                              type="button"
                              onClick={() => handleRetryNotification(job.id)}
                              className="px-2.5 py-1 border border-black text-[10px] font-semibold uppercase hover:bg-neutral-100 transition"
                            >
                              Retry Send
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-xs text-neutral-500 italic">No notification records queued for this enquiry.</p>
                  )}
                </div>
                )}

                {/* Private Staff Notes */}
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <h3 className="font-sans text-xs font-semibold uppercase tracking-wider text-black">
                      Private Staff Notes
                    </h3>
                    <span className="text-[10px] text-neutral-500 italic">Staff access only · Never visible to visitors</span>
                  </div>

                  {/* Add new note form */}
                  <form onSubmit={handleAddNote} className="space-y-2">
                    <textarea
                      rows={2}
                      required
                      value={newNoteText}
                      onChange={(e) => setNewNoteText(e.target.value)}
                      placeholder="Record conversation outcome, trial date discussion, or teacher notes..."
                      className="w-full border border-black/30 p-2.5 text-xs text-black focus:outline-hidden focus:border-black resize-none"
                    />
                    <div className="flex justify-end">
                      <button
                        type="submit"
                        disabled={isSubmittingNote || !newNoteText.trim()}
                        className="px-4 py-1.5 bg-black text-white text-xs font-medium uppercase tracking-wider hover:bg-neutral-800 transition disabled:opacity-50"
                      >
                        {isSubmittingNote ? "Saving..." : "Add Private Note"}
                      </button>
                    </div>
                  </form>

                  {/* Notes List */}
                  <div className="space-y-2 pt-2">
                    {selectedEnquiry.notes && selectedEnquiry.notes.length > 0 ? (
                      selectedEnquiry.notes.map((note) => (
                        <div key={note.id} className="p-3 bg-neutral-100 border-l-2 border-black text-xs">
                          <div className="flex justify-between items-center text-[10px] text-neutral-500 mb-1">
                            <span className="font-semibold text-black">{note.admin_email || "Staff"}</span>
                            <span>{new Date(note.created_at).toLocaleString()}</span>
                          </div>
                          <p className="text-neutral-800 whitespace-pre-line">{note.note}</p>
                        </div>
                      ))
                    ) : (
                      <p className="text-xs text-neutral-500 italic">No notes recorded yet for this enquiry.</p>
                    )}
                  </div>
                </div>

                {/* Controlled Deletion Controls (GDPR / Privacy; administrators only) */}
                {isAdmin && (
                <div className="pt-8 border-t border-black/15 flex justify-between items-center">
                  <div>
                    <h4 className="text-xs font-semibold uppercase tracking-wider text-black">
                      Data Retention & Erasure
                    </h4>
                    <p className="text-[11px] text-neutral-500">
                      Permanently delete this enquiry and associated notes upon visitor request.
                    </p>
                  </div>

                  {deleteConfirmId === selectedEnquiry.id ? (
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => handleDeleteEnquiry(selectedEnquiry.id)}
                        className="px-3 py-1.5 bg-black text-white text-xs font-semibold uppercase tracking-wider hover:bg-neutral-800 transition"
                      >
                        Confirm Erase
                      </button>
                      <button
                        type="button"
                        onClick={() => setDeleteConfirmId(null)}
                        className="px-3 py-1.5 border border-black/30 text-xs hover:bg-neutral-100 transition"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setDeleteConfirmId(selectedEnquiry.id)}
                      className="px-3 py-1.5 border border-black/40 text-xs text-neutral-700 hover:text-black hover:border-black transition"
                    >
                      Delete Record
                    </button>
                  )}
                </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------- */}
      {/* TAB 2: STAFF MANAGEMENT VIEW */}
      {/* ------------------------------------------------------------- */}
      {currentTab === "staff" && (
        <div className="flex-1 p-6 lg:p-10 max-w-6xl mx-auto w-full">
          {currentUser.role !== "admin" ? (
            /* Staff role: Access denied notice */
            <div className="max-w-xl mx-auto py-16 text-center space-y-4">
              <span className="text-3xl font-serif">M</span>
              <h2 className="text-xl font-serif font-medium">Administrator Access Required</h2>
              <p className="text-xs text-neutral-600 leading-relaxed">
                You are currently signed in as <span className="font-semibold text-black">{currentUser.email}</span> with standard <strong>Staff</strong> permissions. Staff members can view all enquiries, update their status, and add private notes, but cannot delete enquiries, retry notifications, or invite, modify, or revoke staff accounts.
              </p>
              <div className="p-3 bg-neutral-100 border border-black/20 text-[11px] text-neutral-700 max-w-md mx-auto text-left">
                <strong>Need access changes?</strong> Contact authorized administrator Srinivas Chetty (<a href="mailto:srinivaschetty@gmail.com" className="underline font-medium">srinivaschetty@gmail.com</a>) to update team accounts.
              </div>
              <div className="pt-2">
                <button
                  type="button"
                  onClick={() => setCurrentTab("enquiries")}
                  className="px-5 py-2 bg-black text-white text-xs font-medium uppercase tracking-wider hover:bg-neutral-800 transition"
                >
                  Return to Enquiries
                </button>
              </div>
            </div>
          ) : (
            /* Admin role: Full Staff Management UI */
            <div className="space-y-8">
              {/* Header and Scope Statement */}
              <div className="border-b border-black pb-6 flex flex-wrap items-start justify-between gap-4">
                <div>
                  <p className="text-[10px] tracking-[0.2em] font-semibold text-neutral-500 uppercase">
                    Access Control & Directory
                  </p>
                  <h2 className="text-2xl font-serif font-medium mt-1">
                    School Staff Management
                  </h2>
                  <p className="text-xs text-neutral-600 mt-1 max-w-2xl">
                    Invite-only directory for school staff access only. Administrators can invite faculty by email, resend invitations, and revoke access.
                  </p>
                </div>

                <button
                  type="button"
                  onClick={() => {
                    setShowInviteForm(!showInviteForm)
                    setInviteError(null)
                    setInviteSuccess(null)
                  }}
                  className="px-4 py-2 bg-black text-white text-xs font-semibold uppercase tracking-wider hover:bg-neutral-800 transition flex items-center gap-2"
                >
                  <span>{showInviteForm ? "✕ Close Form" : "+ Invite Staff Member"}</span>
                </button>
              </div>

              {/* Strict Non-Scope Clarification Banner */}
              <div className="p-3 bg-neutral-50 border border-black/15 text-[11px] text-neutral-700 flex items-start gap-2.5">
                <span className="font-bold text-black">Notice:</span>
                <span>
                  This page is strictly for managing school staff access only. It does not handle students, payments, fees, attendance, lesson schedules, or bookings.
                </span>
              </div>

              {/* Success / Error notification for invitations */}
              {inviteSuccess && (
                <div className="p-3 bg-neutral-100 border-l-2 border-black text-xs text-black flex justify-between items-center">
                  <span>{inviteSuccess}</span>
                  <button
                    type="button"
                    onClick={() => setInviteSuccess(null)}
                    className="text-neutral-500 hover:text-black font-bold ml-4"
                  >
                    ✕
                  </button>
                </div>
              )}

              {inviteError && (
                <div className="p-3 bg-neutral-100 border-l-2 border-black text-xs text-black flex justify-between items-center">
                  <span>{inviteError}</span>
                  <button
                    type="button"
                    onClick={() => setInviteError(null)}
                    className="text-neutral-500 hover:text-black font-bold ml-4"
                  >
                    ✕
                  </button>
                </div>
              )}

              {/* Invite Form Drawer */}
              {showInviteForm && (
                <div className="border border-black p-6 bg-white shadow-sm space-y-4">
                  <div className="border-b border-black/15 pb-2 flex justify-between items-center">
                    <h3 className="font-sans text-xs font-semibold uppercase tracking-wider">
                      Invite a New School Staff Member
                    </h3>
                    <span className="text-[10px] text-neutral-500">Email Invitation Flow</span>
                  </div>

                  <form onSubmit={handleInviteStaff} className="space-y-4 text-xs">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div>
                        <label className="block text-[11px] font-semibold uppercase tracking-wider mb-1">
                          Full Name *
                        </label>
                        <input
                          type="text"
                          required
                          value={inviteName}
                          onChange={(e) => setInviteName(e.target.value)}
                          placeholder="e.g. Radhika K."
                          className="w-full border border-black/30 p-2 text-xs focus:outline-hidden focus:border-black"
                        />
                      </div>

                      <div>
                        <label className="block text-[11px] font-semibold uppercase tracking-wider mb-1">
                          Staff Email Address *
                        </label>
                        <input
                          type="email"
                          required
                          value={inviteEmail}
                          onChange={(e) => setInviteEmail(e.target.value)}
                          placeholder="e.g. radhika@mozartmusic.org"
                          className="w-full border border-black/30 p-2 text-xs focus:outline-hidden focus:border-black"
                        />
                      </div>
                    </div>

                    <div>
                      <label className="block text-[11px] font-semibold uppercase tracking-wider mb-1.5">
                        Assigned Role *
                      </label>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <label
                          className={`p-3 border cursor-pointer transition flex flex-col gap-1 ${
                            inviteRole === "staff"
                              ? "border-black bg-neutral-50"
                              : "border-black/20 hover:border-black/50"
                          }`}
                        >
                          <div className="flex items-center gap-2">
                            <input
                              type="radio"
                              name="invite_role"
                              checked={inviteRole === "staff"}
                              onChange={() => setInviteRole("staff")}
                              className="accent-black"
                            />
                            <span className="font-semibold text-black uppercase tracking-wider text-[11px]">Staff Role</span>
                          </div>
                          <p className="text-[10px] text-neutral-600 pl-5">
                            Can view enquiries, update status, and add private staff notes. Cannot manage other staff accounts.
                          </p>
                        </label>

                        <label
                          className={`p-3 border cursor-pointer transition flex flex-col gap-1 ${
                            inviteRole === "admin"
                              ? "border-black bg-neutral-50"
                              : "border-black/20 hover:border-black/50"
                          }`}
                        >
                          <div className="flex items-center gap-2">
                            <input
                              type="radio"
                              name="invite_role"
                              checked={inviteRole === "admin"}
                              onChange={() => setInviteRole("admin")}
                              className="accent-black"
                            />
                            <span className="font-semibold text-black uppercase tracking-wider text-[11px]">Admin Role</span>
                          </div>
                          <p className="text-[10px] text-neutral-600 pl-5">
                            Full privileges: Can manage enquiries and invite, resend, or revoke staff access.
                          </p>
                        </label>
                      </div>
                    </div>

                    <div className="flex justify-end gap-2 pt-2 border-t border-black/15">
                      <button
                        type="button"
                        onClick={() => setShowInviteForm(false)}
                        className="px-4 py-2 border border-black/30 text-xs font-medium hover:bg-neutral-100 transition"
                      >
                        Cancel
                      </button>
                      <button
                        type="submit"
                        disabled={inviteLoading}
                        className="px-6 py-2 bg-black text-white text-xs font-semibold uppercase tracking-wider hover:bg-neutral-800 transition disabled:opacity-50"
                      >
                        {inviteLoading ? "Sending Invitation..." : "Send Staff Invitation"}
                      </button>
                    </div>
                  </form>
                </div>
              )}

              {/* Staff Table */}
              <div className="border border-black overflow-hidden">
                <div className="p-4 bg-neutral-50 border-b border-black flex justify-between items-center text-xs">
                  <div>
                    <h3 className="font-sans font-semibold uppercase tracking-wider text-black">
                      Staff Directory ({staffMembers.length})
                    </h3>
                    <p className="text-[11px] text-neutral-500">
                      Authorised team members with dashboard access.
                    </p>
                  </div>
                  {loadingStaff && <span className="text-[11px] text-neutral-500">Refreshing...</span>}
                </div>

                {loadingStaff && staffMembers.length === 0 ? (
                  <div className="p-12 text-center text-xs text-neutral-500">
                    Loading staff directory...
                  </div>
                ) : staffMembers.length === 0 ? (
                  <div className="p-12 text-center text-xs text-neutral-500">
                    No staff members found. Click "+ Invite Staff Member" to add faculty.
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs border-collapse">
                      <thead>
                        <tr className="border-b border-black/20 bg-white text-[10px] uppercase font-semibold text-neutral-500 tracking-wider">
                          <th className="p-3.5 pl-4">Staff Name</th>
                          <th className="p-3.5">Email Address</th>
                          <th className="p-3.5">Role</th>
                          <th className="p-3.5">Invitation Status</th>
                          <th className="p-3.5">Date Added</th>
                          <th className="p-3.5 pr-4 text-right">Actions</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-black/10 bg-white">
                        {staffMembers.map((staff) => {
                          const isSelf = staff.user_id === currentUser.id
                          const busy = staffActionId === staff.id
                          return (
                            <tr key={staff.id} className="hover:bg-neutral-50/70 transition">
                              <td className="p-3.5 pl-4 font-semibold text-black">
                                <div className="flex items-center gap-2">
                                  <span>{staff.name}</span>
                                  {isSelf && (
                                    <span className="text-[9px] uppercase px-1 py-0.2 bg-neutral-200 text-black border border-black/20">
                                      You
                                    </span>
                                  )}
                                </div>
                              </td>
                              <td className="p-3.5 text-neutral-700">
                                {staff.email}
                              </td>
                              <td className="p-3.5">
                                <span className={`inline-block px-2 py-0.5 text-[10px] uppercase tracking-wider font-semibold ${
                                  staff.role === "admin"
                                    ? "bg-black text-white"
                                    : "border border-black text-black"
                                }`}>
                                  {staff.role === "admin" ? "Admin" : "Staff"}
                                </span>
                              </td>
                              <td className="p-3.5">
                                <span className={`inline-block px-2 py-0.5 text-[10px] uppercase tracking-wider font-medium ${
                                  staff.invitation_status === "active"
                                    ? "bg-black text-white"
                                    : staff.invitation_status === "invited"
                                    ? "border border-black/40 text-neutral-700 bg-neutral-100"
                                    : "border border-black/20 text-neutral-400 line-through"
                                }`}>
                                  {staff.invitation_status}
                                </span>
                              </td>
                              <td className="p-3.5 text-neutral-600 text-[11px]">
                                {new Date(staff.created_at).toLocaleDateString()}
                              </td>
                              <td className="p-3.5 pr-4 text-right space-x-2">
                                {staff.invitation_status === "invited" && (
                                  <button
                                    type="button"
                                    onClick={() => handleResendInvite(staff.id)}
                                    disabled={busy}
                                    className="px-2.5 py-1 border border-black text-[10px] uppercase font-semibold hover:bg-neutral-100 transition"
                                  >
                                    Resend Invite
                                  </button>
                                )}

                                {staff.invitation_status === "active" && !isSelf && (
                                  revokeConfirmId === staff.id ? (
                                    <span className="inline-flex items-center gap-1">
                                      <button
                                        type="button"
                                        onClick={() => handleRevokeStaff(staff.id)}
                                        disabled={busy}
                                        className="px-2 py-1 bg-black text-white text-[10px] uppercase font-semibold hover:bg-neutral-800 transition"
                                      >
                                        Confirm Revoke
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() => setRevokeConfirmId(null)}
                                        className="px-2 py-1 border border-black/30 text-[10px] hover:bg-neutral-100 transition"
                                      >
                                        Cancel
                                      </button>
                                    </span>
                                  ) : (
                                    <button
                                      type="button"
                                      onClick={() => setRevokeConfirmId(staff.id)}
                                      className="px-2.5 py-1 border border-black/40 text-[10px] uppercase font-medium hover:border-black hover:text-black transition"
                                    >
                                      Revoke Access
                                    </button>
                                  )
                                )}

                                {staff.invitation_status === "revoked" && !isSelf && (
                                  <button
                                    type="button"
                                    onClick={() => handleReactivateStaff(staff.id)}
                                    disabled={busy}
                                    className="px-2.5 py-1 border border-black text-[10px] uppercase font-semibold hover:bg-neutral-100 transition"
                                  >
                                    Reactivate
                                  </button>
                                )}

                                {isSelf && (
                                  <span className="text-[10px] text-neutral-400 italic">Current Session</span>
                                )}
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
