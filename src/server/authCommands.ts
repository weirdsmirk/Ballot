/**
 * Sign-in commands.
 *
 * These run before a session exists, so they cannot use the standard
 * authorisation path. They are protected instead by the rate limiter, the
 * account lockout policy, and the fact that a password alone never opens a
 * session when a second factor is configured.
 */

import { recordAudit } from './audit'
import {
  beginMfaSetup,
  confirmMfa,
  countAdmins,
  createAdmin,
  disableMfa,
  findAdminByUsername,
  findAdminRow,
  loginWithMfa,
  loginWithPassword,
  logout,
  markMfaVerified,
  markReauthenticated,
  mfaEnabled,
  passwordProblem,
  resolveSession,
  setPassword,
  verifySecondFactor,
  type LoginPolicy,
} from './auth'
import type { SqlDatabase } from './db'
import type { AdminSession } from '../lib/adminTypes'
import { recordSecurityEvent } from './security'
import { readSettings } from './settings'

export class AuthError extends Error {
  constructor(readonly code: string, message: string, readonly retryAfterSeconds?: number) {
    super(message)
    this.name = 'AuthError'
  }
}

/**
 * A session as it leaves the server.
 *
 * `token` is dropped deliberately. The credential lives in an `HttpOnly` cookie
 * that the page cannot read, so putting it in the body as well would hand a
 * copy to anything that can observe a response — a proxy log, a devtools
 * network panel, an error report — for no benefit. The interface never needed it;
 * every authenticated request re-presents the cookie.
 *
 * The nested `admin` record is rebuilt field by field rather than spread, so a
 * column added to `admins` later cannot start leaking through this response by
 * default.
 */
export function publicSession(session: AdminSession | null) {
  if (!session) return null
  return {
    admin: {
      id: session.admin.id,
      username: session.admin.username,
      display_name: session.admin.display_name,
      role: session.admin.role,
      mfa_enabled: session.admin.mfa_enabled,
      disabled: session.admin.disabled,
      last_login_at: session.admin.last_login_at,
    },
    expires_at: session.expires_at,
    mfa_verified_at: session.mfa_verified_at,
    reauth_verified_at: session.reauth_verified_at,
    created_at: session.created_at,
    ip: session.ip,
  }
}

export type AuthContext = {
  database: SqlDatabase
  adminToken: string | null
  requestId: string
  ip: string | null
  userAgent: string | null
  now: number
  policy: LoginPolicy
  /**
   * Set by the transport. Mints or clears the administrator session cookie.
   *
   * A session token must never travel back through a return value, because a
   * return value is serialised into the response body. Handing it to the transport
   * here means there is no path from a command to the response that carries the
   * credential, so stripping it in {@link publicSession} is structural rather than
   * a rule someone has to remember.
   */
  issueSession?: (token: string | null) => void
}

function readRecord(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new AuthError('invalid', 'Expected an object payload.')
  }
  return payload as Record<string, unknown>
}

function policyOf(context: AuthContext): LoginPolicy {
  const settings = readSettings(context.database)
  return {
    maxAttempts: settings.maxLoginAttempts,
    lockoutMinutes: settings.lockoutMinutes,
    sessionIdleMinutes: settings.sessionIdleMinutes,
    requireMfa: settings.requireMfa,
  }
}

/** Tells the sign-in screen whether an account still needs its first admin. */
export function mfaStatus(context: AuthContext, payload: unknown) {
  const body = readRecord(payload)
  const username = typeof body.username === 'string' ? body.username.trim().toLowerCase() : ''
  if (!username) return { needsBootstrap: countAdmins(context.database) === 0, mfaEnabled: false }
  const account = findAdminByUsername(context.database, username)
  return {
    needsBootstrap: countAdmins(context.database) === 0,
    mfaEnabled: Boolean(account?.mfa_enabled),
  }
}

export function bootstrap(context: AuthContext, payload: unknown) {
  const body = readRecord(payload)
  if (countAdmins(context.database) > 0) {
    throw new AuthError('conflict', 'An administrator account already exists. Sign in instead.')
  }
  const username = String(body.username ?? '').trim().toLowerCase()
  const displayName = String(body.display_name ?? '').trim() || 'Administrator'
  const password = String(body.password ?? '')
  if (!/^[a-z0-9][a-z0-9._-]{2,39}$/.test(username)) {
    throw new AuthError('invalid', 'Username must be 3-40 characters using letters, numbers, dots, hyphens or underscores.')
  }
  const problem = passwordProblem(password)
  if (problem) throw new AuthError('invalid', problem)

  // The first account owns the platform, so it is the super administrator.
  const admin = createAdmin(context.database, {
    username,
    display_name: displayName,
    password,
    role: 'super_admin',
  })
  recordSecurityEvent(context.database, {
    kind: 'admin_created',
    summary: `First administrator "${username}" was created with super admin role.`,
    requestId: context.requestId,
    adminId: admin.id,
    adminLabel: admin.display_name,
    ip: context.ip,
    detail: { username, role: 'super_admin', bootstrap: true },
  })
  recordAudit(context.database, {
    requestId: context.requestId,
    actorType: 'admin',
    actorId: admin.id,
    actorLabel: admin.display_name,
    actorRole: admin.role,
    action: 'admin_bootstrap',
    resource: `admin:${admin.id}`,
    summary: `${admin.display_name} created the first administrator account.`,
    detail: { username },
    ip: context.ip,
  })

  // Sign the new account straight in so they are not asked to type it twice.
  const result = loginWithPassword(
    context.database,
    username,
    password,
    policyOf(context),
    context.ip,
    context.userAgent,
  )
  if (!result.ok || result.kind !== 'session') {
    throw new AuthError('internal', 'The account was created but sign-in failed.')
  }
  context.issueSession?.(result.session.token)
  return { session: publicSession(result.session), admin }
}

export function login(context: AuthContext, payload: unknown) {
  const body = readRecord(payload)
  const username = String(body.username ?? '').trim().toLowerCase()
  const password = String(body.password ?? '')
  if (!username || !password) throw new AuthError('invalid', 'Enter your username and password.')

  const result = loginWithPassword(
    context.database,
    username,
    password,
    policyOf(context),
    context.ip,
    context.userAgent,
  )

  if (!result.ok) {
    recordSecurityEvent(context.database, {
      kind: result.reason === 'locked' ? 'account_locked' : 'login_failure',
      summary: `Failed sign-in for "${username}": ${result.message}`,
      requestId: context.requestId,
      ip: context.ip,
      detail: { username, reason: result.reason },
    })
    recordAudit(context.database, {
      requestId: context.requestId,
      actorType: 'admin',
      actorLabel: username || 'unknown',
      action: 'admin_login',
      resource: 'session',
      result: 'failure',
      summary: `Failed sign-in for "${username}".`,
      detail: { reason: result.reason },
      ip: context.ip,
    })
    throw new AuthError(result.reason === 'invalid' ? 'invalid' : result.reason, result.message, result.retryAfterSeconds)
  }

  if (result.kind === 'mfa_required') {
    // No session exists yet: the second factor must be presented first.
    recordAudit(context.database, {
      requestId: context.requestId,
      actorType: 'admin',
      actorLabel: username,
      action: 'admin_login',
      resource: 'session',
      summary: `Password accepted for "${username}"; a second factor is required.`,
      ip: context.ip,
    })
    return { mfaRequired: true, session: null }
  }

  recordSecurityEvent(context.database, {
    kind: 'login_success',
    summary: `${result.session.admin.display_name} signed in.`,
    requestId: context.requestId,
    adminId: result.session.admin.id,
    adminLabel: result.session.admin.display_name,
    ip: context.ip,
  })
  recordAudit(context.database, {
    requestId: context.requestId,
    actorType: 'admin',
    actorId: result.session.admin.id,
    actorLabel: result.session.admin.display_name,
    actorRole: result.session.admin.role,
    action: 'admin_login',
    resource: 'session',
    summary: `${result.session.admin.display_name} signed in.`,
    detail: { mfa: result.session.admin.mfa_enabled },
    ip: context.ip,
  })
  context.issueSession?.(result.session.token)
  return { session: publicSession(result.session), mfaRequired: false }
}

export function mfaVerify(context: AuthContext, payload: unknown) {
  const body = readRecord(payload)
  const username = String(body.username ?? '').trim().toLowerCase()
  const code = String(body.code ?? '').trim()
  if (!username || !code) throw new AuthError('invalid', 'Enter your verification code.')

  const result = loginWithMfa(context.database, username, code, context.ip, context.userAgent)
  if (!result.ok) {
    recordSecurityEvent(context.database, {
      kind: 'mfa_failed',
      summary: `Failed second factor for "${username}".`,
      requestId: context.requestId,
      ip: context.ip,
      detail: { username },
    })
    recordAudit(context.database, {
      requestId: context.requestId,
      actorType: 'admin',
      actorLabel: username,
      action: 'admin_mfa_verify',
      resource: 'session',
      result: 'failure',
      summary: `Failed second factor for "${username}".`,
      ip: context.ip,
    })
    throw new AuthError('invalid', result.message)
  }

  recordSecurityEvent(context.database, {
    kind: 'login_success',
    summary: `${result.session.admin.display_name} signed in with a second factor.`,
    requestId: context.requestId,
    adminId: result.session.admin.id,
    adminLabel: result.session.admin.display_name,
    ip: context.ip,
  })
  context.issueSession?.(result.session.token)
  return { session: publicSession(result.session) }
}

export function logoutCommand(context: AuthContext) {
  const session = resolveSession(context.database, context.adminToken)
  logout(context.database, context.adminToken)
  context.issueSession?.(null)
  if (session) {
    recordSecurityEvent(context.database, {
      kind: 'logout',
      summary: `${session.admin.display_name} signed out.`,
      requestId: context.requestId,
      adminId: session.admin.id,
      adminLabel: session.admin.display_name,
      ip: context.ip,
    })
    recordAudit(context.database, {
      requestId: context.requestId,
      actorType: 'admin',
      actorId: session.admin.id,
      actorLabel: session.admin.display_name,
      actorRole: session.admin.role,
      action: 'admin_logout',
      resource: 'session',
      summary: `${session.admin.display_name} signed out.`,
      ip: context.ip,
    })
  }
  return { signedOut: true }
}

export function currentSession(context: AuthContext) {
  const session = resolveSession(context.database, context.adminToken)
  if (!session) return { session: null }
  return { session: publicSession(session) }
}

/** Re-enter the password to satisfy step-up elevation for a critical action. */
export function reauthenticate(context: AuthContext, payload: unknown) {
  const session = resolveSession(context.database, context.adminToken)
  if (!session) throw new AuthError('unauthorized', 'Sign in to continue.')
  const body = readRecord(payload)
  const password = String(body.password ?? '')
  if (!password) throw new AuthError('invalid', 'Enter your password.')

  const account = findAdminByUsername(context.database, session.admin.username)
  if (!account) throw new AuthError('unauthorized', 'This account no longer exists.')
  const policy = policyOf(context)
  const result = loginWithPassword(context.database, account.username, password, policy, context.ip, context.userAgent)
  if (!result.ok) {
    recordSecurityEvent(context.database, {
      kind: 'login_failure',
      summary: `Failed step-up verification for "${account.username}".`,
      requestId: context.requestId,
      adminId: account.id,
      adminLabel: account.display_name,
      ip: context.ip,
    })
    throw new AuthError('invalid', 'That password is not correct.')
  }

  markReauthenticated(context.database, session.token)
  recordAudit(context.database, {
    requestId: context.requestId,
    actorType: 'admin',
    actorId: account.id,
    actorLabel: account.display_name,
    actorRole: account.role,
    action: 'admin_reauthenticated',
    resource: 'session',
    summary: `${account.display_name} re-entered their password to authorise a critical action.`,
    ip: context.ip,
  })
  return { verified: true, expiresInSeconds: 300 }
}

/**
 * Re-present a second factor against the session that is already open.
 *
 * This is what satisfies `mfa` elevation without ending and restarting the
 * session: the operator is already signed in, but an action demands a fresh
 * second factor. The check is the same one sign-in uses, so a password alone can
 * never satisfy it.
 */
export function mfaStepUp(context: AuthContext, payload: unknown) {
  const session = resolveSession(context.database, context.adminToken)
  if (!session) throw new AuthError('unauthorized', 'Sign in to continue.')
  const body = readRecord(payload)
  const code = String(body.code ?? '').trim()
  if (!code) throw new AuthError('invalid', 'Enter your verification code.')

  const account = findAdminByUsername(context.database, session.admin.username)
  if (!account || !account.mfa_enabled || !account.mfa_secret) {
    throw new AuthError('invalid', 'No second factor is configured on this account.')
  }

  const factor = verifySecondFactor(context.database, account, code)
  if (!factor.ok) {
    recordSecurityEvent(context.database, {
      kind: 'mfa_failed',
      summary: `${session.admin.display_name} entered an invalid code while authorising a critical action.`,
      requestId: context.requestId,
      adminId: account.id,
      adminLabel: account.display_name,
      ip: context.ip,
    })
    recordAudit(context.database, {
      requestId: context.requestId,
      actorType: 'admin',
      actorId: account.id,
      actorLabel: account.display_name,
      actorRole: account.role,
      action: 'admin_mfa_stepup_failed',
      resource: 'session',
      result: 'failure',
      summary: `${account.display_name} failed step-up verification for a critical action.`,
      ip: context.ip,
    })
    throw new AuthError('invalid', 'That verification code is not correct.')
  }

  markMfaVerified(context.database, session.token)
  if (factor.usedRecovery) {
    recordSecurityEvent(context.database, {
      kind: 'mfa_recovery_used',
      severity: 'warning',
      summary: `${account.display_name} authorised a critical action with a recovery code.`,
      requestId: context.requestId,
      adminId: account.id,
      adminLabel: account.display_name,
      ip: context.ip,
    })
  }
  recordAudit(context.database, {
    requestId: context.requestId,
    actorType: 'admin',
    actorId: account.id,
    actorLabel: account.display_name,
    actorRole: account.role,
    action: 'admin_mfa_stepup',
    resource: 'session',
    summary: `${account.display_name} satisfied a second factor to authorise a critical action.`,
    detail: { usedRecovery: factor.usedRecovery },
    ip: context.ip,
  })
  return { verified: true }
}

/** Enrol or remove a second factor for the signed-in administrator. */
export function mfaManage(context: AuthContext, payload: unknown) {
  const session = resolveSession(context.database, context.adminToken)
  if (!session) throw new AuthError('unauthorized', 'Sign in to continue.')
  const body = readRecord(payload)
  const action = String(body.action ?? '')

  if (action === 'begin') {
    const setup = beginMfaSetup(context.database, session.admin.id, session.admin.username)
    return { setup }
  }
  if (action === 'confirm') {
    const code = String(body.code ?? '')
    if (!confirmMfa(context.database, session.admin.id, code)) {
      recordSecurityEvent(context.database, {
        kind: 'mfa_failed',
        summary: `${session.admin.display_name} entered an invalid code while enrolling a second factor.`,
        requestId: context.requestId,
        adminId: session.admin.id,
        adminLabel: session.admin.display_name,
        ip: context.ip,
      })
      throw new AuthError('invalid', 'That code was not accepted. Check your authenticator and try again.')
    }
    markMfaVerified(context.database, session.token)
    recordSecurityEvent(context.database, {
      kind: 'mfa_enabled',
      summary: `${session.admin.display_name} enabled a second factor.`,
      requestId: context.requestId,
      adminId: session.admin.id,
      adminLabel: session.admin.display_name,
      ip: context.ip,
    })
    recordAudit(context.database, {
      requestId: context.requestId,
      actorType: 'admin',
      actorId: session.admin.id,
      actorLabel: session.admin.display_name,
      actorRole: session.admin.role,
      action: 'mfa_enabled',
      resource: `admin:${session.admin.id}`,
      summary: `${session.admin.display_name} enabled a second factor.`,
      ip: context.ip,
    })
    return { enabled: true }
  }
  if (action === 'disable') {
    // Disabling a factor is itself a sensitive change, so it needs the password
    // again, plus a working second factor where one is configured.
    const password = String(body.password ?? '')
    const account = findAdminByUsername(context.database, session.admin.username)
    if (!account) throw new AuthError('unauthorized', 'This account no longer exists.')
    const verified = loginWithPassword(
      context.database,
      account.username,
      password,
      policyOf(context),
      context.ip,
      context.userAgent,
    )
    if (!verified.ok) throw new AuthError('invalid', 'Confirm your password to remove the second factor.')
    if (mfaEnabled(context.database, session.admin.id)) {
      const code = String(body.code ?? '')
      const factor = loginWithMfa(context.database, session.admin.username, code, context.ip, context.userAgent)
      if (!factor.ok) throw new AuthError('invalid', 'Enter a current code from your authenticator to continue.')
    }
    disableMfa(context.database, session.admin.id)
    recordSecurityEvent(context.database, {
      kind: 'mfa_disabled',
      severity: 'warning',
      summary: `${session.admin.display_name} removed their second factor.`,
      requestId: context.requestId,
      adminId: session.admin.id,
      adminLabel: session.admin.display_name,
      ip: context.ip,
    })
    recordAudit(context.database, {
      requestId: context.requestId,
      actorType: 'admin',
      actorId: session.admin.id,
      actorLabel: session.admin.display_name,
      actorRole: session.admin.role,
      action: 'mfa_disabled',
      resource: `admin:${session.admin.id}`,
      summary: `${session.admin.display_name} removed their second factor.`,
      ip: context.ip,
    })
    return { enabled: false }
  }
  if (action === 'status') {
    const row = findAdminRow(context.database, session.admin.id)
    return { enabled: Number(row?.mfa_enabled) === 1 }
  }
  throw new AuthError('invalid', 'Unknown action.')
}

/** Let an administrator change their own password. */
export function changeOwnPassword(context: AuthContext, payload: unknown) {
  const session = resolveSession(context.database, context.adminToken)
  if (!session) throw new AuthError('unauthorized', 'Sign in to continue.')
  const body = readRecord(payload)
  const current = String(body.currentPassword ?? '')
  const next = String(body.newPassword ?? '')
  const problem = passwordProblem(next)
  if (problem) throw new AuthError('invalid', problem)

  const account = findAdminByUsername(context.database, session.admin.username)
  if (!account) throw new AuthError('unauthorized', 'This account no longer exists.')
  const check = loginWithPassword(
    context.database,
    account.username,
    current,
    policyOf(context),
    context.ip,
    context.userAgent,
  )
  if (!check.ok) throw new AuthError('invalid', 'Your current password is not correct.')
  if (current === next) throw new AuthError('invalid', 'Choose a password different from the current one.')

  setPassword(context.database, session.admin.id, next, false)
  markReauthenticated(context.database, session.token)
  recordSecurityEvent(context.database, {
    kind: 'password_changed',
    summary: `${session.admin.display_name} changed their own password.`,
    requestId: context.requestId,
    adminId: session.admin.id,
    adminLabel: session.admin.display_name,
    ip: context.ip,
  })
  recordAudit(context.database, {
    requestId: context.requestId,
    actorType: 'admin',
    actorId: session.admin.id,
    actorLabel: session.admin.display_name,
    actorRole: session.admin.role,
    action: 'admin_password_changed',
    resource: `admin:${session.admin.id}`,
    summary: `${session.admin.display_name} changed their own password.`,
    ip: context.ip,
  })
  return { changed: true }
}

