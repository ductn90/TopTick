import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'

/** Strict CSP shipped in every built page (design §IPC). */
const BUILD_CSP =
  "default-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'none'"

/** Dev server only: React refresh preamble needs inline scripts and HMR needs a websocket. */
const DEV_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self' ws://localhost:*"

function csp(): Plugin {
  return {
    name: 'toptick-csp',
    // Injected as a raw string: tag descriptors HTML-escape the single quotes in the policy.
    transformIndexHtml(html, ctx) {
      const meta = `<meta http-equiv="Content-Security-Policy" content="${ctx.server ? DEV_CSP : BUILD_CSP}" />`
      return html.replace(/<head>/i, `<head>\n    ${meta}`)
    }
  }
}

export default defineConfig({
  // Only `dependencies` are externalized (and packed into app.asar by electron-builder). zod is a
  // devDependency, so it is bundled into main instead of shipping its 7 MB package. electron-log
  // stays a dependency: bundled, its initialize() would write a generated preload file at startup.
  main: {},
  preload: {},
  renderer: {
    plugins: [react(), csp()],
    build: {
      // electron-vite leaves renderer output unminified by default.
      minify: true,
      rolldownOptions: {
        input: {
          bar: resolve(__dirname, 'src/renderer/bar.html'),
          settings: resolve(__dirname, 'src/renderer/settings.html')
        }
      }
    }
  }
})
