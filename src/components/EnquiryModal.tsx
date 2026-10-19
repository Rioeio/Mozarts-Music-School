import { useEffect, useRef, useState } from "react"
import { EnquiryType, InstrumentType, LearnerGroupType, ExperienceLevelType, ClassPreference } from "../lib/types"
import { generateIdempotencyKey, submitEnquiry } from "../lib/api"
import { appConfig } from "../lib/config"
import TurnstileWidget from "./TurnstileWidget"

interface EnquiryModalProps {
  isOpen: boolean
  onClose: () => void
  initialType?: EnquiryType
  initialInstrument?: InstrumentType
  source?: string
}

export default function EnquiryModal({
  isOpen,
  onClose,
  initialType = "lesson",
  initialInstrument,
  source = "website",
}: EnquiryModalProps) {
  const [type, setType] = useState<EnquiryType>(initialType)
  const [instrument, setInstrument] = useState<InstrumentType>(initialInstrument || "piano")
  const [learnerGroup, setLearnerGroup] = useState<LearnerGroupType>("child")
  const [learnerName, setLearnerName] = useState("")
  const [experience, setExperience] = useState<ExperienceLevelType>("beginner")
  const [classPreference, setClassPreference] = useState<ClassPreference>("online")
  const [contactName, setContactName] = useState("")
  const [email, setEmail] = useState("")
  const [phone, setPhone] = useState("")
  const [preferredContact, setPreferredContact] = useState<"email" | "phone" | "either">("either")
  const [preferredTimes, setPreferredTimes] = useState("")
  const [message, setMessage] = useState("")
  const [contactConsent, setContactConsent] = useState(false)
  const [locationUpdates, setLocationUpdates] = useState(false)
  const [honeypot, setHoneypot] = useState("")

  const [loading, setLoading] = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [successMsg, setSuccessMsg] = useState<string | null>(null)

  // Spam check token (single use) and a submission key reused across retries of
  // the same form, so a resubmitted request never creates a duplicate enquiry.
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null)
  const [turnstileReset, setTurnstileReset] = useState(0)
  const [idempotencyKey, setIdempotencyKey] = useState(generateIdempotencyKey)
  const needsTurnstile = appConfig.mode === "live"
  const unavailable = appConfig.mode === "misconfigured"

  // Sync state when props change
  useEffect(() => {
    if (isOpen) {
      setType(initialType)
      if (initialInstrument) {
        setInstrument(initialInstrument)
      }
      setErrorMsg(null)
      setSuccessMsg(null)
    }
  }, [isOpen, initialType, initialInstrument])

  const dialogRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)

  // Close on Escape key; keep Tab focus inside the dialog
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isOpen) return
      if (e.key === "Escape") {
        onClose()
      } else if (e.key === "Tab" && dialogRef.current) {
        const focusable = [
          ...dialogRef.current.querySelectorAll<HTMLElement>(
            'button:not([disabled]), [href], input:not([disabled]):not([tabindex="-1"]), textarea:not([disabled]), select:not([disabled]), iframe',
          ),
        ].filter((el) => el.offsetParent !== null)
        if (focusable.length === 0) return
        const first = focusable[0]
        const last = focusable[focusable.length - 1]
        const active = document.activeElement
        if (e.shiftKey && (active === first || active === dialogRef.current)) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && active === last) {
          e.preventDefault()
          first.focus()
        }
      }
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [isOpen, onClose])

  // While open: lock page scroll and move focus into the dialog; on close,
  // restore both (focus returns to the button that opened it).
  useEffect(() => {
    if (!isOpen) return
    const previousFocus = document.activeElement as HTMLElement | null
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = "hidden"
    dialogRef.current?.focus()
    return () => {
      document.body.style.overflow = previousOverflow
      previousFocus?.focus()
    }
  }, [isOpen])

  // A validation or server error is shown at the top of the scrolling body.
  useEffect(() => {
    if (errorMsg) bodyRef.current?.scrollTo({ top: 0 })
  }, [errorMsg])

  if (!isOpen) return null

  const headings: { id: EnquiryType; title: string; intro: string }[] = [
    {
      id: "lesson",
      title: "Make a Lesson Enquiry",
      intro: "Online and in-person classes are available. Tell us who is learning and what instrument calls to you.",
    },
    {
      id: "location_interest",
      title: "Register Your Location Interest",
      intro: "In-person classes are coming soon — A welcoming new space is on the way. Register your interest and we’ll keep you informed.",
    },
    {
      id: "general",
      title: "Send Us a Note",
      intro: "Have a question about our classical curriculum or teaching approach? We are here to help.",
    },
  ]

  const tabs: { id: EnquiryType; label: string }[] = [
    { id: "lesson", label: "Lesson Enquiry" },
    { id: "location_interest", label: "Location Interest" },
    { id: "general", label: "General Note" },
  ]

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setErrorMsg(null)

    if (!contactName.trim()) {
      setErrorMsg("Please enter your name.")
      return
    }

    if (!email.trim() && !phone.trim()) {
      setErrorMsg("Please provide at least one contact method (email or phone).")
      return
    }

    if (!contactConsent) {
      setErrorMsg("Please check the box to confirm consent to be contacted.")
      return
    }

    if (needsTurnstile && !turnstileToken) {
      setErrorMsg("Please complete the spam check before submitting.")
      return
    }

    setLoading(true)

    const payload = {
      type,
      contactName,
      email: email.trim() || undefined,
      phone: phone.trim() || undefined,
      preferredContact,
      instrument: type === "lesson" || type === "location_interest" ? instrument : undefined,
      learnerGroup: type === "lesson" ? learnerGroup : undefined,
      learnerName: type === "lesson" && (learnerGroup === "child" || learnerGroup === "teen") ? learnerName.trim() : undefined,
      experience: type === "lesson" ? experience : undefined,
      classPreference: type === "lesson" ? classPreference : undefined,
      preferredTimes: type === "lesson" ? preferredTimes.trim() : undefined,
      message: message.trim() || undefined,
      source,
      contactConsent,
      locationUpdates: type === "location_interest" ? true : locationUpdates,
      turnstileToken: turnstileToken || undefined,
      idempotencyKey,
      _hp: honeypot,
    }

    const res = await submitEnquiry(payload)
    setLoading(false)

    if (res.ok) {
      setSuccessMsg(res.message)
      setIdempotencyKey(generateIdempotencyKey())
    } else {
      setErrorMsg(res.message || "An unexpected error occurred. Please try again.")
    }
    // The server has consumed the token (or rejected it); get a fresh one.
    if (needsTurnstile && res.code !== "validation") {
      setTurnstileReset((n) => n + 1)
    }
  }

  const resetAndClose = () => {
    setSuccessMsg(null)
    setErrorMsg(null)
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-8 [@media(max-height:560px)]:p-3 bg-black/70 backdrop-blur-xs">
      {/* One fixed-size shell for every tab: header and actions stay put, the fields scroll. */}
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        tabIndex={-1}
        className="relative flex flex-col w-full max-w-[720px] h-[calc(100dvh-1.5rem)] sm:h-[calc(100dvh-4rem)] [@media(max-height:560px)]:h-[calc(100dvh-1.5rem)] bg-white text-black border border-black shadow-2xl overflow-hidden focus:outline-hidden"
      >
        {/* Close Button */}
        <button
          type="button"
          onClick={resetAndClose}
          className="absolute z-10 top-3 right-3 sm:top-5 sm:right-5 text-xl font-light hover:opacity-60 transition-opacity p-2 leading-none focus-visible:outline-2 focus-visible:outline-black"
          aria-label="Close form"
        >
          ✕
        </button>

        {successMsg ? (
          <div className="flex-1 min-h-0 overflow-y-auto px-5 sm:px-10 py-10 flex flex-col items-center justify-center text-center space-y-5">
            <span className="inline-block text-3xl font-serif">♪</span>
            <h2 id="modal-title" className="text-2xl sm:text-[28px] leading-tight font-serif font-medium">
              Thank You
            </h2>
            <p className="text-sm text-neutral-700 leading-relaxed max-w-md mx-auto">
              {successMsg}
            </p>
            <div className="p-4 bg-neutral-100 text-xs text-neutral-600 border-l-2 border-black max-w-md mx-auto text-left space-y-1">
              <p className="font-semibold text-black">What happens next:</p>
              <p>We review every note personally and will get in touch with you shortly.</p>
              <p className="italic">Online and in-person classes are available. For in-person learning: “Coming soon — A welcoming new space is on the way.”</p>
            </div>
            <div className="pt-4">
              <button
                type="button"
                onClick={resetAndClose}
                className="px-6 py-2.5 bg-black text-white text-xs tracking-wider uppercase font-medium hover:bg-neutral-800 transition"
              >
                Return to Website
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="shrink-0 px-5 pt-5 pb-4 sm:px-10 sm:pt-8 sm:pb-5 [@media(max-height:560px)]:pt-4 [@media(max-height:560px)]:pb-3 border-b border-black/15">
              <p className="pr-10 mb-2 text-[10px] tracking-[0.2em] font-semibold text-neutral-500 uppercase [@media(max-height:560px)]:hidden">
                Mozart School Of Western Classical Music
              </p>
              {/* All three headings share one grid cell, so the header is as tall as the
                  longest one and does not change height when switching tabs. */}
              <div className="grid pr-10 sm:pr-0">
                {headings.map((h) => (
                  <div
                    key={h.id}
                    className={`[grid-area:1/1] ${h.id === type ? "" : "invisible"}`}
                    aria-hidden={h.id !== type}
                  >
                    <h2
                      id={h.id === type ? "modal-title" : undefined}
                      className="text-2xl sm:text-[28px] leading-tight font-serif font-normal"
                    >
                      {h.title}
                    </h2>
                    <p className="text-xs leading-relaxed text-neutral-600 mt-1.5 [@media(max-height:560px)]:hidden">
                      {h.intro}
                    </p>
                  </div>
                ))}
              </div>

              {/* Form Type Tabs */}
              <div className="mt-4 flex border border-black/20 text-[11px]">
                {tabs.map((tab, index) => (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setType(tab.id)}
                    aria-pressed={type === tab.id}
                    className={`flex-1 min-w-0 px-1 py-2 text-center leading-tight transition ${index > 0 ? "border-l border-black/20" : ""} ${type === tab.id ? "bg-black text-white font-medium" : "bg-transparent text-neutral-600 hover:text-black"}`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
            </div>

            <form onSubmit={handleSubmit} className="flex-1 min-h-0 flex flex-col text-xs">
              <div ref={bodyRef} className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-5 py-5 sm:px-10 sm:py-6 space-y-5">
            {errorMsg && (
              <div role="alert" className="p-4 bg-neutral-100 border-l-2 border-black text-xs text-black">
                <p className="font-semibold">Unable to submit enquiry:</p>
                <p className="mt-0.5">{errorMsg}</p>
                <p className="mt-2 text-[11px] text-neutral-600">
                  You can also call us directly at{" "}
                  <a href="tel:9043877104" className="font-semibold underline">
                    9043877104
                  </a>{" "}
                  or email{" "}
                  <a href="mailto:srinivaschetty@gmail.com" className="font-semibold underline">
                    srinivaschetty@gmail.com
                  </a>.
                </p>
              </div>
            )}

              {/* Hidden Honeypot */}
              <input
                type="text"
                name="user_note_verify"
                value={honeypot}
                onChange={(e) => setHoneypot(e.target.value)}
                tabIndex={-1}
                autoComplete="off"
                className="hidden"
                aria-hidden="true"
              />

              {/* Lesson Specific: Instrument & Learner Selection */}
              {(type === "lesson" || type === "location_interest") && (
                <div>
                  <label className="block text-[11px] font-semibold uppercase tracking-wider mb-1.5">
                    Instrument
                  </label>
                  <div className="grid grid-cols-4 gap-2">
                    {[
                      { id: "piano", label: "Piano" },
                      { id: "keyboard", label: "Keyboard" },
                      { id: "violin", label: "Violin" },
                      { id: "unsure", label: "Not Sure" },
                    ].map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => setInstrument(item.id as InstrumentType)}
                        className={`py-2 px-1 text-center border text-[11px] transition ${
                          instrument === item.id
                            ? "border-black bg-black text-white font-medium"
                            : "border-black/20 text-black hover:border-black"
                        }`}
                      >
                        {item.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {type === "lesson" && (
                <>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-[11px] font-semibold uppercase tracking-wider mb-1.5">
                        Learner Group
                      </label>
                      <div className="grid grid-cols-3 gap-1.5">
                        {[
                          { id: "child", label: "Child" },
                          { id: "teen", label: "Teen" },
                          { id: "adult", label: "Adult" },
                        ].map((grp) => (
                          <button
                            key={grp.id}
                            type="button"
                            onClick={() => setLearnerGroup(grp.id as LearnerGroupType)}
                            className={`py-1.5 text-center border text-[11px] transition ${
                              learnerGroup === grp.id
                                ? "border-black bg-black text-white font-medium"
                                : "border-black/20 text-black hover:border-black"
                            }`}
                          >
                            {grp.label}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div>
                      <label className="block text-[11px] font-semibold uppercase tracking-wider mb-1.5">
                        Experience Level
                      </label>
                      <div className="grid grid-cols-3 gap-1.5">
                        {[
                          { id: "beginner", label: "Beginner" },
                          { id: "some_experience", label: "Some" },
                          { id: "experienced", label: "Experienced" },
                        ].map((exp) => (
                          <button
                            key={exp.id}
                            type="button"
                            onClick={() => setExperience(exp.id as ExperienceLevelType)}
                            className={`py-1.5 text-center border text-[11px] transition ${
                              experience === exp.id
                                ? "border-black bg-black text-white font-medium"
                                : "border-black/20 text-black hover:border-black"
                            }`}
                          >
                            {exp.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>

                  {/* Class Preference */}
                  <div>
                    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-0.5 mb-1.5">
                      <label className="block text-[11px] font-semibold uppercase tracking-wider">
                        Class Preference *
                      </label>
                      <span className="text-[10px] text-neutral-500">
                        Online and in-person classes are available.
                      </span>
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                      {[
                        { id: "online", label: "Online" },
                        { id: "in_person", label: "In-person" },
                        { id: "either_guidance", label: "Either / I’d like guidance" },
                      ].map((pref) => (
                        <button
                          key={pref.id}
                          type="button"
                          onClick={() => setClassPreference(pref.id as ClassPreference)}
                          className={`py-2 px-2 text-center border text-[11px] transition ${
                            classPreference === pref.id
                              ? "border-black bg-black text-white font-medium"
                              : "border-black/20 text-black hover:border-black"
                          }`}
                        >
                          {pref.label}
                        </button>
                      ))}
                    </div>
                    {classPreference === "in_person" && (
                      <p className="mt-1.5 text-[10px] text-neutral-600 italic">
                        In-person classes are coming soon — A welcoming new space is on the way.
                      </p>
                    )}
                  </div>

                  {(learnerGroup === "child" || learnerGroup === "teen") && (
                    <div className="p-3 bg-neutral-100 border border-black/15 text-[11px] text-neutral-700">
                      <p className="font-medium text-black">Parent / Guardian Contact</p>
                      <p className="mt-0.5">
                        Please provide the parent or guardian’s contact details below. We do not collect children’s full names or dates of birth.
                      </p>
                      <div className="mt-2">
                        <label className="block text-[10px] uppercase font-semibold text-neutral-600 mb-1">
                          Student First Name (Optional)
                        </label>
                        <input
                          type="text"
                          value={learnerName}
                          onChange={(e) => setLearnerName(e.target.value)}
                          placeholder="First name only"
                          maxLength={50}
                          className="w-full bg-white border border-black/30 p-1.5 text-xs text-black focus:outline-hidden focus:border-black"
                        />
                      </div>
                    </div>
                  )}
                </>
              )}

              {/* Contact Information */}
              <div className="space-y-3 pt-1">
                <div>
                  <label className="block text-[11px] font-semibold uppercase tracking-wider mb-1">
                    {type === "lesson" && (learnerGroup === "child" || learnerGroup === "teen") ? "Parent / Guardian Name *" : "Your Name *"}
                  </label>
                  <input
                    type="text"
                    required
                    value={contactName}
                    onChange={(e) => setContactName(e.target.value)}
                    placeholder="Full name"
                    maxLength={120}
                    className="w-full border border-black/30 p-2 text-xs text-black focus:outline-hidden focus:border-black"
                  />
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[11px] font-semibold uppercase tracking-wider mb-1">
                      Email Address
                    </label>
                    <input
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="name@example.com"
                      maxLength={255}
                      className="w-full border border-black/30 p-2 text-xs text-black focus:outline-hidden focus:border-black"
                    />
                  </div>

                  <div>
                    <label className="block text-[11px] font-semibold uppercase tracking-wider mb-1">
                      Phone Number
                    </label>
                    <input
                      type="tel"
                      value={phone}
                      onChange={(e) => setPhone(e.target.value)}
                      placeholder="e.g. 9043877104"
                      maxLength={30}
                      className="w-full border border-black/30 p-2 text-xs text-black focus:outline-hidden focus:border-black"
                    />
                  </div>
                </div>
                <p className="text-[10px] text-neutral-500 italic">
                  * At least one contact method (email or phone) is required so we can reply.
                </p>
              </div>

              {/* Preferred Contact Method */}
              <div>
                <label className="block text-[11px] font-semibold uppercase tracking-wider mb-1">
                  Preferred Contact Method
                </label>
                <div className="flex gap-4 text-xs">
                  {[
                    { id: "either", label: "Either" },
                    { id: "phone", label: "Phone call" },
                    { id: "email", label: "Email" },
                  ].map((m) => (
                    <label key={m.id} className="flex items-center gap-1.5 cursor-pointer">
                      <input
                        type="radio"
                        name="preferred_contact"
                        checked={preferredContact === m.id}
                        onChange={() => setPreferredContact(m.id as any)}
                        className="accent-black"
                      />
                      <span>{m.label}</span>
                    </label>
                  ))}
                </div>
              </div>

              {/* Preferred Times (Preferences only) */}
              {type === "lesson" && (
                <div>
                  <label className="block text-[11px] font-semibold uppercase tracking-wider mb-1">
                    Preferred Days & Times <span className="font-normal lowercase text-neutral-500">(Preferences only — not a booking)</span>
                  </label>
                  <input
                    type="text"
                    value={preferredTimes}
                    onChange={(e) => setPreferredTimes(e.target.value)}
                    placeholder="e.g. Weekdays after 4pm, or Saturday mornings"
                    maxLength={300}
                    className="w-full border border-black/30 p-2 text-xs text-black focus:outline-hidden focus:border-black"
                  />
                </div>
              )}

              {/* Message */}
              <div>
                <label className="block text-[11px] font-semibold uppercase tracking-wider mb-1">
                  {type === "lesson" ? "Additional Notes (Optional)" : "Message *"}
                </label>
                <textarea
                  rows={type === "general" ? 4 : 2}
                  required={type === "general"}
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  placeholder={
                    type === "lesson"
                      ? "Tell us about musical goals, favourite pieces, or any questions..."
                      : "How can we help you?"
                  }
                  maxLength={3000}
                  className="w-full border border-black/30 p-2 text-xs text-black focus:outline-hidden focus:border-black resize-none"
                />
              </div>

              {/* Consents */}
              <div className="space-y-2 pt-1 border-t border-black/15">
                <label className="flex items-start gap-2.5 cursor-pointer text-[11px] text-neutral-800">
                  <input
                    type="checkbox"
                    required
                    checked={contactConsent}
                    onChange={(e) => setContactConsent(e.target.checked)}
                    className="accent-black mt-0.5"
                  />
                  <span>
                    <strong>Required:</strong> I consent to Mozart School contacting me regarding this enquiry.
                  </span>
                </label>

                {type !== "location_interest" && (
                  <label className="flex items-start gap-2.5 cursor-pointer text-[11px] text-neutral-700">
                    <input
                      type="checkbox"
                      checked={locationUpdates}
                      onChange={(e) => setLocationUpdates(e.target.checked)}
                      className="accent-black mt-0.5"
                    />
                    <span>
                      Keep me informed when updates about the new school location are confirmed.
                    </span>
                  </label>
                )}
              </div>

              {/* Spam protection */}
              {needsTurnstile && (
                <TurnstileWidget
                  siteKey={appConfig.turnstileSiteKey}
                  action="enquiry"
                  onTokenChange={setTurnstileToken}
                  resetSignal={turnstileReset}
                />
              )}
              {appConfig.mode === "mock" && (
                <p className="text-[10px] text-neutral-500 italic">
                  Demo mode: the spam check is skipped and nothing is sent to the school.
                </p>
              )}
              {unavailable && (
                <div className="p-3 bg-neutral-100 border-l-2 border-black text-[11px] text-black">
                  Online enquiries are temporarily unavailable. Please call{" "}
                  <a href="tel:9043877104" className="font-semibold underline">9043877104</a> or email{" "}
                  <a href="mailto:srinivaschetty@gmail.com" className="font-semibold underline">srinivaschetty@gmail.com</a>.
                </div>
              )}

              </div>

              {/* Submit Buttons (always visible below the scrolling fields) */}
              <div className="shrink-0 px-5 py-3 sm:px-10 sm:py-4 flex flex-col sm:flex-row items-center justify-between gap-2 sm:gap-3 border-t border-black/15 bg-white">
                <div className="text-[10px] text-neutral-500">
                  Protected by Turnstile & strict privacy.
                </div>
                <div className="flex items-center gap-2 w-full sm:w-auto">
                  <button
                    type="button"
                    onClick={resetAndClose}
                    className="flex-1 sm:flex-none px-4 py-2.5 border border-black/30 text-xs font-medium hover:bg-neutral-100 transition"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={loading || unavailable || (needsTurnstile && !turnstileToken)}
                    className="flex-1 sm:flex-none px-6 py-2.5 bg-black text-white text-xs font-medium tracking-wide uppercase hover:bg-neutral-800 transition disabled:opacity-50"
                  >
                    {loading ? "Sending..." : "Submit Enquiry"}
                  </button>
                </div>
              </div>
            </form>
          </>
        )}
      </div>
    </div>
  )
}
