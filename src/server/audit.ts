/**
 * Audit trail.
 *
 * Every administrative action is recorded whether it succeeded, was denied, or
 * failed, together with the administrator, their role, the resource touched, the
 * request identifier that correlates it with server logs, and the outcome.
 * Denials are recorded too: a repeated `permission_denied` is how an
 * unauthorised attempt becomes visible.
 *
 * Only safe metadata belongs in `detail`. Passwords, session tokens, and voter
 * passcodes must never reach this table.
 */

import { execute, queryAll, queryScalar, text, type SqlDatabase } from './db'
import type { AdminRole } from '../lib/rbac'
import type { AuditEvent, AuditQuery, AuditResult, PagedResult } from '../lib/adminTypes'

/** Keys that must never be written to the audit detail payload. */
const REDACTED_KEYS = new Set([
  'password',
  'newpassword',
  'currentpassword',
  'password_hash',
  'token',
  'sessiontoken',
  'secret',
  'mfa_secret',
  'phone_otp',
  'email_otp',
  'phoneotp',
  'emailotp',
  'otp',
  'code',
  'recovery_codes',
  'authorization',
  'cookie',
])

const MAX_DETAIL_BYTES = 8_000

/**
 * Strip anything sensitive and bound the size, so an audit row can never become
 * a place where a credential is accidentally retained.
 */
export function sanitiseDetail(value: unknown): string {
  const walk = (input: unknown, depth: number): unknown => {
    if (depth > 4) return '[truncated]'
    if (Array.isArray(input)) return input.slice(0, 50).map((item) => walk(item, depth + 1))
    if (input && typeof input === 'object') {
      const out: Record<string, unknown> = {}
      for (const [key, item] of Object.entries(input as Record<string, unknown>)) {
        if (REDACTED_KEYS.has(key.toLowerCase())) {
          out[key] = '[redacted]'
          continue
        }
        out[key] = walk(item, depth + 1)
      }
      return out
    }
    if (typeof input === 'string' && input.length > 500) return `${input.slice(0, 500)}…`
    return input
  }

  let serialised: string
  try {
    serialised = JSON.stringify(walk(value, 0) ?? {})
  } catch {
    return '{}'
  }
  return serialised.length > MAX_DETAIL_BYTES ? `${serialised.slice(0, MAX_DETAIL_BYTES)}…"}` : serialised
}

export type AuditInput = {
  requestId?: string
  electionId?: string | null
  actorType: 'admin' | 'system' | 'voter'
  actorId?: string | number | null
  actorLabel: string
  actorRole?: AdminRole | null
  action: string
  resource?: string
  result?: AuditResult
  fromStatus?: string | null
  toStatus?: string | null
  summary: string
  detail?: unknown
  ip?: string | null
  createdAt?: string
}

export function recordAudit(database: SqlDatabase, input: AuditInput): void {
  execute(
    database,
    `INSERT INTO audit_events (request_id, election_id, actor_type, actor_id, actor_label, actor_role,
      action, resource, result, from_status, to_status, summary, detail, ip, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.requestId ?? '',
      input.electionId ?? null,
      input.actorType,
      input.actorId === null || input.actorId === undefined ? null : String(input.actorId),
      input.actorLabel,
      input.actorRole ?? null,
      input.action,
      input.resource ?? '',
      input.result ?? 'success',
      input.fromStatus ?? null,
      input.toStatus ?? null,
      input.summary,
      sanitiseDetail(input.detail),
      input.ip ?? null,
      input.createdAt ?? new Date().toISOString(),
    ],
  )
}

function toAuditEvent(row: Record<string, unknown>): AuditEvent {
  return {
    id: Number(row.id ?? 0),
    request_id: text(row.request_id),
    election_id: typeof row.election_id === 'string' && row.election_id ? row.election_id : null,
    actor_type: (text(row.actor_type) || 'system') as AuditEvent['actor_type'],
    actor_id: typeof row.actor_id === 'string' && row.actor_id ? row.actor_id : null,
    actor_label: text(row.actor_label),
    actor_role: (typeof row.actor_role === 'string' && row.actor_role ? row.actor_role : null) as AdminRole | null,
    action: text(row.action),
    resource: text(row.resource),
    result: (text(row.result) || 'success') as AuditResult,
    from_status: typeof row.from_status === 'string' && row.from_status ? row.from_status : null,
    to_status: typeof row.to_status === 'string' && row.to_status ? row.to_status : null,
    summary: text(row.summary),
    detail: text(row.detail) || '{}',
    ip: typeof row.ip === 'string' && row.ip ? row.ip : null,
    created_at: text(row.created_at),
  }
}

export function queryAudit(
  database: SqlDatabase,
  filter: AuditQuery,
): PagedResult<AuditEvent> {
  const where: string[] = []
  const params: unknown[] = []

  if (filter.electionId) {
    where.push('election_id = ?')
    params.push(filter.electionId)
  }
  if (filter.actor) {
    where.push('(actor_id = ? OR actor_label LIKE ?)')
    params.push(filter.actor, `%${filter.actor}%`)
  }
  if (filter.action) {
    where.push('action LIKE ?')
    params.push(`${filter.action}%`)
  }
  if (filter.result) {
    where.push('result = ?')
    params.push(filter.result)
  }
  if (filter.since) {
    where.push('created_at >= ?')
    params.push(filter.since)
  }
  if (filter.until) {
    where.push('created_at <= ?')
    params.push(filter.until)
  }
  if (filter.search) {
    where.push('(summary LIKE ? OR detail LIKE ? OR action LIKE ? OR request_id LIKE ? OR resource LIKE ?)')
    const needle = `%${filter.search}%`
    params.push(needle, needle, needle, needle, needle)
  }

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const total = queryScalar(database, `SELECT COUNT(*) AS total FROM audit_events ${clause}`, params)
  const limit = Math.min(1000, Math.max(1, filter.limit ?? 50))
  const offset = Math.max(0, filter.offset ?? 0)
  const rows = queryAll(
    database,
    `SELECT * FROM audit_events ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  )
  return { rows: rows.map(toAuditEvent), total, limit, offset }
}

/** Distinct actions present in the log, for populating a filter dropdown. */
export function auditActions(database: SqlDatabase): string[] {
  return queryAll(database, 'SELECT DISTINCT action FROM audit_events ORDER BY action')
    .map((row) => text(row.action))
    .filter(Boolean)
}

export function listAuditEvents(database: SqlDatabase, electionId: string | null, limit: number): AuditEvent[] {
  return queryAudit(database, { electionId: electionId ?? undefined, limit }).rows
}

export function countAuditEvents(database: SqlDatabase): number {
  return queryScalar(database, 'SELECT COUNT(*) AS total FROM audit_events')
}
