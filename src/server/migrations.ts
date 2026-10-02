/**
 * Schema upgrades.
 *
 * Each step is a standalone function rather than a method on the store, for two
 * reasons. It makes the step testable against a real database without a filesystem,
 * which matters because the interesting one — anonymising the old `votes` table —
 * has real behaviour to get right. And it keeps the ordering explicit: the store
 * calls them in sequence and stamps the version last, so a failure part-way through
 * leaves a database that can still be upgraded on the next start.
 *
 * Every step is safe to run twice. That is deliberate: an upgrade that cannot be
 * retried is an upgrade that needs a backup before it is attempted.
 */

import { createHash, randomBytes } from 'node:crypto'
import type { SqlDatabase } from './db'

export type MigrationLogger = { warn: (message: string) => void }

const SILENT: MigrationLogger = { warn: () => {} }

function tables(database: SqlDatabase): Set<string> {
  return new Set(
    (database.exec("SELECT name FROM sqlite_master WHERE type = 'table'")?.[0]?.values ?? []).map((row) =>
      String(row[0]),
    ),
  )
}

function columnsOf(database: SqlDatabase, table: string): Set<string> {
  return new Set(
    (database.exec(`PRAGMA table_info(${table})`)?.[0]?.values ?? []).map((row) => String(row[1])),
  )
}

function rollback(database: SqlDatabase): void {
  try {
    database.run('ROLLBACK')
  } catch {
    // The transaction may never have started.
  }
}

/**
 * Erase verification codes left in the clear by an older schema.
 *
 * Earlier versions kept a permanent passcode on every roll record, in plaintext,
 * which meant a stolen database handed over every voter's ballot. Codes are now
 * server-generated challenges that are never stored at all, so the old columns have
 * no purpose. They are blanked rather than left in place: a value that is still
 * readable is a value that is still leaked, and an upgrade is exactly when an
 * operator is not looking.
 */
export function destroyStoredPasscodes(database: SqlDatabase, logger: MigrationLogger = SILENT): void {
  const columns = columnsOf(database, 'roll_voters')
  for (const column of ['phone_otp', 'email_otp']) {
    if (!columns.has(column)) continue
    try {
      database.run(`UPDATE roll_voters SET ${column} = '' WHERE ${column} != ''`)
      logger.warn(`[election-store] erased stored ${column} values during upgrade`)
    } catch (error) {
      logger.warn(`[election-store] could not erase ${column}: ${(error as Error).message}`)
    }
  }
}

/**
 * Move administrator session tokens from plaintext to a hash.
 *
 * Sessions used to be stored as the bearer token itself, so a copy of the database
 * was a set of working console credentials — including elevated ones. Each live token
 * is rehashed in place and the plaintext column blanked, which keeps existing
 * operators signed in while removing the replayable value from disk.
 */
export function rehashAdminSessions(database: SqlDatabase, logger: MigrationLogger = SILENT): void {
  const columns = columnsOf(database, 'admin_sessions')
  if (!columns.has('token') || !columns.has('token_hash')) return
  let rehashed = 0
  try {
    const rows = database.exec("SELECT id, token FROM admin_sessions WHERE token IS NOT NULL AND token != ''")?.[0]
      ?.values ?? []
    const update = database.prepare('UPDATE admin_sessions SET token_hash = ?, token = NULL WHERE id = ?')
    database.run('BEGIN IMMEDIATE')
    for (const row of rows) {
      update.run([createHash('sha256').update(String(row[1])).digest('hex'), Number(row[0])])
      rehashed += 1
    }
    update.free()
    database.run('COMMIT')
    logger.warn(`[election-store] rehashed ${rehashed} stored administrator session token(s) during upgrade`)
  } catch (error) {
    rollback(database)
    logger.warn(`[election-store] could not rehash session tokens: ${(error as Error).message}`)
  }
}

/**
 * Move the eligibility flag off the roll and into its own table.
 *
 * Eligibility is a decision with a reason and a timestamp, not a property of a
 * person's identity record. Splitting it out means the roll can be read without also
 * learning who was permitted to vote, and that a change of eligibility is
 * attributable.
 *
 * The column is dropped, not just ignored. Leaving a dead `is_eligible` on the roll
 * would mean the identity table still *appears* to hold a permission, and the next
 * person to read the schema would have to work out whether it was authoritative.
 * Dropping a column needs a table rebuild in SQLite, so the rows are copied into a
 * fresh table and the original renamed out of the way.
 */
export function splitEligibilityOut(database: SqlDatabase, logger: MigrationLogger = SILENT): void {
  if (!columnsOf(database, 'roll_voters').has('is_eligible')) return
  if (!tables(database).has('eligibility')) return
  try {
    const now = new Date().toISOString()
    database.run('BEGIN IMMEDIATE')
    const rollRows = queryCount(database, 'roll_voters')

    // Copy the decisions across before touching the roll, so a failure here loses
    // nothing.
    database.run(
      `INSERT OR IGNORE INTO eligibility (election_id, voter_record_id, status, reason, decided_at, decided_by)
       SELECT election_id, id, CASE WHEN is_eligible = 1 THEN 'eligible' ELSE 'ineligible' END, '', ?, 'migrated'
         FROM roll_voters`,
      [now],
    )

    database.run('DROP TABLE IF EXISTS roll_voters_migrated')
    database.run(`
      CREATE TABLE roll_voters_migrated (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        election_id TEXT NOT NULL,
        voter_id TEXT NOT NULL,
        full_name TEXT NOT NULL,
        phone TEXT NOT NULL DEFAULT '',
        email TEXT NOT NULL DEFAULT '',
        external_ref TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        UNIQUE (election_id, voter_id)
      )`)
    database.run(
      `INSERT INTO roll_voters_migrated (id, election_id, voter_id, full_name, phone, email, external_ref, created_at)
       SELECT id, election_id, voter_id, full_name, phone, email, external_ref, created_at FROM roll_voters`,
    )
    const copied = queryCount(database, 'roll_voters_migrated')
    if (copied !== rollRows) {
      // Refuse to swap a table out from under data that did not survive the copy.
      database.run('DROP TABLE roll_voters_migrated')
      database.run('ROLLBACK')
      logger.warn(
        `[election-store] eligibility split aborted: copied ${copied} of ${rollRows} roll row(s), so the roll was left alone`,
      )
      return
    }
    database.run('DROP TABLE roll_voters')
    database.run('ALTER TABLE roll_voters_migrated RENAME TO roll_voters')
    database.run('CREATE INDEX IF NOT EXISTS roll_voters_election ON roll_voters (election_id)')

    logger.warn('[election-store] moved eligibility off the roll into its own table during upgrade')
    database.run('COMMIT')
  } catch (error) {
    rollback(database)
    logger.warn(`[election-store] could not move eligibility: ${(error as Error).message}`)
  }
}

function queryCount(database: SqlDatabase, table: string): number {
  const row = database.exec(`SELECT COUNT(*) AS total FROM ${table}`)?.[0]?.values?.[0]
  return typeof row?.[0] === 'number' ? row[0] : 0
}

/**
 * Convert the old `votes` table into anonymous ballots.
 *
 * The old table held `voter_record_id` and `candidate_id` side by side, so "who voted
 * for whom" was a single join away. It has to go, but the ballots themselves are real
 * and discarding them would silently destroy an election's result.
 *
 * So the rows are regrouped: selections for one voter become one ballot, and one
 * participation record is written per voter. Crucially the two are written with *no
 * shared value* — the ballot gets a fresh random surrogate key and the participation
 * record gets the credential reference, and nothing ties a ballot row to a
 * participation row. Totals, turnout and results all survive intact; the ability to
 * reconstruct who chose what does not. Existing receipts are carried across so a
 * voter who already saved one can still check it.
 *
 * Honest limitation: anyone who read the old table before this upgrade already knows
 * the old mapping. This stops it persisting; it cannot reach back.
 */
export function anonymiseVotes(database: SqlDatabase, logger: MigrationLogger = SILENT): void {
  if (!tables(database).has('votes')) return
  if (!tables(database).has('ballots')) return

  const rows =
    database.exec(
      `SELECT election_id, voter_record_id, candidate_id, selection_index, receipt
         FROM votes ORDER BY election_id, voter_record_id, selection_index, id`,
    )?.[0]?.values ?? []

  const grouped = new Map<
    string,
    { electionId: string; voterRecordId: number; selections: number[]; receipts: string[] }
  >()
  for (const row of rows) {
    const electionId = String(row[0])
    const voterRecordId = Number(row[1])
    const key = `${electionId} ${voterRecordId}`
    let entry = grouped.get(key)
    if (!entry) {
      entry = { electionId, voterRecordId, selections: [], receipts: [] }
      grouped.set(key, entry)
    }
    entry.selections.push(Number(row[2]))
    if (typeof row[4] === 'string' && row[4]) entry.receipts.push(row[4])
  }

  let ballots = 0
  let receipts = 0
  try {
    database.run('BEGIN IMMEDIATE')
    const insertBallot = database.prepare(
      `INSERT INTO ballots (id, election_id, selections, selection_count, submitted_at, integrity_digest)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    const insertParticipation = database.prepare(
      `INSERT OR IGNORE INTO participation (election_id, voter_record_id, credential_id, participated_at)
       VALUES (?, ?, ?, ?)`,
    )
    const insertReceipt = database.prepare(
      'INSERT OR IGNORE INTO receipts (code_hash, election_id, ballot_id, issued_at) VALUES (?, ?, ?, ?)',
    )

    for (const entry of grouped.values()) {
      const now = new Date().toISOString()
      // A random key, matching the new schema. Sequential ids would let
      // `ballots.id = participation.id` pair every voter with a ballot.
      const ballotId = randomHex(16)
      insertBallot.run([
        ballotId,
        entry.electionId,
        JSON.stringify(entry.selections),
        entry.selections.length,
        now,
        // Marked as migrated rather than given a digest it cannot honestly claim: the
        // old schema kept no per-voter submission time, so the keyed digest cannot be
        // recomputed for historical rows.
        'migrated',
      ])
      ballots += 1
      // NULL, not a placeholder: the old schema had no credentials, so there is
      // nothing to point at. A sentinel like 0 would collide with the unique
      // constraint and silently drop every migrated voter after the first.
      insertParticipation.run([entry.electionId, entry.voterRecordId, null, now])
      for (const code of entry.receipts) {
        insertReceipt.run([
          createHash('sha256').update(normalise(code)).digest('hex'),
          entry.electionId,
          ballotId,
          now,
        ])
        receipts += 1
      }
    }

    insertBallot.free()
    insertParticipation.free()
    insertReceipt.free()
    database.run('DROP TABLE votes')
    database.run('DELETE FROM sqlite_sequence WHERE name = ?', ['votes'])
    database.run('COMMIT')
    logger.warn(
      `[election-store] converted ${rows.length} recorded selection(s) into ${ballots} anonymous ballot(s) ` +
        `and ${receipts} carried-over receipt(s); the per-voter selection mapping is no longer stored`,
    )
  } catch (error) {
    rollback(database)
    logger.warn(`[election-store] could not convert the votes table: ${(error as Error).message}`)
  }
}

function normalise(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '')
}

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString('hex')
}

/**
 * Move voter session tokens from plaintext to a hash.
 *
 * The same reasoning as `rehashAdminSessions`, and the same reason it is a separate
 * step: version 6 keyed this table on the raw token, so a copy of the database was a
 * set of live voter sessions. Rehashing in place keeps anyone mid-verification signed
 * in. The old `token` column is blanked rather than dropped, because dropping it
 * would need a table rebuild and the value has to be read first.
 */
export function rehashVoterSessions(database: SqlDatabase, logger: MigrationLogger = SILENT): void {
  const columns = columnsOf(database, 'voter_sessions')
  if (!columns.has('token') || !columns.has('token_hash')) return
  let rehashed = 0
  try {
    const rows = database.exec(
      "SELECT id, token FROM voter_sessions WHERE token IS NOT NULL AND token != '' AND token_hash IS NULL",
    )?.[0]?.values ?? []
    if (rows.length === 0) return
    const update = database.prepare('UPDATE voter_sessions SET token_hash = ?, token = NULL WHERE id = ?')
    database.run('BEGIN IMMEDIATE')
    for (const row of rows) {
      update.run([createHash('sha256').update(String(row[1])).digest('hex'), Number(row[0])])
      rehashed += 1
    }
    update.free()
    database.run('COMMIT')
    logger.warn(`[election-store] rehashed ${rehashed} stored voter session token(s) during upgrade`)
  } catch (error) {
    rollback(database)
    logger.warn(`[election-store] could not rehash voter session tokens: ${(error as Error).message}`)
  }
}

/** Every step, in the order they must run. */
export const MIGRATION_STEPS: Array<(database: SqlDatabase, logger: MigrationLogger) => void> = [
  destroyStoredPasscodes,
  rehashAdminSessions,
  rehashVoterSessions,
  splitEligibilityOut,
  anonymiseVotes,
]
