import { useEffect, useRef, useState } from "react"

// Cloudflare Turnstile, rendered explicitly so tokens can be reset after every
// submission (each token is single-use).
// https://developers.cloudflare.com/turnstile/get-started/client-side-rendering/

interface TurnstileApi {
  render(container: HTMLElement, options: Record<string, unknown>): string
  reset(widgetId: string): void
  remove(widgetId: string): void
}

declare global {
  interface Window {
    turnstile?: TurnstileApi
  }
}

const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"
const LOAD_TIMEOUT_MS = 15_000
let scriptPromise: Promise<TurnstileApi> | null = null

function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile)
  if (scriptPromise) return scriptPromise

  scriptPromise = new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement("script")
    script.src = SCRIPT_SRC
    script.async = true
    script.defer = true
    const timer = window.setTimeout(() => reject(new Error("Turnstile load timed out")), LOAD_TIMEOUT_MS)
    script.onload = () => {
      window.clearTimeout(timer)
      if (window.turnstile) resolve(window.turnstile)
      else reject(new Error("Turnstile unavailable"))
    }
    script.onerror = () => {
      window.clearTimeout(timer)
      reject(new Error("Turnstile failed to load"))
    }
    document.head.appendChild(script)
  }).catch((err) => {
    // Allow a later retry to inject the script again.
    scriptPromise = null
    document.querySelectorAll(`script[src="${SCRIPT_SRC}"]`).forEach((node) => node.remove())
    throw err
  })
  return scriptPromise
}

type WidgetState = "loading" | "ready" | "verified" | "expired" | "error"

interface TurnstileWidgetProps {
  siteKey: string
  action: string
  onTokenChange: (token: string | null) => void
  // Increment to discard the current token and show a fresh challenge.
  resetSignal: number
}

export default function TurnstileWidget({ siteKey, action, onTokenChange, resetSignal }: TurnstileWidgetProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const widgetIdRef = useRef<string | null>(null)
  const onTokenRef = useRef(onTokenChange)
  const [state, setState] = useState<WidgetState>("loading")
  const [attempt, setAttempt] = useState(0)

  onTokenRef.current = onTokenChange

  useEffect(() => {
    let cancelled = false
    setState("loading")
    onTokenRef.current(null)

    loadTurnstile()
      .then((turnstile) => {
        if (cancelled || !containerRef.current) return
        widgetIdRef.current = turnstile.render(containerRef.current, {
          sitekey: siteKey,
          action,
          theme: "light",
          size: "flexible",
          retry: "auto",
          "refresh-expired": "auto",
          callback: (token: string) => {
            setState("verified")
            onTokenRef.current(token)
          },
          "expired-callback": () => {
            setState("expired")
            onTokenRef.current(null)
          },
          "timeout-callback": () => {
            setState("expired")
            onTokenRef.current(null)
          },
          "error-callback": () => {
            setState("error")
            onTokenRef.current(null)
          },
        })
        setState("ready")
      })
      .catch(() => {
        if (!cancelled) setState("error")
      })

    return () => {
      cancelled = true
      if (widgetIdRef.current && window.turnstile) {
        window.turnstile.remove(widgetIdRef.current)
      }
      widgetIdRef.current = null
    }
  }, [siteKey, action, attempt])

  // Only react to changes after mount; a fresh mount already renders a new challenge.
  const lastResetRef = useRef(resetSignal)
  useEffect(() => {
    if (resetSignal === lastResetRef.current) return
    lastResetRef.current = resetSignal
    onTokenRef.current(null)
    if (widgetIdRef.current && window.turnstile) {
      window.turnstile.reset(widgetIdRef.current)
      setState("ready")
    } else {
      setAttempt((n) => n + 1)
    }
  }, [resetSignal])

  return (
    <div className="space-y-1.5">
      <div ref={containerRef} />
      <p className="text-[10px] text-neutral-500" aria-live="polite">
        {state === "loading" && "Loading spam check…"}
        {state === "ready" && "Please complete the spam check to submit."}
        {state === "verified" && "Spam check complete."}
        {state === "expired" && "The spam check expired. Please complete it again."}
        {state === "error" && (
          <>
            The spam check could not load.{" "}
            <button type="button" onClick={() => setAttempt((n) => n + 1)} className="font-semibold underline">
              Try again
            </button>
            {" "}or call 9043877104.
          </>
        )}
      </p>
    </div>
  )
}
