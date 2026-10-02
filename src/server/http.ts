/**
 * HTTP surface.
 *
 * Four endpoints, all loopback-only and same-origin checked:
 *
 * - `GET  /__api/state`    bootstrap read for the voter portal
 * - `GET  /__api/session`  current administrator session
 * - `POST /__api/auth`     sign-in, bootstrap, and second factor
 * - `POST /__api/command`  everything else, through the authorisation table
 *
 * Every request is assigned a request identifier that is echoed back and written
 * into the audit trail, so an action in the log can be correlated with server
 * output. Rate limiting is applied per client, with a tighter budget on the
 * sign-in endpoints.
 */

import { randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { AuthorizationError, enforce, resolveCommandPermission } from './authorize'
import * as control from './control'
import * as authCommands from './authCommands'
import { AuthError } from './authCommands'
import { CommandError, dispatch as dispatchCommand, type CommandContext } from './commands'
import { ValidationError } from '../lib/validate'
import { readRevision, type SqlDatabase, type Store } from './db'
import { resolveSession, type LoginPolicy } from './auth'
import { normaliseClientKey, RateLimiter, recordSecurityEvent } from './security'
import { readSettings } from './settings'
import {
  clearSessionCookie,
  serializeSessionCookie,
  VOTER_COOKIE,
  VOTER_SESSION_MAX_AGE_MS,
} from './voterSession'

export const ADMIN_COOKIE = 'election_admin'
/** The single-use right to cast one ballot, issued after a voter authenticates. */
export const CREDENTIAL_COOKIE = 'election_credential'
/** The voter's own receipt code, so a reload can show it again. */
export const RECEIPT_COOKIE = 'election_receipt'
const MAX_BODY_BYTES = 2 * 1024 * 1024
const BODY_TIMEOUT_MS = 10_000
/** Sign-in gets a much smaller budget than ordinary API traffic. */
const AUTH_RATE_LIMIT = 12
const AUTH_RATE_WINDOW_MS = 60_000
/**
 * Verifying a voter is the path to a ballot, so it is budgeted more tightly
 * still: enough for a legitimate correction or two, far too few to grind
 * through a code space.
 */
const VOTER_AUTH_RATE_LIMIT = 10

const READ_ONLY_COMMANDS: ReadonlySet<string> = new Set([
  'state.get',
  'admin.session',
  'election.list',
  'election.get',
  'election.preview',
  'election.results',
  'control.dashboard',
  'control.system.health',
  'control.audit.query',
  'control.security.query',
  'control.sessions.list',
  'control.backups.list',
  'control.settings.read',
  'control.approvals.list',
  'control.accounts.list',
  'voter.ballot',
  'voter.receipt',
])

export type ApiOptions = {
  store: Store
  /** Strict origin enforcement is enabled for the production preview server. */
  strictOriginChecks: boolean
  logger?: { warn: (message: string) => void; info?: (message: string) => void }
  /** Expose voter one-time codes in the voter flow. Off unless asked for. */
  revealDemoCodes?: boolean
  backups: control.ControlContext['backups']
  startedAt: number
  /** Reload the process state after a restore or reset replaced the file. */
  onDatabaseReplaced: () => void
}

function parseCookies(header: unknown): Record<string, string> {
  if (typeof header !== 'string' || !header) return {}
  const result: Record<string, string> = {}
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index <= 0) continue
    const key = part.slice(0, index).trim()
    if (!key) continue
    try {
      result[key] = decodeURIComponent(part.slice(index + 1).trim())
    } catch {
      result[key] = part.slice(index + 1).trim()
    }
  }
  return result
}

function readCookie(request: IncomingMessage, name: string): string | null {
  const value = parseCookies(request.headers.cookie)[name]
  return value && value.length <= 200 ? value : null
}

function setAdminCookie(response: ServerResponse, token: string | null): void {
  if (!token) {
    response.setHeader('Set-Cookie', `${ADMIN_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`)
    return
  }
  response.setHeader(
    'Set-Cookie',
    `${ADMIN_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`,
  )
}

/**
 * Whether this request arrived over TLS.
 *
 * `Secure` is set on the voter cookies when it can be, but the development and
 * preview servers are plain HTTP on loopback and a browser silently discards a
 * `Secure` cookie sent over HTTP — so setting it unconditionally would break
 * local voting rather than protect it.
 */
function isSecureRequest(request: IncomingMessage): boolean {
  if ((request.socket as { encrypted?: boolean }).encrypted) return true
  const forwarded = request.headers['x-forwarded-proto']
  return typeof forwarded === 'string' && forwarded.split(',')[0].trim() === 'https'
}

/**
 * A cookie for a bearer secret the ballot subsystem consumes.
 *
 * Same protections as the session cookie, and for the same reasons: the page must
 * not be able to read the credential, and the credential must not travel to
 * anywhere but this origin. Scoped to `/__api` so it is not attached to page
 * loads or to any other request the browser might make.
 */
export function serializeSecretCookie(name: string, value: string, maxAgeSeconds: number, secure: boolean): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/__api',
    `Max-Age=${Math.max(0, Math.trunc(maxAgeSeconds))}`,
  ]
  if (secure) parts.push('Secure')
  return parts.join('; ')
}

export function clearSecretCookie(name: string, secure: boolean): string {
  return serializeSecretCookie(name, '', 0, secure)
}

function sendJson(response: ServerResponse, status: number, body: unknown, requestId: string): void {
  response.statusCode = status
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.setHeader('Cache-Control', 'no-store')
  response.setHeader('X-Request-Id', requestId)
  response.end(JSON.stringify(body))
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const declared = Number(request.headers['content-length'] ?? 0)
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new Error('PAYLOAD_TOO_LARGE')
  const chunks: Buffer[] = []
  let size = 0
  const timeout = setTimeout(() => request.destroy(), BODY_TIMEOUT_MS)
  try {
    for await (const chunk of request) {
      const buffer = Buffer.from(chunk)
      size += buffer.length
      if (size > MAX_BODY_BYTES) {
        request.destroy()
        throw new Error('PAYLOAD_TOO_LARGE')
      }
      chunks.push(buffer)
    }
    return Buffer.concat(chunks)
  } finally {
    clearTimeout(timeout)
  }
}

function isLoopback(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress || ''
  return address === '::1' || address === '127.0.0.1' || address === '0.0.0.0' || address.startsWith('::ffff:127.')
}

function isLocalHostHeader(host: unknown): boolean {
  if (typeof host !== 'string' || !host) return false
  try {
    const url = new URL(`http://${host}`)
    if (url.username || url.password) return false
    const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
    return (
      hostname === 'localhost' ||
      hostname.endsWith('.localhost') ||
      hostname === '::1' ||
      hostname === '0.0.0.0' ||
      /^127(?:\.\d{1,3}){3}$/.test(hostname)
    )
  } catch {
    return false
  }
}

function hasSameOrigin(request: IncomingMessage, strict: boolean): boolean {
  const origin = request.headers.origin
  const host = request.headers.host
  if (origin && host) {
    try {
      return new URL(origin).host === host
    } catch {
      return false
    }
  }
  const fetchSite = request.headers['sec-fetch-site']
  if (fetchSite) return fetchSite === 'same-origin'
  return !strict && (request.method === 'GET' || request.method === 'HEAD')
}

function clientIp(request: IncomingMessage): string {
  return request.socket.remoteAddress || '127.0.0.1'
}

function statusForCode(code: string): number {
  switch (code) {
    case 'invalid':
    case 'invalid_transition':
    case 'incomplete':
    case 'unmapped_command':
    case 'approval_invalid':
      return 400
    case 'unauthorized':
      return 401
    case 'locked':
      return 423
    case 'elevation_required':
    case 'approval_required':
      return 428
    case 'forbidden':
    case 'election_locked':
    case 'election_paused':
    case 'election_closed':
    case 'before_window':
    case 'after_window':
    case 'already_voted':
      return 403
    case 'not_found':
      return 404
    case 'conflict':
    case 'election_state':
    case 'integrity':
      return 409
    case 'too_many_requests':
      return 429
    case 'unknown_command':
      return 404
    default:
      return 500
  }
}

/**
 * Commands routed to the control plane rather than the election handlers.
 *
 * Exported so a test can prove that every one of them appears in the
 * authorisation table in `authorize.ts`. A control command missing from that
 * table would be refused at runtime, which is the safe failure, but it is still a
 * bug worth catching at build time.
 */
export const CONTROL_ROUTES: Record<string, (context: control.ControlContext, payload: unknown) => unknown> = {
  'control.dashboard': control.dashboard,
  'control.system.health': control.systemHealth,
  'control.audit.query': control.auditQuery,
  'control.security.query': control.securityQuery,
  'control.security.acknowledge': control.acknowledgeAlert,
  'control.sessions.list': control.sessionsList,
  'control.session.revoke': control.sessionRevoke,
  'control.session.revokeAll': control.sessionRevokeAll,
  'control.backups.list': control.backupsList,
  'control.backup.create': control.backupCreate,
  'control.backup.restore': control.backupRestore,
  'control.settings.read': control.settingsRead,
  'control.settings.write': control.settingsWrite,
  'control.approvals.list': control.approvalList,
  'control.approval.create': control.approvalRequestCreate,
  'control.approval.decide': control.approvalDecide,
  'control.accounts.list': control.accountsList,
  'control.account.create': control.accountCreate,
  'control.account.update': control.accountUpdate,
  'control.account.password': control.accountPasswordReset,
  'control.system.reset': control.systemReset,
}

export const AUTH_ROUTES: Record<string, (context: authCommands.AuthContext, payload: unknown) => unknown> = {
  'bootstrap': authCommands.bootstrap,
  'login': authCommands.login,
  'mfa.verify': authCommands.mfaVerify,
  'mfa.status': authCommands.mfaStatus,
  'session': authCommands.currentSession,
  'logout': authCommands.logoutCommand,
  'reauthenticate': authCommands.reauthenticate,
  'mfa.stepup': authCommands.mfaStepUp,
  'mfa.manage': authCommands.mfaManage,
  'password.change': authCommands.changeOwnPassword,
}

/**
 * Look up a route handler for an action name taken from the request.
 *
 * Uses an own-property check deliberately. A plain `ROUTES[action]` lookup
 * would resolve `toString`, `constructor` and other inherited members to
 * functions, which for the control table would mean reaching a handler *without
 * the authorisation table ever being consulted* — the exact thing the table
 * exists to prevent. An unrecognised action must resolve to nothing and fall
 * through to the refusal path.
 */
function routeFor<T>(routes: Record<string, T>, action: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(routes, action) ? routes[action] : undefined
}

export function createApiHandler(options: ApiOptions) {
  const { store, strictOriginChecks, backups, startedAt, onDatabaseReplaced } = options
  const logger = options.logger ?? { warn: () => {} }
  // Cookie lifetimes mirror the server-side limits: a credential cookie outliving
  // its credential would be harmless but confusing, and a receipt cookie outliving
  // the election would be litter.
  const credentialCookieTtl = 3600
  const receiptCookieTtl = 7 * 86_400
  const revealDemoCodes = options.revealDemoCodes ?? false
  const limiter = new RateLimiter(120, 60_000)
  const authLimiter = new RateLimiter(AUTH_RATE_LIMIT, AUTH_RATE_WINDOW_MS)
  /** Voter verification: far tighter, because it is the path to a ballot. */
  const voterAuthLimiter = new RateLimiter(VOTER_AUTH_RATE_LIMIT, AUTH_RATE_WINDOW_MS)

  const isApiPath = (pathname: string) =>
    pathname === '/__api/state' ||
    pathname === '/__api/session' ||
    pathname === '/__api/auth' ||
    pathname === '/__api/control' ||
    pathname === '/__api/command'

  const buildPolicy = (database: SqlDatabase): LoginPolicy => {
    const settings = readSettings(database)
    limiter.setLimit(settings.rateLimitRequests, settings.rateLimitWindowSeconds * 1000)
    return {
      maxAttempts: settings.maxLoginAttempts,
      lockoutMinutes: settings.lockoutMinutes,
      sessionIdleMinutes: settings.sessionIdleMinutes,
      requireMfa: settings.requireMfa,
    }
  }

  return async function handler(request: IncomingMessage, response: ServerResponse, next: () => void) {
    let pathname = ''
    try {
      pathname = new URL(request.url || '/', 'http://localhost').pathname
    } catch {
      pathname = (request.url || '/').split('?')[0]
    }

    if (!isApiPath(pathname)) {
      next()
      return
    }

    // A request identifier ties the audit record to server output.
    const requestId =
      (typeof request.headers['x-request-id'] === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(request.headers['x-request-id'])
        ? request.headers['x-request-id']
        : '') || randomBytes(8).toString('hex')
    const ip = clientIp(request)

    // The database holds voter PII, so the API is reachable only from this
    // machine. A proxied deployment would need real authentication here.
    if (!isLoopback(request)) {
      response.statusCode = 403
      response.end()
      return
    }
    if (pathname.toLowerCase().startsWith('/data')) {
      response.statusCode = 404
      response.end()
      return
    }
    const originOk = isLocalHostHeader(request.headers.host) && hasSameOrigin(request, strictOriginChecks)
    if (!originOk) {
      try {
        await store.write((database) =>
          recordSecurityEvent(database, {
            kind: 'origin_rejected',
            summary: 'Rejected a request with a missing or foreign Origin header.',
            requestId,
            ip,
            detail: { host: String(request.headers.host ?? ''), origin: String(request.headers.origin ?? '') },
          }),
        )
      } catch {
        /* the rejection still stands even if it cannot be logged */
      }
      sendJson(response, 403, { ok: false, code: 'forbidden', error: 'Forbidden origin.', requestId }, requestId)
      return
    }

    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.setHeader('Referrer-Policy', 'no-referrer')
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin')

    const voterToken =
      typeof request.headers['x-voter-token'] === 'string'
        ? String(request.headers['x-voter-token']).slice(0, 200)
        : readCookie(request, VOTER_COOKIE)
    const adminToken = readCookie(request, ADMIN_COOKIE)
    const secureCookies = isSecureRequest(request)

    try {
      /* ------------------------------------------------------------ state --- */
      if (pathname === '/__api/state') {
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          response.statusCode = 405
          response.setHeader('Allow', 'GET')
          response.end()
          return
        }
        const result = await store.read((database) => {
          const session = resolveSession(database, adminToken)
          return dispatchCommand(
            {
              database,
              adminToken,
              voterToken: null,
              now: Date.now(),
              revealDemoCodes: revealDemoCodes || readSettings(database).revealDemoPasscodes,
              session,
              requestId,
              ip,
            } as CommandContext,
            'state.get',
            {},
          )
        })
        if (!result.ok) {
          sendJson(response, statusForCode(result.code), { ...result, requestId }, requestId)
          return
        }
        const revision = await store.read(readRevision)
        sendJson(response, 200, { ...(result.value as object), revision, requestId }, requestId)
        return
      }

      /* ---------------------------------------------------------- session --- */
      if (pathname === '/__api/session') {
        const result = await store.read((database) => {
          const session = resolveSession(database, adminToken)
          const settings = readSettings(database)
          return {
            session,
            requireMfa: settings.requireMfa,
            serverNow: new Date().toISOString(),
          }
        })
        sendJson(response, 200, { ok: true, ...result, requestId }, requestId)
        return
      }

      const body = await readBody(request)
      let parsed: unknown
      try {
        parsed = JSON.parse(body.toString('utf8'))
      } catch {
        sendJson(response, 400, { ok: false, code: 'invalid', error: 'Request body was not valid JSON.', requestId }, requestId)
        return
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        sendJson(response, 400, { ok: false, code: 'invalid', error: 'Expected a command object.', requestId }, requestId)
        return
      }
      const envelope = parsed as { action?: unknown; payload?: unknown }
      const payload = (envelope.payload ?? {}) as Record<string, unknown>
      const isAuth = pathname === '/__api/auth'
      const action = typeof envelope.action === 'string' ? envelope.action : isAuth ? 'session' : ''
      if (!action || action.length > 64) {
        sendJson(response, 400, { ok: false, code: 'invalid', error: 'An action is required.', requestId }, requestId)
        return
      }

      /* ------------------------------------------------------------- auth --- */
      if (isAuth) {
        const handler = routeFor(AUTH_ROUTES, action)
        if (!handler) {
          sendJson(response, 404, { ok: false, code: 'unknown_command', error: 'Unknown auth action.', requestId }, requestId)
          return
        }
        // Sign-in attempts get their own, much tighter budget.
        if (action === 'login' || action === 'bootstrap' || action === 'mfa.verify') {
          const verdict = authLimiter.check(normaliseClientKey(ip, String(payload.username ?? '')))
          if (!verdict.allowed) {
            response.setHeader('Retry-After', String(verdict.retryAfterSeconds))
            sendJson(
              response,
              429,
              {
                ok: false,
                code: 'too_many_requests',
                error: `Too many sign-in attempts. Try again in ${verdict.retryAfterSeconds} second(s).`,
                requestId,
              },
              requestId,
            )
            return
          }
        }

        const result = await store.write((database) => {
          const context: authCommands.AuthContext = {
            database,
            adminToken,
            requestId,
            ip,
            userAgent: String(request.headers['user-agent'] ?? '').slice(0, 200),
            now: Date.now(),
            policy: buildPolicy(database),
            // The session token reaches the browser only as a cookie. Commands hand
            // it here rather than returning it, so it cannot end up in a body.
            issueSession: (token) => setAdminCookie(response, token),
          }
          try {
            const value = handler(context, payload)
            return { ok: true as const, value }
          } catch (error) {
            if (error instanceof AuthError) {
              return {
                ok: false as const,
                code: error.code,
                error: error.message,
                retryAfterSeconds: error.retryAfterSeconds,
              }
            }
            throw error
          }
        })
        authLimiter.prune()
        limiter.prune()
        voterAuthLimiter.prune()

        if (result.ok) {
          sendJson(response, 200, { ...result, requestId }, requestId)
        } else {
          if (result.retryAfterSeconds) response.setHeader('Retry-After', String(result.retryAfterSeconds))
          sendJson(response, statusForCode(result.code), { ...result, requestId }, requestId)
        }
        return
      }

      /* ---------------------------------------------------------- command --- */
      if (request.method !== 'POST') {
        response.statusCode = 405
        response.setHeader('Allow', 'POST')
        response.end()
        return
      }

      /*
       * Voter authentication gets its own, much tighter budget than ordinary
       * API traffic, keyed on the address and the identifier together.
       *
       * The per-challenge attempt cap bounds guesses against one code, but that
       * cap is per challenge and a caller can request a fresh one. This limiter
       * is what bounds the *rate* of asking, so code guessing stays expensive
       * even for a caller who never runs out of challenges.
       */
      if (action === 'voter.begin' || action === 'voter.verify') {
        const identifier =
          typeof payload.voterId === 'string'
            ? String(payload.voterId).trim().toUpperCase()
            : typeof payload.challengeId === 'string'
              ? String(payload.challengeId)
              : ''
        const verdict = voterAuthLimiter.check(normaliseClientKey(ip, identifier))
        if (!verdict.allowed) {
          response.setHeader('Retry-After', String(verdict.retryAfterSeconds))
          sendJson(
            response,
            429,
            {
              ok: false,
              code: 'too_many_requests',
              error: `Too many verification attempts. Try again in ${verdict.retryAfterSeconds} second(s).`,
              requestId,
            },
            requestId,
          )
          return
        }
      }

      const verdict = limiter.check(normaliseClientKey(ip))
      if (!verdict.allowed) {
        response.setHeader('Retry-After', String(verdict.retryAfterSeconds))
        sendJson(
          response,
          429,
          {
            ok: false,
            code: 'too_many_requests',
            error: `Too many requests. Try again in ${verdict.retryAfterSeconds} second(s).`,
            requestId,
          },
          requestId,
        )
        return
      }

      const controlHandler = routeFor(CONTROL_ROUTES, action)
      if (controlHandler) {
        const result = await store.write((database) => {
          const context: control.ControlContext = {
            database,
            session: resolveSession(database, adminToken),
            requestId,
            ip,
            now: Date.now(),
            backups,
            databasePath: store.filePath,
            startedAt,
            onDatabaseReplaced,
            revealDemoCodes,
          }
          try {
            return { ok: true as const, value: controlHandler(context, payload) }
          } catch (error) {
            if (error instanceof control.ControlError) {
              return { ok: false as const, code: error.code, error: error.message }
            }
            if (error instanceof AuthorizationError) {
              return { ok: false as const, code: error.code, error: error.message }
            }
            throw error
          }
        })

        if (result.ok && typeof result.value === 'object' && result.value !== null && 'ok' in result.value) {
          const inner = result.value as { ok: boolean; code?: string; error?: string; elevation?: string; reason?: string }
          if (!inner.ok) {
            sendJson(
              response,
              statusForCode(inner.code ?? 'forbidden'),
              { ok: false, code: inner.code, error: inner.error, elevation: inner.elevation, reason: inner.reason, requestId },
              requestId,
            )
            return
          }
        }
        sendJson(response, 200, { ...(result.value as object), requestId }, requestId)
        return
      }

      // Everything else goes through the election command handler, but only
      // after the authorisation table has approved the command.
      // Read-only commands must not take the write path: every write bumps the
      // revision and flushes the database to disk, and the voter portal polls
      // the state endpoint every few seconds. Both are invoked as bound methods
      // so the store keeps its receiver.
      const runner = READ_ONLY_COMMANDS.has(action)
        ? <T>(work: (database: SqlDatabase) => T) => store.read(work)
        : <T>(work: (database: SqlDatabase) => T) => store.write(work)
      /**
       * Collects the cookies a command sets, so several can be issued on one
       * response. `Set-Cookie` is a repeatable header; replacing it would lose
       * every cookie but the last.
       */
      const issuedCookies: string[] = []
      const setCookie = (serialized: string) => {
        issuedCookies.push(serialized)
      }
      const result = await runner(async (database) => {
        const session = resolveSession(database, adminToken)
        // Code disclosure is on if the deployment asked for it at startup, or if an
        // administrator switched it on. Resolved here so behaviour and the health
        // report can never disagree about the same question.
        const codeDisclosureOn = revealDemoCodes || readSettings(database).revealDemoPasscodes
        const context: CommandContext = {
          database,
          adminToken,
          voterToken,
          now: Date.now(),
          revealDemoCodes: codeDisclosureOn,
          session,
          requestId,
          ip,
          userAgent: String(request.headers['user-agent'] ?? '').slice(0, 200),
          // The ballot integrity key is derived from the database's location, so the
          // command context needs to know where that is.
          databasePath: store.filePath,
          voterCredential: readCookie(request, CREDENTIAL_COOKIE),
          voterReceipt: readCookie(request, RECEIPT_COOKIE),
          /*
           * The session token reaches the browser only as a cookie. A handler
           * calls this and the transport records the header; nothing in the
           * command result ever carries it.
           *
           * One command can set more than one cookie — verification mints the
           * session and the voting credential together — so these accumulate as
           * a list and are written once at the end. `setHeader` would replace the
           * previous value, which silently dropped the session and left the
           * voter unable to open the ballot they had just verified for.
           */
          setVoterSession: (token) => {
            setCookie(
              token === null
                ? clearSessionCookie(secureCookies)
                : serializeSessionCookie(token, VOTER_SESSION_MAX_AGE_MS / 1000, secureCookies),
            )
          },
          setVoterCredential: (token) => {
            setCookie(
              token === null
                ? clearSecretCookie(CREDENTIAL_COOKIE, secureCookies)
                : serializeSecretCookie(CREDENTIAL_COOKIE, token, credentialCookieTtl, secureCookies),
            )
          },
          setVoterReceipt: (code) => {
            setCookie(
              code === null
                ? clearSecretCookie(RECEIPT_COOKIE, secureCookies)
                : serializeSecretCookie(RECEIPT_COOKIE, code, receiptCookieTtl, secureCookies),
            )
          },
        }
        try {
          const permission = resolveCommandPermission(action, payload)
          if (permission) {
            const verdict = enforce({
              database,
              session,
              permission,
              action,
              resource: typeof payload.electionId === 'string' ? payload.electionId : action,
              requestId,
              ip,
              electionId: typeof payload.electionId === 'string' ? payload.electionId : null,
              approvalToken: typeof payload.approvalToken === 'string' ? payload.approvalToken : null,
              now: context.now,
            })
            if (!verdict.ok) {
              return {
                ok: false as const,
                code: verdict.code,
                error: verdict.message,
                elevation: verdict.elevation,
                reason: verdict.reason,
              }
            }
          }
          return await dispatchCommand(context, action as never, payload)
        } catch (error) {
          if (error instanceof CommandError) return { ok: false as const, code: error.code, error: error.message }
          if (error instanceof ValidationError) return { ok: false as const, code: 'invalid', error: error.message }
          if (error instanceof AuthorizationError) return { ok: false as const, code: error.code, error: error.message }
          throw error
        }
      })

      // Set before the body is written, because `sendJson` ends the response and
      // headers are immutable afterwards. Only a command that actually ran can
      // have asked for a cookie, because a rejected one never reaches the code
      // that mints one.
      if (issuedCookies.length > 0) {
        response.setHeader('Set-Cookie', issuedCookies)
      }
      if (result.ok) {
        sendJson(response, 200, { ...result, requestId }, requestId)
      } else {
        const code = result.code ?? 'internal'
        sendJson(
          response,
          statusForCode(code),
          { ...result, requestId },
          requestId,
        )
      }
    } catch (error) {
      if ((error as Error).message === 'PAYLOAD_TOO_LARGE') {
        sendJson(response, 413, { ok: false, code: 'invalid', error: 'Request body was too large.', requestId }, requestId)
        return
      }
      logger.warn(`[election-api ${requestId}] ${(error as Error).message}`)
      sendJson(response, 500, { ok: false, code: 'internal', error: 'The server could not complete that request.', requestId }, requestId)
    }
  }
}

export { parseCookies }
