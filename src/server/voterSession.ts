/**
 * Voter sessions.
 *
 * A voter session is the server's answer to "is this request an authenticated
 * voter for this election, right now". Three properties matter:
 *
 * - **The credential never touches client-readable storage.** The raw token
 *   lives only in an `HttpOnly` cookie, so script on the page cannot read it.
 *   The browser holds nothing at all — not even a reference — which is strictly
 *   better than holding a non-sensitive handle to a sensitive credential.
 * - **The database stores a hash of the token**, so a stolen database cannot be
 *   replayed as a set of live sessions.
 * - **The token is minted server side at verification and never accepted from
 *   the client**, which is what closes session fixation: whatever a caller
 *   arrives holding is discarded, not adopted.
 *
 * Sessions expire absolutely and also idle out, so an abandoned tab cannot keep
 * a verified identity alive indefinitely, and an old token is retained as a
 * revoked row rather than deleted so that replaying it is detectable.
 */

import { createHash, randomBytes } from 'node:crypto'
import { execute, queryAll, queryOne, queryScalar, text, type SqlDatabase } from './db'
import { recordSecurityEvent } from './security'

export const VOTER_COOKIE = 'election_voter'

/** Absolute lifetime, regardless of activity. */
export const VOTER_SESSION_MAX_AGE_MS = 2 * 60 * 60 * 1000
/** Inactivity window. Every accepted request slides this forward. */
export const VOTER_SESSION_IDLE_MS = 30 * 60 * 1000
/** How many revoked rows to keep per voter, to spot replay without growing forever. */
const REVOKED_HISTORY = 5

export type VoterSession = {
  id: number
  electionId: string
  voterRecordId: number
  createdAt: string
  lastSeenAt: string
  expiresAt: string
  ip: string | null
}

export type SessionState = 'ok' | 'unknown' | 'expired' | 'idle' | 'revoked'

export type ResolveResult =
  | { ok: true; session: VoterSession }
  | { ok: false; state: Exclude<SessionState, 'ok'> }

/** 256 bits of CSPRNG entropy, URL safe. */
function mintToken(): string {
  return randomBytes(32).toString('base64url')
}

/**
 * The database stores this, not the token.
 *
 * A plain SHA-256 is the right primitive here rather than a password hash: the
 * input is 256 bits of CSPRNG output, so there is no dictionary to attack, and
 * verification happens on every request, where a deliberately slow hash would be
 * a denial-of-service lever.
 */
function tokenDigest(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function toSession(row: Record<string, unknown>): VoterSession {
  return {
    id: Number(row.id),
    electionId: text(row.election_id),
    voterRecordId: Number(row.voter_record_id),
    createdAt: text(row.created_at),
    lastSeenAt: text(row.last_seen_at),
    expiresAt: text(row.expires_at),
    ip: typeof row.ip === 'string' && row.ip ? row.ip : null,
  }
}

/**
 * Create a session, superseding any the voter already had for this election.
 *
 * Superseding rather than allowing parallel sessions is both a usability
 * decision — one voter, one verified identity per poll — and a security one: it
 * means a session obtained earlier cannot still be used after a fresh
 * verification.
 */
export function createSession(
  database: SqlDatabase,
  input: { electionId: string; voterRecordId: number; now: number; ip: string | null; userAgent: string | null },
): { token: string; session: VoterSession } {
  revokeForVoter(database, input.electionId, input.voterRecordId, input.now, 'superseded by a new verification')
  pruneHistory(database, input.electionId, input.voterRecordId)

  const token = mintToken()
  const iso = new Date(input.now).toISOString()
  const expiresAt = new Date(input.now + VOTER_SESSION_MAX_AGE_MS).toISOString()
  execute(
    database,
    `INSERT INTO voter_sessions
       (token_hash, election_id, voter_record_id, created_at, last_seen_at, expires_at, ip, user_agent, revoked_at, revoked_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
    [tokenDigest(token), input.electionId, input.voterRecordId, iso, iso, expiresAt, input.ip, input.userAgent],
  )

  return {
    token,
    session: {
      id: Number(lastInsertId(database)),
      electionId: input.electionId,
      voterRecordId: input.voterRecordId,
      createdAt: iso,
      lastSeenAt: iso,
      expiresAt,
      ip: input.ip,
    },
  }
}

function lastInsertId(database: SqlDatabase): number {
  return queryScalar(database, 'SELECT last_insert_rowid() AS id')
}

/**
 * Resolve a presented token to a live session for one election.
 *
 * The token is scoped to an election on purpose: a session minted for one poll
 * cannot be presented against another, even though it is the same cookie.
 */
export function resolveSession(
  database: SqlDatabase,
  input: { token: string | null; electionId: string; now: number },
): ResolveResult {
  if (!input.token) return { ok: false, state: 'unknown' }
  const digest = tokenDigest(input.token)
  const row = queryOne(
    database,
    'SELECT * FROM voter_sessions WHERE token_hash = ? AND election_id = ?',
    [digest, input.electionId],
  )
  if (!row) return { ok: false, state: 'unknown' }

  if (text(row.revoked_at)) return { ok: false, state: 'revoked' }
  if (Date.parse(text(row.expires_at)) <= input.now) {
    revokeByDigest(database, digest, input.now, 'expired')
    return { ok: false, state: 'expired' }
  }
  if (input.now - Date.parse(text(row.last_seen_at)) > VOTER_SESSION_IDLE_MS) {
    revokeByDigest(database, digest, input.now, 'idle timeout')
    return { ok: false, state: 'idle' }
  }

  // Slide the idle window forward only for a session that is genuinely in use.
  execute(database, 'UPDATE voter_sessions SET last_seen_at = ? WHERE token_hash = ?', [
    new Date(input.now).toISOString(),
    digest,
  ])

  return { ok: true, session: toSession(row) }
}

function revokeByDigest(database: SqlDatabase, digest: string, now: number, reason: string): void {
  execute(database, 'UPDATE voter_sessions SET revoked_at = ?, revoked_reason = ? WHERE token_hash = ? AND revoked_at IS NULL', [
    new Date(now).toISOString(),
    reason,
    digest,
  ])
}

export function revokeForVoter(
  database: SqlDatabase,
  electionId: string,
  voterRecordId: number,
  now: number,
  reason: string,
): number {
  const before = queryScalar(
    database,
    'SELECT COUNT(*) AS total FROM voter_sessions WHERE election_id = ? AND voter_record_id = ? AND revoked_at IS NULL',
    [electionId, voterRecordId],
  )
  execute(
    database,
    'UPDATE voter_sessions SET revoked_at = ?, revoked_reason = ? WHERE election_id = ? AND voter_record_id = ? AND revoked_at IS NULL',
    [new Date(now).toISOString(), reason, electionId, voterRecordId],
  )
  return before
}

export function revokeToken(
  database: SqlDatabase,
  token: string,
  now: number,
  reason: string,
): boolean {
  const digest = tokenDigest(token)
  const row = queryOne(database, 'SELECT id FROM voter_sessions WHERE token_hash = ?', [digest])
  if (!row) return false
  revokeByDigest(database, digest, now, reason)
  return true
}

/** Keep a handful of revoked rows so replay is visible, and drop the rest. */
function pruneHistory(database: SqlDatabase, electionId: string, voterRecordId: number): void {
  execute(
    database,
    `DELETE FROM voter_sessions
      WHERE election_id = ? AND voter_record_id = ? AND revoked_at IS NOT NULL
        AND id NOT IN (
          SELECT id FROM voter_sessions
           WHERE election_id = ? AND voter_record_id = ? AND revoked_at IS NOT NULL
           ORDER BY revoked_at DESC LIMIT ?
        )`,
    [electionId, voterRecordId, electionId, voterRecordId, REVOKED_HISTORY],
  )
}

/** Drop sessions that are spent, expired, or long idle. */
export function pruneSessions(database: SqlDatabase, now: number): number {
  const before = queryScalar(database, 'SELECT COUNT(*) AS total FROM voter_sessions')
  execute(database, 'DELETE FROM voter_sessions WHERE expires_at < ?', [new Date(now - 86_400_000).toISOString()])
  return before - queryScalar(database, 'SELECT COUNT(*) AS total FROM voter_sessions')
}

export function countActiveSessions(database: SqlDatabase, now: number): number {
  return queryScalar(
    database,
    'SELECT COUNT(*) AS total FROM voter_sessions WHERE revoked_at IS NULL AND expires_at > ?',
    [new Date(now).toISOString()],
  )
}

/**
 * Flag a verification that arrives from an address the voter has not used before.
 *
 * This is a signal, not a control: the platform is loopback-only, so the useful
 * cases are a shared machine, a replayed cookie, or a copied session. It is
 * recorded so an auditor can see it rather than discovered after the fact.
 */
export function noteSuspiciousVerification(
  database: SqlDatabase,
  input: {
    electionId: string
    voterRecordId: number
    voterLabel: string
    ip: string | null
    now: number
  },
): boolean {
  if (!input.ip) return false
  const seenFrom = queryAll(
    database,
    'SELECT DISTINCT ip FROM voter_sessions WHERE election_id = ? AND voter_record_id = ? AND ip IS NOT NULL AND ip != ?',
    [input.electionId, input.voterRecordId, input.ip],
  )
  if (seenFrom.length === 0) return false
  recordSecurityEvent(database, {
    kind: 'voter_verification_new_address',
    severity: 'notice',
    summary: `${input.voterLabel} completed verification from an address they have not used before.`,
    adminId: null,
    adminLabel: input.voterLabel,
    ip: input.ip,
    detail: { election_id: input.electionId, known_addresses: seenFrom.length },
  })
  return true
}

/* --------------------------------------------------------------- cookies --- */

export function serializeSessionCookie(token: string, maxAgeSeconds: number, secure: boolean): string {
  const parts = [
    `${VOTER_COOKIE}=${encodeURIComponent(token)}`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/__api',
    `Max-Age=${Math.max(0, Math.trunc(maxAgeSeconds))}`,
  ]
  // `Secure` is conditional because the development and preview servers are
  // plain HTTP on loopback; a browser drops a `Secure` cookie sent over HTTP, so
  // setting it unconditionally would silently break local voting.
  if (secure) parts.push('Secure')
  return parts.join('; ')
}

export function clearSessionCookie(secure: boolean): string {
  return serializeSessionCookie('', 0, secure)
}
