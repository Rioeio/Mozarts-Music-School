import { describe, it, expect } from "vitest"
import { existsSync, readFileSync } from "node:fs"

interface Rewrite {
  source: string
  destination: string
}

const config = JSON.parse(readFileSync("vercel.json", "utf8")) as {
  framework: string
  installCommand: string
  buildCommand: string
  outputDirectory: string
  rewrites: Rewrite[]
  redirects?: unknown[]
}

// Vercel serves a matching static file first and only then applies rewrites
// (matched against the path; the query string and #fragment pass through).
function rewriteFor(path: string): string | null {
  for (const rule of config.rewrites) {
    if (new RegExp(`^${rule.source}$`).test(path)) return rule.destination
  }
  return null
}

describe("Vercel hosting config", () => {
  it("builds the Vite app into dist with the lockfile", () => {
    expect(config.framework).toBe("vite")
    expect(config.installCommand).toBe("npm ci")
    expect(config.buildCommand).toBe("npm run build")
    expect(config.outputDirectory).toBe("dist")
  })

  it("serves the app for direct visits to client-side routes", () => {
    for (const path of ["/", "/admin", "/admin/", "/admin/auth/callback", "/some/unknown/page"]) {
      expect(rewriteFor(path), path).toBe("/index.html")
    }
  })

  it("never answers a missing build asset with the HTML page", () => {
    expect(rewriteFor("/assets/index-OLDHASH.js")).toBeNull()
    expect(rewriteFor("/assets/index-OLDHASH.css")).toBeNull()
  })

  it("has no redirects (so no redirect loops) and no leftover Cloudflare config", () => {
    expect(config.redirects ?? []).toEqual([])
    expect(config.rewrites).toHaveLength(1)
    expect(existsSync("wrangler.json")).toBe(false)
    expect(existsSync("wrangler.toml")).toBe(false)
    expect(existsSync("public/_redirects")).toBe(false)
  })
})
