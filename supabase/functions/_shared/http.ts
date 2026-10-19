export interface CorsResult {
  origin: string | null
  allowed: boolean
  headers: Record<string, string>
}

// Echoes the Origin only when it is on the explicit allow-list.
export function buildCors(req: Request, allowedOrigins: string[], methods: string): CorsResult {
  const origin = req.headers.get("origin")
  const allowed = origin !== null && allowedOrigins.includes(origin)
  const headers: Record<string, string> = { Vary: "Origin" }
  if (allowed) {
    headers["Access-Control-Allow-Origin"] = origin
    headers["Access-Control-Allow-Methods"] = methods
    headers["Access-Control-Allow-Headers"] = "authorization, x-client-info, apikey, content-type"
    headers["Access-Control-Max-Age"] = "86400"
  }
  return { origin, allowed, headers }
}

export function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, "Content-Type": "application/json", "Cache-Control": "no-store" },
  })
}

export function bearerToken(req: Request): string | null {
  const header = req.headers.get("authorization") ?? ""
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match ? match[1].trim() : null
}

// Constant-time comparison of two secrets (hashing first equalises lengths).
export async function secretsEqual(provided: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder()
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ])
  const left = new Uint8Array(a)
  const right = new Uint8Array(b)
  let diff = 0
  for (let i = 0; i < left.length; i++) diff |= left[i] ^ right[i]
  return diff === 0
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}
