import { defineConfig, loadEnv, type HtmlTagDescriptor, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'

import { resolveSearchIndexing, robotsTxt, type IndexingDecision } from './scripts/site-indexing'


// Vite config — https://vitejs.dev/config/
export default defineConfig(({ command, mode }) => {
  // Search indexing is an explicit build setting (scripts/site-indexing.ts); the
  // dev server is never indexable.
  const indexing = resolveSearchIndexing(command === 'build' ? { ...loadEnv(mode, process.cwd(), ''), ...process.env } : {})
  if (command === 'build') console.log(`[site] search indexing ${indexing.indexable ? 'ENABLED' : 'disabled'} (${indexing.reason})`)

  return {
    plugins: [
      react(),
      tailwindcss(),
      searchIndexing(indexing),
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    server: {
      port: parseInt(process.env.PORT || '8443'),
      strictPort: true,
    },
    preview: {
      port: parseInt(process.env.PORT || '8443'),
    },
  }
})

/** Emits robots.txt and the matching robots / canonical tags for the build's indexing decision. */
function searchIndexing(indexing: IndexingDecision): Plugin {
  // Always emitted: without a file the SPA fallback would answer /robots.txt with HTML.
  const robots = robotsTxt(indexing)

  return {
    name: 'search-indexing',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.split('?')[0] !== '/robots.txt') return next()

        res.setHeader('Content-Type', 'text/plain; charset=utf-8')
        res.end(robots)
      })
    },
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'robots.txt',
        source: robots,
      })
    },
    transformIndexHtml() {
      const tags: HtmlTagDescriptor[] = []
      if (!indexing.indexable) {
        tags.push({ tag: 'meta', attrs: { name: 'robots', content: 'noindex, nofollow' }, injectTo: 'head' })
      } else if (indexing.canonicalUrl) {
        tags.push({ tag: 'link', attrs: { rel: 'canonical', href: indexing.canonicalUrl }, injectTo: 'head' })
      }
      return tags
    },
  }
}
