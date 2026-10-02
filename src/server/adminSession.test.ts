/**
 * Administrator sessions.
 *
 * The concern is narrow and specific: a copy of the database must not be a set of
 * working console credentials. These tests pin that property, along with the
 * revocation behaviour that a hashed token could plausibly have broken.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import initSqlJs from 'sql.js'
import {
  countActiveSessions,
  listSessions,
  logout,
  markMfaVerified,
  markReauthenticated,
  resolveSession,
  revokeAllSessions,
  revokeSession,
} from './auth'
import type { AdminAccount, AdminSession } from '../lib/adminTypes'
import { execute, queryAll, queryOne, text, type SqlDatabase } from './db'

/*
 * Sessions are stamped relative to the real clock, because `resolveSession`
 * compares against `Date.now()`. A fixture pinned to a fixed date would read as
 * expired and the tests would pass for the wrong reason.
 */
const NOW = Date.now()
const NOW_ISO = new Date(NOW).toISOString()
const FUTURE_ISO = new Date(NOW + 12 * 60 * 60 * 1000).toISOString()
const PAST_ISO = new Date(NOW - 60 * 60 * 1000).toISOString()

let database: SqlDatabase

/*
 * Only the two tables these functions touch. Declared here rather than reusing the
 * production schema so a change to the real schema cannot make these tests pass or
 * fail for the wrong reason.
 */
const SCHEMA = `
CREATE TABLE admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  mfa_enabled INTEGER NOT NULL DEFAULT 0,
  disabled INTEGER NOT NULL DEFAULT 0,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  last_login_at TEXT,
  last_login_ip TEXT
);
CREATE TABLE admin_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT UNIQUE,
  token TEXT,
  admin_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  mfa_verified_at TEXT,
  reauth_verified_at TEXT,
  last_seen_at TEXT,
  ip TEXT,
  user_agent TEXT,
  revoked_at TEXT,
  revoked_reason TEXT
);
`

const ACCOUNT: AdminAccount = {
  id: 1,
  username: 'cro',
  display_name: 'Administrator',
  role: 'super_admin',
  mfa_enabled: false,
  disabled: false,
  failed_attempts: 0,
  locked_until: null,
  last_login_at: null,
  created_at: NOW_ISO,
  must_change_password: false,
}

beforeEach(async () => {
  const SQL = await initSqlJs()
  database = new SQL.Database() as unknown as SqlDatabase
  database.run(SCHEMA)
  execute(
    database,
    'INSERT INTO admins (id, username, display_name, role, password_hash) VALUES (?, ?, ?, ?, ?)',
    [ACCOUNT.id, ACCOUNT.username, ACCOUNT.display_name, ACCOUNT.role, 'scrypt$16384$8$1$c2FsdA==$ZGVyaXZlZA=='],
  )
})

afterEach(() => {
  database.close()
})

/** Insert a session the way `openSession` does, and return the raw token. */
function open(
  adminId = ACCOUNT.id,
  token = `token-${Math.random().toString(36).slice(2)}`,
  expiresAt = FUTURE_ISO,
): string {
  execute(
    database,
    `INSERT INTO admin_sessions (token_hash, admin_id, created_at, expires_at, reauth_verified_at, last_seen_at, ip)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      createHash('sha256').update(token).digest('hex'),
      adminId,
      NOW_ISO,
      expiresAt,
      NOW_ISO,
      NOW_ISO,
      '127.0.0.1',
    ],
  )
  return token
}

/* ---------------------------------------------------------------- at rest --- */

describe('storage of a session token', () => {
  it('stores a hash, never the token', () => {
    const token = open()
    const row = queryOne(database, 'SELECT token_hash, token FROM admin_sessions LIMIT 1')
    expect(text(row?.token_hash)).toBe(createHash('sha256').update(token).digest('hex'))
    expect(text(row?.token_hash)).not.toBe(token)
    // The legacy column exists for upgrades only, and is left empty.
    expect(row?.token === null || row?.token === undefined).toBe(true)
  })

  it('leaves the raw token nowhere in the table', () => {
    const token = open()
    const serialised = JSON.stringify(queryAll(database, 'SELECT * FROM admin_sessions'))
    expect(serialised).not.toContain(token)
  })

  it('resolves the token that was hashed', () => {
    const token = open()
    expect(resolveSession(database, token)?.admin.username).toBe('cro')
  })

  it('refuses a token that was never issued', () => {
    expect(resolveSession(database, 'not-a-real-token')).toBeNull()
  })

  it('refuses a forged token, even one of the right shape', () => {
    open()
    for (const candidate of ['x', 'A'.repeat(43), 'a'.repeat(43) + '=', '0'.repeat(43)]) {
      expect(resolveSession(database, candidate)).toBeNull()
    }
  })

  it('refuses the hash itself as if it were the token', () => {
    // Guards against a future change that starts comparing the digest to itself.
    const token = open()
    const digest = createHash('sha256').update(token).digest('hex')
    expect(resolveSession(database, digest)).toBeNull()
  })
})

/* ------------------------------------------------------------- lifecycle --- */

describe('expiry and revocation', () => {
  it('refuses an expired session and removes the row', () => {
    const token = open(ACCOUNT.id, undefined, PAST_ISO)
    expect(resolveSession(database, token)).toBeNull()
    // Refused and cleaned up, so an expired row cannot accumulate.
    expect(queryAll(database, 'SELECT id FROM admin_sessions')).toHaveLength(0)
  })

  it('refuses a revoked session and removes the row', () => {
    const token = open()
    expect(revokeSession(database, token, 'test')).toBe(true)
    expect(resolveSession(database, token)).toBeNull()
  })

  it('reports a revocation for a token that does not exist', () => {
    expect(revokeSession(database, 'not-a-real-token', 'test')).toBe(false)
  })

  it('signs out by deleting the row', () => {
    const token = open()
    logout(database, token)
    expect(resolveSession(database, token)).toBeNull()
    // Signing out again is a no-op rather than an error.
    expect(() => logout(database, token)).not.toThrow()
    expect(() => logout(database, null)).not.toThrow()
  })

  it('revokes every session for an account, sparing the current one', () => {
    const current = open()
    const other = open()
    const third = open()
    expect(revokeAllSessions(database, ACCOUNT.id, 'Revoked by administrator', current)).toBe(2)
    expect(resolveSession(database, current)).not.toBeNull()
    expect(resolveSession(database, other)).toBeNull()
    expect(resolveSession(database, third)).toBeNull()
  })

  it('revokes every session when no exception is given', () => {
    open()
    open()
    expect(revokeAllSessions(database, ACCOUNT.id, 'Account updated')).toBe(2)
    expect(countActiveSessions(database)).toBe(0)
  })

  it('does not revoke another account’s sessions', () => {
    execute(
      database,
      'INSERT INTO admins (id, username, display_name, role, password_hash) VALUES (?, ?, ?, ?, ?)',
      [2, 'officer', 'Election Officer', 'election_officer', 'scrypt$16384$8$1$c2FsdA==$ZGVyaXZlZA=='],
    )
    const mine = open(1)
    const theirs = open(2)
    revokeAllSessions(database, 1, 'Account updated')
    expect(resolveSession(database, mine)).toBeNull()
    expect(resolveSession(database, theirs)).not.toBeNull()
  })

  it('does not count revoked sessions as active', () => {
    const a = open()
    open()
    expect(countActiveSessions(database)).toBe(2)
    revokeSession(database, a, 'test')
    expect(countActiveSessions(database)).toBe(1)
  })
})

/* ------------------------------------------------------- elevation markers --- */

describe('elevation timestamps', () => {
  it('records that the password was re-entered', () => {
    const token = open()
    const session = resolveSession(database, token) as AdminSession
    expect(session.reauth_verified_at).toBe(NOW_ISO)
    markReauthenticated(database, token)
    expect((resolveSession(database, token) as AdminSession).reauth_verified_at).not.toBe(NOW_ISO)
  })

  it('records that a second factor was satisfied', () => {
    const token = open()
    markMfaVerified(database, token)
    const session = resolveSession(database, token) as AdminSession
    expect(session.mfa_verified_at).not.toBeNull()
    // Satisfying a second factor also counts as proof of the password.
    expect(session.reauth_verified_at).not.toBeNull()
  })

  it('ignores an elevation marker for an unknown token', () => {
    const token = open()
    markMfaVerified(database, 'not-a-real-token')
    expect((resolveSession(database, token) as AdminSession).mfa_verified_at).toBeNull()
  })
})

/* ---------------------------------------------------------------- listing --- */

describe('listing sessions', () => {
  it('identifies the current session without exposing any token', () => {
    const current = open()
    const other = open()
    const rows = listSessions(database, current)
    expect(rows).toHaveLength(2)
    expect(rows.filter((row) => row.current)).toHaveLength(1)
    expect(rows.find((row) => row.current)?.created_at).toBeTruthy()
    for (const row of rows) {
      expect(Object.keys(row)).not.toContain('token')
      expect(Object.keys(row)).not.toContain('token_hash')
    }
    expect(other).toBeTruthy()
  })

  it('marks nothing current when there is no session', () => {
    open()
    expect(listSessions(database, null).every((row) => !row.current)).toBe(true)
  })
})
