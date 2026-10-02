import { defineConfig, type Plugin, type PreviewServer, type ViteDevServer } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'
import { Store } from './src/server/db'
import { BackupService } from './src/server/backup'
import { createApiHandler } from './src/server/http'

const PORT = Number(process.env.PORT) > 0 && Number(process.env.PORT) < 65536 ? Number(process.env.PORT) : 8443
const COMMON_SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
}
const DEVELOPMENT_CSP = "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; style-src-attr 'unsafe-inline'; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-src 'none'"
const PRODUCTION_CSP = "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; style-src-attr 'unsafe-inline'; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-src 'none'"

export default defineConfig({
  plugins: [react(), tailwindcss(), cspIndexPlugin(), electionApi()],
  resolve: {
    dedupe: ['react', 'react-dom'],
  },
  server: {
    host: '127.0.0.1',
    port: PORT,
    strictPort: true,
    watch: {
      ignored: ['**/data/**', '**/*.sqlite', '**/*.sqlite-*'],
    },
    fs: {
      strict: true,
      allow: [
        path.resolve(import.meta.dirname, './src'),
        path.resolve(import.meta.dirname, './index.html'),
        path.resolve(import.meta.dirname, './node_modules/sql.js'),
      ],
    },
    headers: { ...COMMON_SECURITY_HEADERS, 'Content-Security-Policy': DEVELOPMENT_CSP },
    cors: false,
  },
  preview: {
    host: '127.0.0.1',
    port: PORT,
    headers: { ...COMMON_SECURITY_HEADERS, 'Content-Security-Policy': PRODUCTION_CSP },
  },
  build: {
    chunkSizeWarningLimit: 500,
    target: 'es2020',
    cssCodeSplit: true,
    sourcemap: false,
    assetsInlineLimit: 4096,
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (id.includes('node_modules/recharts') || id.includes('node_modules/d3-')) return 'charts'
          if (id.includes('node_modules/react') || id.includes('node_modules/react-dom') || id.includes('node_modules/scheduler')) return 'vendor'
          return undefined
        },
      },
    },
  },
})

function cspIndexPlugin(): Plugin {
  return {
    name: 'election-csp-mode',
    transformIndexHtml(html, context) {
      return context.server ? html.replace(PRODUCTION_CSP, DEVELOPMENT_CSP) : html
    },
  }
}

/**
 * Serves the election API from a local SQLite database.
 *
 * The database lives in `data/` and is created, migrated and seeded on first
 * use. It is deliberately outside version control: it holds voter contact
 * details, one-time codes and ballot records.
 */
function electionApi(): Plugin {
  const store = new Store({
    dataDirectory: path.resolve(import.meta.dirname, 'data'),
    wasmPath: path.resolve(import.meta.dirname, 'node_modules/sql.js/dist/sql-wasm.wasm'),
  })
  // Backups live inside the Git-ignored data directory so archives containing
  // personal data can never be committed.
  const backups = new BackupService(path.resolve(import.meta.dirname, 'data/backups'))

  async function attach(server: ViteDevServer | PreviewServer, strictOriginChecks: boolean) {
    try {
      const databasePath = await store.initialise()
      server.config.logger.info(`  ➜  election database: ${databasePath}`)
    } catch (error) {
      server.config.logger.warn(`[election-api] database init failed: ${(error as Error).message}`)
    }

    const handler = createApiHandler({
      store,
      strictOriginChecks,
      logger: server.config.logger,
      backups,
      startedAt: Date.now(),
      onDatabaseReplaced: () => {
        server.config.logger.info('  ➜  database replaced on disk; reload to pick up the restored state')
      },
      // There is no SMS or mail gateway in this local build, so the voter flow
      // needs the codes on screen to be completable at all. This is opt-in and
      // never inferred from any other setting: it hands every voter their own
      // code to any caller, so it must not come along by accident when something
      // else is loosened. The preview and production servers leave it off unless
      // it is asked for by name.
      revealDemoCodes: process.env.ELECTION_DEMO_OTP === '1',
    })
    if (process.env.ELECTION_DEMO_OTP === '1') {
      server.config.logger.warn(
        '  ⚠  ELECTION_DEMO_OTP=1 — voter verification codes are being displayed on screen.\n' +
          '     Anyone who can reach this server can complete verification as any voter. Use `npm run dev:secure` to run without it.',
      )
    }
    server.middlewares.use((request, response, next) => {
      void handler(request, response, next)
    })
  }

  return {
    name: 'election-api',
    async configureServer(server) {
      await attach(server, false)
    },
    async configurePreviewServer(server) {
      await attach(server, true)    },
  }
}
