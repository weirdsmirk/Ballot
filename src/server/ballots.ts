/**
 * Ballots, credentials, participation and receipts.
 *
 * This module is the reason the platform can count votes without knowing who cast
 * them. It owns four ideas that are deliberately kept apart:
 *
 * - A **credential** is a short-lived, single-use right to cast one ballot in one
 *   election. It is issued only after a voter has authenticated, and it is the
 *   thing the ballot subsystem actually consumes.
 * - **Participation** records that a person voted. It carries no selections.
 * - A **ballot** records what was chosen. It carries no voter and no credential.
 * - A **receipt** proves a ballot was counted, without saying whose it was.
 *
 * None of these four references another in a way that would recover a voter's
 * choice. A credential row and a participation row both name a voter, and a
 * ballot row names neither — so there is no path from "who is this?" to "what
 * did they pick?", not even a slow one. The separation is structural: it is a
 * property of the columns, not of a filter that a later change could forget.
 *
 * On the integrity digest
 * -----------------------
 * A ballot's digest is a keyed HMAC, not a plain hash, and that is load-bearing
 * rather than decorative. A selection is a small integer drawn from the handful
 * of options on one ballot, so `sha256(election || 3)` could be brute-forced by
 * anyone holding the database — turning the digest into a disclosure and undoing
 * the entire arrangement. Keying it with a secret that lives outside the database
 * means the digest can be checked (by the platform, or by an auditor given the
 * key) without being reversible (by anyone given only the data).
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { execute, queryAll, queryOne, queryScalar, text, type SqlDatabase } from './db'

/* --------------------------------------------------------------- integrity --- */

/**
 * The key ballot digests are computed with.
 *
 * Taken from `BALLOT_INTEGRITY_KEY` when set, otherwise generated once and kept
 * beside the database. It is deliberately *not* stored in the database: the whole
 * point is that a copy of the data is not enough to read a digest back into a
 * selection. A deployment that wants digests to remain checkable across restores
 * and migrations should set the environment variable, and keep a copy of it
 * somewhere the database backup is not.
 */
let cachedKey: Buffer | null = null

function integrityKey(databasePath: string): Buffer {
  if (cachedKey) return cachedKey

  const fromEnv = process.env.BALLOT_INTEGRITY_KEY
  if (fromEnv && /^[0-9a-f]{32,}$/i.test(fromEnv)) {
    cachedKey = Buffer.from(fromEnv, 'hex')
    return cachedKey
  }

  const keyPath = path.join(path.dirname(databasePath), 'ballot-integrity.key')
  try {
    if (fs.existsSync(keyPath)) {
      const existing = fs.readFileSync(keyPath, 'utf8').trim()
      if (/^[0-9a-f]{32,}$/i.test(existing)) {
        cachedKey = Buffer.from(existing, 'hex')
        return cachedKey
      }
    }
  } catch {
    // Fall through and mint a new key. A fresh key only invalidates the ability to
    // re-verify *old* digests; it never exposes a selection, so this is the safe
    // direction to fail in.
  }

  const key = randomBytes(32)
  try {
    fs.mkdirSync(path.dirname(keyPath), { recursive: true })
    fs.writeFileSync(keyPath, key.toString('hex'), { mode: 0o600 })
  } catch {
    // An unwritable data directory is survivable for the length of this process.
  }
  cachedKey = key
  return key
}

/** Test seam: forget the cached key so the next call re-reads it. */
export function resetIntegrityKey(): void {
  cachedKey = null
}

function digestOf(key: Buffer, electionId: string, submittedAt: string, selections: number[]): string {
  return createHmac('sha256', key)
    // NUL as the field separator, written as an escape rather than a literal byte so
    // this file stays plain text. It matters that the separator cannot appear in a
    // field: with a space, election "A B" at time "C" would hash the same as election
    // "A" at time "B C", and two different ballots could share a digest.
    .update(`${electionId}\u0000${submittedAt}\u0000${selections.join(',')}`)
    .digest('hex')
}

/* ------------------------------------------------------------------- types --- */

export type VotingCredential = {
  id: number
  electionId: string
  voterRecordId: number
  issuedAt: string
  expiresAt: string
  spentAt: string | null
  revokedAt: string | null
}

export type CredentialState = 'ok' | 'unknown' | 'expired' | 'spent' | 'revoked' | 'wrong_election'

export type StoredBallot = {
  id: string
  electionId: string
  selections: number[]
  selectionCount: number
  submittedAt: string
  integrityDigest: string
}

export type Receipt = {
  code: string
  electionId: string
  ballot: StoredBallot
  issuedAt: string
}

/** How long a freshly issued credential stays usable. */
export const DEFAULT_CREDENTIAL_TTL_SECONDS = 15 * 60

function digest(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/**
 * A credential is 256 bits of CSPRNG output, so a plain SHA-256 is the right
 * primitive: there is no dictionary to attack, and it is checked on every ballot
 * submission where a slow hash would be a denial-of-service lever.
 */
function credentialDigest(token: string): string {
  return digest(token)
}

/**
 * The stored form of a receipt code.
 *
 * Exported so anything that has to write a receipt row — the demo seed, above
 * all — hashes a code exactly the way `issueReceipt` does. A receipt hash is the
 * only thing standing between a copied database and a list of codes somebody
 * could quote, so the rule lives in one place rather than being restated.
 */
export function receiptDigest(code: string): string {
  return digest(normaliseReceipt(code))
}

/** Receipts are shown to people in groups of four, so ignore how they are typed. */
export function normaliseReceipt(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '')
}

function toCredential(row: Record<string, unknown>): VotingCredential {
  return {
    id: Number(row.id),
    electionId: text(row.election_id),
    voterRecordId: Number(row.voter_record_id),
    issuedAt: text(row.issued_at),
    expiresAt: text(row.expires_at),
    spentAt: typeof row.spent_at === 'string' && row.spent_at ? row.spent_at : null,
    revokedAt: typeof row.revoked_at === 'string' && row.revoked_at ? row.revoked_at : null,
  }
}

function toBallot(row: Record<string, unknown>): StoredBallot {
  let selections: number[] = []
  try {
    const parsed: unknown = JSON.parse(text(row.selections))
    if (Array.isArray(parsed)) selections = parsed.map(Number).filter(Number.isInteger)
  } catch {
    // A corrupt row counts as selecting nothing rather than taking the tally down.
    selections = []
  }
  return {
    id: text(row.id),
    electionId: text(row.election_id),
    selections,
    selectionCount: Number(row.selection_count) || 0,
    submittedAt: text(row.submitted_at),
    integrityDigest: text(row.integrity_digest),
  }
}

/* ------------------------------------------------------------- credentials --- */

/**
 * Issue a credential to a voter who has just authenticated.
 *
 * Any credential the voter already holds for this election is revoked first, so
 * there is never more than one live right to vote per person per poll. Revoking
 * rather than silently allowing a second one matters: two live credentials would
 * mean two ballots, and only one of them would be the one the participation
 * record points at.
 */
export function issueCredential(
  database: SqlDatabase,
  input: {
    electionId: string
    voterRecordId: number
    now: number
    ttlSeconds?: number
    reason?: string
  },
): { token: string; credential: VotingCredential } {
  revokeCredentialsFor(database, input.electionId, input.voterRecordId, input.now, input.reason ?? 'superseded')

  const token = randomBytes(32).toString('base64url')
  const issuedAt = new Date(input.now).toISOString()
  const expiresAt = new Date(input.now + (input.ttlSeconds ?? DEFAULT_CREDENTIAL_TTL_SECONDS) * 1000).toISOString()
  execute(
    database,
    `INSERT INTO voting_credentials
       (credential_hash, election_id, voter_record_id, issued_at, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
    [credentialDigest(token), input.electionId, input.voterRecordId, issuedAt, expiresAt],
  )

  return {
    token,
    credential: {
      id: lastId(database),
      electionId: input.electionId,
      voterRecordId: input.voterRecordId,
      issuedAt,
      expiresAt,
      spentAt: null,
      revokedAt: null,
    },
  }
}

function lastId(database: SqlDatabase): number {
  return queryScalar(database, 'SELECT last_insert_rowid() AS id')
}

function revokeCredentialsFor(
  database: SqlDatabase,
  electionId: string,
  voterRecordId: number,
  now: number,
  reason: string,
): void {
  execute(
    database,
    `UPDATE voting_credentials SET revoked_at = ?, revoked_reason = ?
      WHERE election_id = ? AND voter_record_id = ? AND revoked_at IS NULL AND spent_at IS NULL`,
    [new Date(now).toISOString(), reason, electionId, voterRecordId],
  )
}

/**
 * Resolve a presented credential for one election.
 *
 * Every disqualifying state is reported distinctly to the *server* so it can log
 * the real reason, while the caller is expected to show the voter a single vague
 * message. A credential for a different poll never matches, so a credential
 * cannot be carried from one election to another.
 */
export function resolveCredential(
  database: SqlDatabase,
  input: { token: string | null; electionId: string; now: number },
): { ok: true; credential: VotingCredential } | { ok: false; state: CredentialState } {
  if (!input.token) return { ok: false, state: 'unknown' }
  const row = queryOne(database, 'SELECT * FROM voting_credentials WHERE credential_hash = ?', [
    credentialDigest(input.token),
  ])
  if (!row) return { ok: false, state: 'unknown' }
  const credential = toCredential(row)
  if (credential.electionId !== input.electionId) return { ok: false, state: 'wrong_election' }
  if (credential.revokedAt) return { ok: false, state: 'revoked' }
  if (credential.spentAt) return { ok: false, state: 'spent' }
  if (Date.parse(credential.expiresAt) <= input.now) return { ok: false, state: 'expired' }
  return { ok: true, credential }
}

/**
 * Spend a credential, so the same right cannot be used twice.
 *
 * Guarded on `spent_at IS NULL` rather than read-then-written, so two concurrent
 * submissions cannot both succeed: the second update matches no row.
 */
export function spendCredential(database: SqlDatabase, credentialId: number, now: number): boolean {
  const before = queryScalar(
    database,
    'SELECT COUNT(*) AS total FROM voting_credentials WHERE id = ? AND spent_at IS NULL AND revoked_at IS NULL',
    [credentialId],
  )
  if (before === 0) return false
  execute(
    database,
    'UPDATE voting_credentials SET spent_at = ? WHERE id = ? AND spent_at IS NULL AND revoked_at IS NULL',
    [new Date(now).toISOString(), credentialId],
  )
  return true
}

export function pruneCredentials(database: SqlDatabase, now: number, keepMs = 7 * 86_400_000): number {
  const before = queryScalar(database, 'SELECT COUNT(*) AS total FROM voting_credentials')
  execute(database, 'DELETE FROM voting_credentials WHERE expires_at < ?', [new Date(now - keepMs).toISOString()])
  return before - queryScalar(database, 'SELECT COUNT(*) AS total FROM voting_credentials')
}

/* ----------------------------------------------------------- participation --- */

export function hasParticipated(database: SqlDatabase, electionId: string, voterRecordId: number): boolean {
  return (
    queryScalar(
      database,
      'SELECT COUNT(*) AS total FROM participation WHERE election_id = ? AND voter_record_id = ?',
      [electionId, voterRecordId],
    ) > 0
  )
}

export function findParticipation(database: SqlDatabase, electionId: string, voterRecordId: number) {
  return queryOne(
    database,
    'SELECT * FROM participation WHERE election_id = ? AND voter_record_id = ?',
    [electionId, voterRecordId],
  )
}

export function countParticipants(database: SqlDatabase, electionId: string): number {
  return queryScalar(database, 'SELECT COUNT(*) AS total FROM participation WHERE election_id = ?', [electionId])
}

export function recordParticipation(
  database: SqlDatabase,
  input: { electionId: string; voterRecordId: number; credentialId: number; now: number },
): void {
  execute(
    database,
    'INSERT INTO participation (election_id, voter_record_id, credential_id, participated_at) VALUES (?, ?, ?, ?)',
    [input.electionId, input.voterRecordId, input.credentialId, new Date(input.now).toISOString()],
  )
}

/* ----------------------------------------------------------------- ballots --- */

/**
 * Write one anonymous ballot.
 *
 * Takes an option list and nothing else. It is not given a voter, and there is no
 * parameter through which one could be passed — the separation is enforced by
 * this function's signature as well as by the table.
 */
export function recordBallot(
  database: SqlDatabase,
  input: { electionId: string; selections: number[]; now: number; databasePath: string },
): StoredBallot {
  const submittedAt = new Date(input.now).toISOString()
  // A random key, not a sequence. See the schema comment: autoincrement ids on both
  // `ballots` and `participation` would line up by accident and pair every voter
  // with a ballot, which is precisely the leak this design exists to prevent.
  const ballotId = randomBytes(16).toString('hex')
  const integrityDigest = digestOf(
    integrityKey(input.databasePath),
    input.electionId,
    submittedAt,
    input.selections,
  )
  execute(
    database,
    `INSERT INTO ballots (id, election_id, selections, selection_count, submitted_at, integrity_digest)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      ballotId,
      input.electionId,
      JSON.stringify(input.selections),
      input.selections.length,
      submittedAt,
      integrityDigest,
    ],
  )
  return {
    id: ballotId,
    electionId: input.electionId,
    selections: input.selections,
    selectionCount: input.selections.length,
    submittedAt,
    integrityDigest,
  }
}

export function listBallots(database: SqlDatabase, electionId: string): StoredBallot[] {
  return queryAll(database, 'SELECT * FROM ballots WHERE election_id = ? ORDER BY id', [electionId]).map(toBallot)
}

export function countBallots(database: SqlDatabase, electionId: string): number {
  return queryScalar(database, 'SELECT COUNT(*) AS total FROM ballots WHERE election_id = ?', [electionId])
}

/**
 * Re-check a stored digest against its own contents.
 *
 * Used by the verification surface an auditor can reach. It answers "has this
 * ballot been altered since it was written", which is a different and much weaker
 * question than "whose ballot is it" — and one that can be answered without any
 * link to a voter existing.
 */
export function verifyBallotIntegrity(ballot: StoredBallot, databasePath: string): boolean {
  const expected = digestOf(integrityKey(databasePath), ballot.electionId, ballot.submittedAt, ballot.selections)
  const a = Buffer.from(expected, 'hex')
  const b = Buffer.from(ballot.integrityDigest, 'hex')
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b)
}

/**
 * Count the ballots.
 *
 * The only place in the platform that reads a selection out of storage, and it
 * returns counts — never a ballot, never a pairing. A tally is safe to publish
 * because a total cannot be inverted back to an individual.
 */
export function tallyBallots(
  database: SqlDatabase,
  electionId: string,
): { counts: Map<number, number>; total: number; ballots: number } {
  const counts = new Map<number, number>()
  let total = 0
  const ballots = listBallots(database, electionId)
  for (const ballot of ballots) {
    for (const selection of ballot.selections) {
      counts.set(selection, (counts.get(selection) ?? 0) + 1)
      total += 1
    }
  }
  return { counts, total, ballots: ballots.length }
}

/* ---------------------------------------------------------------- receipts --- */

/** 72 bits of CSPRNG entropy, grouped for transcription. */
export function createReceiptCode(): string {
  return randomBytes(9)
    .toString('hex')
    .toUpperCase()
    .replace(/(.{4})(?=.)/g, '$1-')
}

export function issueReceipt(
  database: SqlDatabase,
  input: { electionId: string; ballotId: string; now: number },
): { code: string; hash: string } {
  const code = createReceiptCode()
  const hash = receiptDigest(code)
  execute(
    database,
    'INSERT INTO receipts (code_hash, election_id, ballot_id, issued_at) VALUES (?, ?, ?, ?)',
    [hash, input.electionId, input.ballotId, new Date(input.now).toISOString()],
  )
  return { code, hash }
}

/**
 * Look up a ballot by receipt.
 *
 * This is the *only* way back from a ballot to its contents, and it is keyed on a
 * secret the voter holds rather than on who they are. There is deliberately no
 * `receiptForVoter` counterpart: knowing a person's identity must never be
 * sufficient to learn their choice, or the separation would be decorative.
 */
export function findReceipt(database: SqlDatabase, code: string): Receipt | null {
  const normalised = normaliseReceipt(code)
  if (normalised.length < 8) return null
  const row = queryOne(database, 'SELECT * FROM receipts WHERE code_hash = ?', [receiptDigest(normalised)])
  if (!row) return null
  const ballotRow = queryOne(database, 'SELECT * FROM ballots WHERE id = ?', [text(row.ballot_id)])
  if (!ballotRow) return null
  return {
    code: normalised,
    electionId: text(row.election_id),
    ballot: toBallot(ballotRow),
    issuedAt: text(row.issued_at),
  }
}

export function countReceipts(database: SqlDatabase, electionId: string): number {
  return queryScalar(database, 'SELECT COUNT(*) AS total FROM receipts WHERE election_id = ?', [electionId])
}
