import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { readSetting } from "../supabase/functions/_shared/env.ts"
import { resolveAppConfig } from "../src/lib/config"
import { envOf } from "./helpers"

function parseEnvFile(path: string): Record<string, string> {
  const values: Record<string, string> = {}
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
    if (match) values[match[1]] = match[2]
  }
  return values
}

describe(".env.example templates", () => {
  it("frontend placeholders are rejected, and no secret names appear", () => {
    const values = parseEnvFile(".env.example")
    const config = resolveAppConfig({ DEV: false, ...values })
    expect(config.mode).toBe("misconfigured")
    expect(config.errors).toEqual(["VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY", "VITE_TURNSTILE_SITE_KEY"])
    for (const name of Object.keys(values)) {
      expect(name).not.toMatch(/SERVICE_ROLE|SECRET|RESEND|CRON/)
    }
  })

  it("Edge Function placeholders are rejected", () => {
    const env = envOf(parseEnvFile("supabase/functions/.env.example"))
    for (const name of ["ALLOWED_ORIGINS", "SITE_URL", "OWNER_EMAIL", "TURNSTILE_SECRET_KEY", "RESEND_API_KEY", "FROM_EMAIL", "NOTIFICATIONS_CRON_SECRET"]) {
      expect(readSetting(env, name), name).toBeNull()
    }
  })
})
