/**
 * Administrator authentication.
 *
 * Responsibilities, in the order they matter:
 *
 * 1. Passwords are hashed with scrypt using a per-account random salt and
 *    compared in constant time.
 * 2. Repeated failures lock the account for a configurable window, persisted in
 *    the database so it survives a restart.
 * 3. Sessions are opaque random tokens held server side. They carry the
 *    timestamps proving a second factor and a fresh password entry, and they can
 *    be revoked individually or per account.
 * 4. Optional TOTP gives a real second factor, with single-use recovery codes
 *    stored only as hashes.
 */

import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import {
  execute,
  lastInsertId,
  queryAll,
  queryOne,
  queryScalar,
  text,
  type SqlDatabase,
} from './db'
import {
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  normaliseRecoveryCode,
  totpUri,
  verifyTotp,
} from '../lib/totp'
import { isAdminRole, type AdminRole } from '../lib/rbac'
import { recordSecurityEvent } from './security'
import type { AdminAccount, AdminSession, AdminSessionSummary, MfaSetup } from '../lib/adminTypes'

const KEY_LENGTH = 64
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 } as const
/** How long a fresh password entry satisfies step-up elevation. */
export const REAUTH_GRACE_MS = 5 * 60 * 1000
/** How long a satisfied second factor counts as fresh. */
export const MFA_GRACE_MS = 30 * 60 * 1000
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000

export type LoginPolicy = {
  maxAttempts: number
  lockoutMinutes: number
  sessionIdleMinutes: number
  requireMfa: boolean
}

/* ------------------------------------------------------------- passwords --- */

export function hashPassword(password: string): string {
  const salt = randomBytes(16)
  const derived = scryptSync(password.normalize('NFKC'), salt, KEY_LENGTH, SCRYPT_PARAMS)
  return `scrypt$${SCRYPT_PARAMS.N}$${SCRYPT_PARAMS.r}$${SCRYPT_PARAMS.p}$${salt.toString('base64')}$${derived.toString('base64')}`
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const cost = Number(parts[1])
  const blockSize = Number(parts[2])
  const parallelisation = Number(parts[3])
  if (!Number.isInteger(cost) || !Number.isInteger(blockSize) || !Number.isInteger(parallelisation)) return false
  if (cost < 1024 || cost > 1 << 20 || blockSize < 1 || blockSize > 32 || parallelisation < 1 || parallelisation > 16) {
    return false
  }
  let expected: Buffer
  try {
    expected = Buffer.from(parts[5], 'base64')
  } catch {
    return false
  }
  if (expected.length === 0) return false
  let derived: Buffer
  try {
    derived = scryptSync(password.normalize('NFKC'), Buffer.from(parts[4], 'base64'), expected.length, {
      N: cost,
      r: blockSize,
      p: parallelisation,
    })
  } catch {
    return false
  }
  return derived.length === expected.length && timingSafeEqual(derived, expected)
}

/** Reject the obvious weak passwords rather than hashing them. */
export function passwordProblem(password: string): string | null {
  if (password.length < 12) return 'Password must be at least 12 characters.'
  if (password.length > 200) return 'Password must be 200 characters or fewer.'
  if (/^(password|qwerty|admin|letmein|iloveyou|welcome)/i.test(password)) {
    return 'That password is too common. Choose something less predictable.'
  }
  let classes = 0
  if (/[a-z]/.test(password)) classes += 1
  if (/[A-Z]/.test(password)) classes += 1
  if (/[0-9]/.test(password)) classes += 1
  if (/[^A-Za-z0-9]/.test(password)) classes += 1
  if (classes < 3) return 'Use at least three of: lower case, upper case, digits, symbols.'
  return null
}

export function createSessionToken(): string {
  return randomBytes(32).toString('base64url')
}

/**
 * The value the database holds for a session token.
 *
 * A plain SHA-256 is the right primitive here rather than a password hash: the
 * input is 256 bits of CSPRNG output, so there is nothing to brute force, and
 * every request has to verify it, where a deliberately slow hash would be a
 * denial-of-service lever. Hashing means a copy of the database is a list of
 * sessions rather than a set of working credentials.
 */
function sessionDigest(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** Human-friendly receipt code, e.g. `9F2A-77C1-B0E4`. */
export function createReceiptCode(): string {
  return randomBytes(9)
    .toString('hex')
    .toUpperCase()
    .replace(/(.{4})(?=.)/g, '$1-')
}

/* ---------------------------------------------------------------- records --- */

function roleOf(value: unknown): AdminRole {
  return isAdminRole(value) ? value : 'observer'
}

export function toAdmin(row: Record<string, unknown>): AdminAccount {
  return {
    id: Number(row.id ?? 0),
    username: text(row.username),
    display_name: text(row.display_name),
    role: roleOf(row.role),
    created_at: text(row.created_at),
    last_login_at: typeof row.last_login_at === 'string' && row.last_login_at ? row.last_login_at : null,
    mfa_enabled: Number(row.mfa_enabled) === 1,
    locked_until: typeof row.locked_until === 'string' && row.locked_until ? row.locked_until : null,
    failed_attempts: Number(row.failed_attempts) || 0,
    must_change_password: Number(row.must_change_password) === 1,
    disabled: Number(row.disabled) === 1,
  }
}

export function countAdmins(database: SqlDatabase): number {
  return queryScalar(database, 'SELECT COUNT(*) AS total FROM admins')
}

export function listAdmins(database: SqlDatabase): AdminAccount[] {
  return queryAll(database, 'SELECT * FROM admins ORDER BY id').map(toAdmin)
}

export function findAdminRow(database: SqlDatabase, id: number): Record<string, unknown> | null {
  return queryOne(database, 'SELECT * FROM admins WHERE id = ?', [id])
}

export function findAdminByUsername(
  database: SqlDatabase,
  username: string,
): (AdminAccount & { password_hash: string; mfa_secret: string | null }) | null {
  const row = queryOne(database, 'SELECT * FROM admins WHERE username = ?', [username.toLowerCase()])
  if (!row) return null
  return {
    ...toAdmin(row),
    password_hash: text(row.password_hash),
    mfa_secret: typeof row.mfa_secret === 'string' && row.mfa_secret ? row.mfa_secret : null,
  }
}

export function createAdmin(
  database: SqlDatabase,
  input: {
    username: string
    display_name: string
    password: string
    role: AdminRole
    mustChangePassword?: boolean
  },
): AdminAccount {
  const now = new Date().toISOString()
  execute(
    database,
    `INSERT INTO admins (username, display_name, password_hash, role, created_at, must_change_password)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      input.username.toLowerCase(),
      input.display_name,
      hashPassword(input.password),
      input.role,
      now,
      input.mustChangePassword ? 1 : 0,
    ],
  )
  const row = findAdminRow(database, lastInsertId(database))
  return toAdmin(row ?? {})
}

/* ------------------------------------------------------------------ login --- */

export type LoginOutcome =
  | { ok: true; kind: 'session'; session: AdminSession }
  | { ok: true; kind: 'mfa_required' }
  | {
      ok: false
      reason: 'invalid' | 'locked' | 'disabled'
      message: string
      retryAfterSeconds?: number
    }

function isLocked(admin: AdminAccount, now: number): number {
  if (!admin.locked_until) return 0
  const until = Date.parse(admin.locked_until)
  if (!Number.isFinite(until) || until <= now) return 0
  return Math.ceil((until - now) / 1000)
}

function registerFailure(database: SqlDatabase, admin: AdminAccount, policy: LoginPolicy, ip: string | null, now: number) {
  const attempts = admin.failed_attempts + 1
  const lock = attempts >= policy.maxAttempts
  const lockedUntil = lock ? new Date(now + policy.lockoutMinutes * 60_000).toISOString() : null
  execute(
    database,
    'UPDATE admins SET failed_attempts = ?, last_failed_at = ?, last_login_ip = ?, locked_until = ? WHERE id = ?',
    [lock ? 0 : attempts, new Date(now).toISOString(), ip, lockedUntil, admin.id],
  )
  return { locked: lock, lockedUntil, attempts }
}

function purgeExpiredSessions(database: SqlDatabase, now: string): void {
  execute(database, 'DELETE FROM admin_sessions WHERE expires_at < ?', [now])
}

function openSession(
  database: SqlDatabase,
  admin: AdminAccount,
  ip: string | null,
  userAgent: string | null,
  mfaVerified: boolean,
): AdminSession {
  const now = new Date()
  const token = createSessionToken()
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString()
  const iso = now.toISOString()
  execute(
    database,
    `INSERT INTO admin_sessions (token_hash, admin_id, created_at, expires_at, mfa_verified_at,
      reauth_verified_at, last_seen_at, ip, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [sessionDigest(token), admin.id, iso, expiresAt, mfaVerified ? iso : null, iso, iso, ip, userAgent],
  )
  execute(database, 'UPDATE admins SET last_login_at = ?, last_login_ip = ?, failed_attempts = 0, locked_until = NULL WHERE id = ?', [
    iso,
    ip,
    admin.id,
  ])
  purgeExpiredSessions(database, iso)
  return {
    token,
    admin: { ...admin, last_login_at: iso, failed_attempts: 0, locked_until: null },
    expires_at: expiresAt,
    mfa_verified_at: mfaVerified ? iso : null,
    reauth_verified_at: iso,
    created_at: iso,
    ip,
  }
}

/** First factor: username and password. */
export function loginWithPassword(
  database: SqlDatabase,
  username: string,
  password: string,
  policy: LoginPolicy,
  ip: string | null,
  userAgent: string | null,
): LoginOutcome {
  const now = Date.now()
  const account = findAdminByUsername(database, username)
  // Always run a verification so a missing account and a wrong password take a
  // comparable amount of time and cannot be distinguished by timing.
  const reference = account?.password_hash ?? hashPassword('placeholder-for-timing-equalisation')
  const passwordMatches = verifyPassword(password, reference)

  if (!account || !passwordMatches) {
    if (account) registerFailure(database, account, policy, ip, now)
    return { ok: false, reason: 'invalid', message: 'Incorrect username or password.' }
  }
  if (account.disabled) {
    return { ok: false, reason: 'disabled', message: 'This account has been disabled. Contact a super administrator.' }
  }
  const lockedFor = isLocked(account, now)
  if (lockedFor > 0) {
    return {
      ok: false,
      reason: 'locked',
      message: `Account locked after repeated failed sign-in attempts. Try again in ${Math.ceil(lockedFor / 60)} minute(s).`,
      retryAfterSeconds: lockedFor,
    }
  }

  if (account.mfa_enabled) {
    // No session is opened until the second factor is verified, so a password
    // alone never grants access.
    return { ok: true, kind: 'mfa_required' }
  }
  if (policy.requireMfa && !account.mfa_enabled) {
    return {
      ok: false,
      reason: 'disabled',
      message: 'This platform requires a second factor, but none is configured on this account.',
    }
  }

  const session = openSession(database, account, ip, userAgent, false)
  if (account.must_change_password) {
    session.admin = { ...session.admin, must_change_password: true }
  }
  return { ok: true, kind: 'session', session }
}

/**
 * Second factor: TOTP or a single-use recovery code.
 *
 * Unlike the password step this always opens a session on success, so its
 * success type is narrowed to that case.
 */
export function loginWithMfa(
  database: SqlDatabase,
  username: string,
  code: string,
  ip: string | null,
  userAgent: string | null,
): { ok: true; kind: 'session'; session: AdminSession } | { ok: false; reason: 'invalid' | 'disabled'; message: string } {
  const account = findAdminByUsername(database, username)
  if (!account || !account.mfa_enabled || !account.mfa_secret) {
    return { ok: false, reason: 'invalid', message: 'Incorrect username or password.' }
  }
  if (account.disabled) {
    return { ok: false, reason: 'disabled', message: 'This account has been disabled.' }
  }

  const factor = verifySecondFactor(database, account, code)
  if (!factor.ok) return { ok: false, reason: 'invalid', message: 'That verification code is not correct.' }

  const session = openSession(database, account, ip, userAgent, true)
  if (factor.usedRecovery) {
    recordSecurityEvent(database, {
      kind: 'mfa_recovery_used',
      summary: `${account.display_name} signed in with a recovery code instead of their authenticator.`,
      adminId: account.id,
      adminLabel: account.display_name,
      ip,
      detail: { username: account.username },
    })
  }
  return { ok: true, kind: 'session', session }
}

/**
 * Check a TOTP code or a single-use recovery code without opening a session.
 *
 * Shared by sign-in and by step-up elevation, so a second factor means the same
 * thing in both places. A recovery code is consumed here, once, whichever caller
 * gets there first.
 */
export function verifySecondFactor(
  database: SqlDatabase,
  account: AdminAccount & { mfa_secret: string | null },
  code: string,
): { ok: true; usedRecovery: boolean } | { ok: false } {
  const trimmed = code.trim()
  if (account.mfa_secret && verifyTotp(account.mfa_secret, trimmed)) {
    return { ok: true, usedRecovery: false }
  }

  const salt = text((findAdminRow(database, account.id) ?? {}).mfa_recovery_salt)
  if (!salt) return { ok: false }

  const match = queryOne(
    database,
    'SELECT id FROM recovery_codes WHERE admin_id = ? AND code_hash = ? AND used_at IS NULL',
    [account.id, hashRecoveryCode(trimmed, salt)],
  )
  if (!match) return { ok: false }

  execute(database, 'UPDATE recovery_codes SET used_at = ? WHERE id = ?', [new Date().toISOString(), Number(match.id)])
  return { ok: true, usedRecovery: true }
}

/* --------------------------------------------------------------- sessions --- */

export function resolveSession(database: SqlDatabase, token: string | null): AdminSession | null {
  if (!token) return null
  const digest = sessionDigest(token)
  const row = queryOne(
    database,
    `SELECT s.expires_at AS session_expires_at,
            s.mfa_verified_at AS s_mfa_verified_at, s.reauth_verified_at AS s_reauth_verified_at,
            s.created_at AS s_created_at, s.ip AS s_ip, s.revoked_at AS s_revoked_at, a.*
       FROM admin_sessions s JOIN admins a ON a.id = s.admin_id
      WHERE s.token_hash = ?`,
    [digest],
  )
  if (!row) return null

  const now = Date.now()
  if (text(row.s_revoked_at)) {
    execute(database, 'DELETE FROM admin_sessions WHERE token_hash = ?', [digest])
    return null
  }
  const expiresAt = text(row.session_expires_at)
  if (Date.parse(expiresAt) <= now) {
    execute(database, 'DELETE FROM admin_sessions WHERE token_hash = ?', [digest])
    return null
  }

  const admin = toAdmin(row)
  if (admin.disabled) {
    revokeSession(database, token, 'Account disabled')
    return null
  }

  execute(database, 'UPDATE admin_sessions SET last_seen_at = ? WHERE token_hash = ?', [new Date().toISOString(), digest])

  return {
    // The presented token, carried in memory for the transport to set as a cookie.
    // It is never written to the database.
    token,
    admin,
    expires_at: expiresAt,
    mfa_verified_at: nullable(row.s_mfa_verified_at),
    reauth_verified_at: nullable(row.s_reauth_verified_at),
    created_at: text(row.s_created_at),
    ip: nullable(row.s_ip),
  }
}

function nullable(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null
}

/** Record that the password was just re-entered, satisfying step-up elevation. */
export function markReauthenticated(database: SqlDatabase, token: string): void {
  execute(database, 'UPDATE admin_sessions SET reauth_verified_at = ? WHERE token_hash = ?', [
    new Date().toISOString(),
    sessionDigest(token),
  ])
}

export function markMfaVerified(database: SqlDatabase, token: string): void {
  const now = new Date().toISOString()
  execute(database, 'UPDATE admin_sessions SET mfa_verified_at = ?, reauth_verified_at = ? WHERE token_hash = ?', [
    now,
    now,
    sessionDigest(token),
  ])
}

/** True when the session proved a password recently enough for step-up. */
export function hasFreshReauth(session: AdminSession, now = Date.now()): boolean {
  const at = session.reauth_verified_at ? Date.parse(session.reauth_verified_at) : 0
  return Number.isFinite(at) && now - at <= REAUTH_GRACE_MS
}

/** True when the session satisfied a second factor recently. */
export function hasFreshMfa(session: AdminSession, now = Date.now()): boolean {
  if (!session.mfa_verified_at) return false
  const at = Date.parse(session.mfa_verified_at)
  return Number.isFinite(at) && now - at <= MFA_GRACE_MS
}

export function logout(database: SqlDatabase, token: string | null): void {
  if (!token) return
  execute(database, 'DELETE FROM admin_sessions WHERE token_hash = ?', [sessionDigest(token)])
}

export function revokeSession(database: SqlDatabase, token: string, reason: string): boolean {
  const digest = sessionDigest(token)
  const existing = queryOne(database, 'SELECT id FROM admin_sessions WHERE token_hash = ?', [digest])
  if (!existing) return false
  execute(database, 'UPDATE admin_sessions SET revoked_at = ?, revoked_reason = ? WHERE token_hash = ?', [
    new Date().toISOString(),
    reason,
    digest,
  ])
  return true
}

/** Revoke every session for an account, optionally sparing the current one. */
export function revokeAllSessions(
  database: SqlDatabase,
  adminId: number,
  reason: string,
  exceptToken?: string | null,
): number {
  const exceptDigest = exceptToken ? sessionDigest(exceptToken) : null
  // Revoked in one statement rather than row by row: the caller already knows the
  // account, so there is no need to read the tokens back out to revoke them.
  const before = countActiveSessionsFor(database, adminId)
  if (exceptDigest) {
    execute(
      database,
      'UPDATE admin_sessions SET revoked_at = ?, revoked_reason = ? WHERE admin_id = ? AND revoked_at IS NULL AND token_hash != ?',
      [new Date().toISOString(), reason, adminId, exceptDigest],
    )
  } else {
    execute(
      database,
      'UPDATE admin_sessions SET revoked_at = ?, revoked_reason = ? WHERE admin_id = ? AND revoked_at IS NULL',
      [new Date().toISOString(), reason, adminId],
    )
  }
  return Math.max(0, before - countActiveSessionsFor(database, adminId))
}

function countActiveSessionsFor(database: SqlDatabase, adminId: number): number {
  return queryScalar(
    database,
    'SELECT COUNT(*) AS total FROM admin_sessions WHERE admin_id = ? AND revoked_at IS NULL',
    [adminId],
  )
}

export function listSessions(database: SqlDatabase, currentToken: string | null): AdminSessionSummary[] {
  const currentDigest = currentToken ? sessionDigest(currentToken) : null
  const rows = queryAll(
    database,
    `SELECT s.token_hash, s.admin_id, s.created_at, s.expires_at, s.last_seen_at, s.ip,
            s.revoked_at, s.revoked_reason, s.mfa_verified_at,
            a.username, a.display_name, a.role
       FROM admin_sessions s JOIN admins a ON a.id = s.admin_id
      ORDER BY s.created_at DESC LIMIT 200`,
  )
  return rows.map((row) => {
    const revoked = nullable(row.revoked_at)
    const expires = text(row.expires_at)
    return {
      id: Number(row.admin_id),
      admin_id: Number(row.admin_id),
      username: text(row.username),
      display_name: text(row.display_name),
      role: roleOf(row.role),
      created_at: text(row.created_at),
      expires_at: expires,
      last_seen_at: nullable(row.last_seen_at),
      ip: nullable(row.ip),
      revoked_at: revoked,
      revoked_reason: nullable(row.revoked_reason),
      mfa_verified_at: nullable(row.mfa_verified_at),
      current: currentDigest !== null && text(row.token_hash) === currentDigest,
    } as AdminSessionSummary
  })
}

export function countActiveSessions(database: SqlDatabase): number {
  return queryScalar(
    database,
    'SELECT COUNT(*) AS total FROM admin_sessions WHERE revoked_at IS NULL AND expires_at > ?',
    [new Date().toISOString()],
  )
}

export function unlockAccount(database: SqlDatabase, adminId: number): boolean {
  const row = findAdminRow(database, adminId)
  if (!row) return false
  execute(database, 'UPDATE admins SET locked_until = NULL, failed_attempts = 0 WHERE id = ?', [adminId])
  return true
}

export function setPassword(database: SqlDatabase, adminId: number, password: string, mustChange = false): void {
  execute(database, 'UPDATE admins SET password_hash = ?, must_change_password = ? WHERE id = ?', [
    hashPassword(password),
    mustChange ? 1 : 0,
    adminId,
  ])
}

/* -------------------------------------------------------------------- MFA --- */

export function beginMfaSetup(database: SqlDatabase, adminId: number, username: string): MfaSetup {
  const secret = generateTotpSecret()
  const salt = randomBytes(16).toString('base64')
  const recoveryCodes = generateRecoveryCodes(8)
  execute(database, 'UPDATE admins SET mfa_secret = ?, mfa_recovery_salt = ? WHERE id = ?', [secret, salt, adminId])
  execute(database, 'DELETE FROM recovery_codes WHERE admin_id = ?', [adminId])
  const now = new Date().toISOString()
  for (const code of recoveryCodes) {
    execute(database, 'INSERT INTO recovery_codes (admin_id, code_hash, created_at) VALUES (?, ?, ?)', [
      adminId,
      hashRecoveryCode(code, salt),
      now,
    ])
  }
  return { secret, uri: totpUri(secret, username), recovery_codes: recoveryCodes }
}

export function confirmMfa(database: SqlDatabase, adminId: number, code: string): boolean {
  const row = findAdminRow(database, adminId)
  const secret = typeof row?.mfa_secret === 'string' ? row.mfa_secret : ''
  if (!secret) return false
  if (!verifyTotp(secret, code)) return false
  execute(database, 'UPDATE admins SET mfa_enabled = 1 WHERE id = ?', [adminId])
  return true
}

export function disableMfa(database: SqlDatabase, adminId: number): void {
  execute(database, 'UPDATE admins SET mfa_enabled = 0, mfa_secret = NULL, mfa_recovery_hashes = NULL, mfa_recovery_salt = NULL WHERE id = ?', [
    adminId,
  ])
  execute(database, 'DELETE FROM recovery_codes WHERE admin_id = ?', [adminId])
}

export function mfaEnabled(database: SqlDatabase, adminId: number): boolean {
  const row = findAdminRow(database, adminId)
  return Number(row?.mfa_enabled) === 1
}

export function setDisabled(database: SqlDatabase, adminId: number, disabled: boolean): void {
  execute(database, 'UPDATE admins SET disabled = ? WHERE id = ?', [disabled ? 1 : 0, adminId])
}

export function setRole(database: SqlDatabase, adminId: number, role: AdminRole): void {
  execute(database, 'UPDATE admins SET role = ? WHERE id = ?', [role, adminId])
}

export { normaliseRecoveryCode }

/** Remove expired voter sessions for an election. */
export function pruneVoterSessions(database: SqlDatabase, electionId: string): void {
  execute(database, 'DELETE FROM voter_sessions WHERE election_id = ? AND expires_at < ?', [
    electionId,
    new Date().toISOString(),
  ])
}

export function createVoterSessionToken(): string {
  return randomBytes(24).toString('base64url')
}
