// Build-time search indexing decision, used by vite.config.ts.
//
// Indexing is opt-in: SITE_INDEXING=true. On Vercel, only Production deployments
// may be indexable: VERCEL_ENV (set by Vercel during the build) must be
// "production", so Preview deployments stay noindex even if a Preview build is
// given SITE_INDEXING=true by mistake. Local builds have no VERCEL_ENV and follow
// SITE_INDEXING alone.

export interface IndexingEnv {
  SITE_INDEXING?: string
  SITE_URL?: string
  VERCEL_ENV?: string
}

export interface IndexingDecision {
  indexable: boolean
  reason: string
  canonicalUrl: string | null
}

export function resolveSearchIndexing(env: IndexingEnv): IndexingDecision {
  const canonicalUrl = parseCanonical(env.SITE_URL)
  if ((env.SITE_INDEXING ?? "").trim().toLowerCase() !== "true") {
    return { indexable: false, reason: "SITE_INDEXING is not \"true\"", canonicalUrl }
  }
  const vercelEnv = env.VERCEL_ENV?.trim()
  if (vercelEnv && vercelEnv !== "production") {
    return { indexable: false, reason: `Vercel ${vercelEnv} deployment (only production is indexable)`, canonicalUrl }
  }
  return { indexable: true, reason: "SITE_INDEXING=true", canonicalUrl }
}

function parseCanonical(raw: string | undefined): string | null {
  if (!raw) return null
  try {
    const url = new URL(raw)
    return url.protocol === "https:" && !url.hostname.endsWith(".example") ? `${url.origin}/` : null
  } catch {
    return null
  }
}

export function robotsTxt(decision: IndexingDecision): string {
  if (!decision.indexable) return "User-agent: *\nDisallow: /\n"
  return "User-agent: *\nAllow: /\nDisallow: /admin\n"
}
