/**
 * Security monitoring.
 *
 * Two responsibilities: a fixed-window rate limiter that protects the API from
 * brute force and flooding, and the security event log that records
 * authentication outcomes, privilege denials, and other events an operator needs
 * to see separately from the general audit trail.
 */

import { execute, lastInsertId, queryAll, queryOne, queryScalar, text, type SqlDatabase } from './db'
import type { SecurityEvent, SecurityEventKind, SecurityEventSeverity } from '../lib/adminTypes'

const SEVERITY: Record<SecurityEventKind, SecurityEventSeverity> = {
  login_success: 'info',
  login_failure: 'notice',
  account_locked: 'warning',
  account_unlocked: 'notice',
  logout: 'info',
  session_revoked: 'notice',
  mfa_enabled: 'notice',
  mfa_disabled: 'warning',
  mfa_failed: 'warning',
  mfa_recovery_used: 'warning',
  password_changed: 'notice',
  rate_limited: 'warning',
  permission_denied: 'warning',
  elevation_required: 'notice',
  voter_verified: 'info',
  voter_verification_failed: 'notice',
  voter_verification_new_address: 'notice',
  voter_session_replayed: 'warning',
  ballot_credential_rejected: 'notice',
  ballot_cast: 'info',
  voter_signed_out: 'info',
  backup_created: 'info',
  backup_restored: 'critical',
  system_reset: 'critical',
  admin_created: 'notice',
  admin_role_changed: 'warning',
  admin_disabled: 'warning',
  origin_rejected: 'warning',
}

export function severityFor(kind: SecurityEventKind): SecurityEventSeverity {
  if (!Object.prototype.hasOwnProperty.call(SEVERITY, kind)) return 'info'
  return SEVERITY[kind] ?? 'info'
}

export function recordSecurityEvent(
  database: SqlDatabase,
  input: {
    kind: SecurityEventKind
    summary: string
    requestId?: string
    adminId?: number | null
    adminLabel?: string
    detail?: unknown
    ip?: string | null
    severity?: SecurityEventSeverity
  },
): void {
  execute(
    database,
    `INSERT INTO security_events (request_id, kind, severity, admin_id, admin_label,
      summary, detail, ip, acknowledged, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    [
      input.requestId ?? '',
      input.kind,
      input.severity ?? severityFor(input.kind),
      input.adminId ?? null,
      input.adminLabel ?? '',
      input.summary,
      JSON.stringify(input.detail ?? {}),
      input.ip ?? null,
      new Date().toISOString(),
    ],
  )
}

function toSecurityEvent(row: Record<string, unknown>): SecurityEvent {
  return {
    id: Number(row.id ?? 0),
    request_id: text(row.request_id),
    kind: text(row.kind) as SecurityEventKind,
    severity: text(row.severity) as SecurityEventSeverity,
    admin_id: typeof row.admin_id === 'number' ? row.admin_id : null,
    admin_label: text(row.admin_label),
    summary: text(row.summary),
    detail: text(row.detail) || '{}',
    ip: nullableString(row.ip),
    acknowledged: Number(row.acknowledged) === 1,
    acknowledged_by: typeof row.acknowledged_by === 'number' ? row.acknowledged_by : null,
    acknowledged_at: nullableString(row.acknowledged_at),
    created_at: text(row.created_at),
  }
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null
}

export type SecurityQuery = {
  kind?: string
  severity?: string
  search?: string
  acknowledged?: boolean
  since?: string
  until?: string
  limit?: number
  offset?: number
}

export function querySecurityEvents(
  database: SqlDatabase,
  filter: SecurityQuery,
): { rows: SecurityEvent[]; total: number } {
  const where: string[] = []
  const params: unknown[] = []

  if (filter.kind) {
    where.push('kind = ?')
    params.push(filter.kind)
  }
  if (filter.severity) {
    where.push('severity = ?')
    params.push(filter.severity)
  }
  if (filter.acknowledged === true) where.push('acknowledged = 1')
  if (filter.acknowledged === false) where.push('acknowledged = 0')
  if (filter.since) {
    where.push('created_at >= ?')
    params.push(filter.since)
  }
  if (filter.until) {
    where.push('created_at <= ?')
    params.push(filter.until)
  }
  if (filter.search) {
    where.push('(summary LIKE ? OR admin_label LIKE ? OR ip LIKE ?)')
    const needle = `%${filter.search}%`
    params.push(needle, needle, needle)
  }

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const total = queryScalar(database, `SELECT COUNT(*) AS total FROM security_events ${clause}`, params)
  const limit = Math.min(500, Math.max(1, filter.limit ?? 50))
  const offset = Math.max(0, filter.offset ?? 0)
  const rows = queryAll(
    database,
    `SELECT * FROM security_events ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  )
  return { rows: rows.map(toSecurityEvent), total }
}

export function acknowledgeSecurityEvent(
  database: SqlDatabase,
  id: number,
  adminId: number,
): boolean {
  const row = queryOne(database, 'SELECT id, acknowledged FROM security_events WHERE id = ?', [id])
  if (!row) return false
  if (Number(row.acknowledged) === 1) return true
  execute(database, 'UPDATE security_events SET acknowledged = 1, acknowledged_by = ?, acknowledged_at = ? WHERE id = ?', [
    adminId,
    new Date().toISOString(),
    id,
  ])
  return true
}

export function securitySummary(database: SqlDatabase, activeSessions: number) {
  const dayAgo = new Date(Date.now() - 86_400_000).toISOString()
  const unacknowledgedCritical = queryScalar(
    database,
    "SELECT COUNT(*) AS total FROM security_events WHERE acknowledged = 0 AND severity = 'critical'",
  )
  const unacknowledgedWarning = queryScalar(
    database,
    "SELECT COUNT(*) AS total FROM security_events WHERE acknowledged = 0 AND severity = 'warning'",
  )
  const failedLogins = queryScalar(
    database,
    "SELECT COUNT(*) AS total FROM security_events WHERE kind = 'login_failure' AND created_at >= ?",
    [dayAgo],
  )
  const rateLimited = queryScalar(
    database,
    "SELECT COUNT(*) AS total FROM security_events WHERE kind = 'rate_limited' AND created_at >= ?",
    [dayAgo],
  )
  const lockedAccounts = queryScalar(
    database,
    'SELECT COUNT(*) AS total FROM admins WHERE locked_until IS NOT NULL AND locked_until > ?',
    [new Date().toISOString()],
  )
  const adminsWithoutMfa = queryScalar(
    database,
    'SELECT COUNT(*) AS total FROM admins WHERE mfa_enabled = 0 AND disabled = 0',
  )
  const recent = queryAll(
    database,
    "SELECT * FROM security_events WHERE severity IN ('critical','warning') ORDER BY id DESC LIMIT 8",
  ).map(toSecurityEvent)

  return {
    unacknowledged_critical: unacknowledgedCritical,
    unacknowledged_warning: unacknowledgedWarning,
    failed_logins_24h: failedLogins,
    rate_limited_24h: rateLimited,
    locked_accounts: lockedAccounts,
    active_sessions: activeSessions,
    admins_without_mfa: adminsWithoutMfa,
    recent,
  }
}

/* -------------------------------------------------------- rate limiting --- */

type Bucket = { count: number; resetAt: number }

/**
 * In-process fixed-window rate limiter.
 *
 * The server is a single local process, so keeping counters in memory is
 * accurate and avoids a write on every request. Account lockout is separately
 * persisted in the `admins` table, so it survives a restart.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>()
  private limit: number
  private windowMs: number

  constructor(limit: number, windowMs: number) {
    this.limit = limit
    this.windowMs = windowMs
  }

  /** Current allowance, updating the window if it has rolled over. */
  check(key: string): { allowed: boolean; remaining: number; retryAfterSeconds: number } {
    const now = Date.now()
    const existing = this.buckets.get(key)
    if (!existing || existing.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs })
      return { allowed: true, remaining: Math.max(0, this.limit - 1), retryAfterSeconds: 0 }
    }
    existing.count += 1
    const allowed = existing.count <= this.limit
    return {
      allowed,
      remaining: Math.max(0, this.limit - existing.count),
      retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
    }
  }

  /** Forget a key, used after a successful sign-in so limits do not accumulate. */
  reset(key: string): void {
    this.buckets.delete(key)
  }

  setLimit(limit: number, windowMs: number): void {
    this.buckets.clear()
    this.limit = limit
    this.windowMs = windowMs
  }

  /** Drop expired buckets so the map cannot grow without bound. */
  prune(): void {
    const now = Date.now()
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key)
    }
  }
}

/** Clamp a client-supplied address so it cannot be used to flood the map. */
export function normaliseClientKey(ip: string, supplied?: string | null): string {
  if (supplied && /^[A-Za-z0-9._:-]{1,64}$/.test(supplied)) return `u:${supplied.toLowerCase()}`
  return `ip:${ip || 'unknown'}`
}

export function pruneOldSecurityEvents(database: SqlDatabase, keepDays = 90): number {
  const cutoff = new Date(Date.now() - keepDays * 86_400_000).toISOString()
  const before = queryScalar(database, 'SELECT COUNT(*) AS total FROM security_events')
  execute(database, 'DELETE FROM security_events WHERE created_at < ? AND acknowledged = 1', [cutoff])
  const after = queryScalar(database, 'SELECT COUNT(*) AS total FROM security_events')
  return before - after
}

export { lastInsertId }
