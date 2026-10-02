/**
 * The v6 → v7 upgrade.
 *
 * The schema change is not additive: it removes the `votes` table, whose entire
 * content was a voter-to-candidate mapping, and replaces it with ballots that have no
 * voter column. So the migration has to do real work rather than add columns, and
 * getting it wrong would either destroy an election's result or leave the old mapping
 * in place.
 *
 * Each test starts from a database on the *previous* schema with a known mapping, runs
 * the real migration functions, and checks the three things that matter: the counts
 * survive, the mapping does not, and receipts people already hold still work.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import initSqlJs from 'sql.js'
import { queryAll, queryScalar, text, SCHEMA_SQL, type SqlDatabase } from './db'
import { MIGRATION_STEPS, anonymiseVotes, splitEligibilityOut } from './migrations'
import { countParticipants, findReceipt, tallyBallots } from './ballots'

const T0 = '2026-09-20T10:00:00.000Z'
const ELECTION = 'E-OLD'

let database: SqlDatabase

/*
 * The schema as it was at version 6: the shipped one with the ballot split undone.
 *
 * Derived from the real schema rather than written out by hand, so the parts that did
 * not change are genuinely identical and the test is not asserting against a
 * fiction. What is reverted is exactly what v7 replaced.
 */
function previousSchema(): string {
  const withoutNewTables = SCHEMA_SQL.replace(
    /CREATE TABLE IF NOT EXISTS (ballots|participation|receipts|voting_credentials|eligibility) \([\s\S]*?\);\n/g,
    '',
  )
    .replace(/CREATE INDEX IF NOT EXISTS (ballots_election|participation_voter|receipts_ballot)[^\n]*\n/g, '')
    .replace(/CREATE INDEX IF NOT EXISTS voting_credentials_voter\s*\n?\s*ON voting_credentials[^\n]*\n/g, '')
    // Eligibility was a column on the roll.
    .replace(
      "  external_ref TEXT NOT NULL DEFAULT '',\n  created_at TEXT NOT NULL,\n  UNIQUE (election_id, voter_id)",
      "  external_ref TEXT NOT NULL DEFAULT '',\n  is_eligible INTEGER NOT NULL DEFAULT 1,\n  created_at TEXT NOT NULL,\n  UNIQUE (election_id, voter_id)",
    )
    // Sessions were keyed on the raw token.
    .replace(
      /CREATE TABLE IF NOT EXISTS admin_sessions \([\s\S]*?\);\n/,
      'CREATE TABLE IF NOT EXISTS admin_sessions (token TEXT PRIMARY KEY, admin_id INTEGER NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, mfa_verified_at TEXT, reauth_verified_at TEXT, last_seen_at TEXT, ip TEXT, user_agent TEXT, revoked_at TEXT, revoked_reason TEXT);\n',
    )
    .replace(
      /CREATE TABLE IF NOT EXISTS voter_sessions \([\s\S]*?\);\n/,
      'CREATE TABLE IF NOT EXISTS voter_sessions (token TEXT PRIMARY KEY, election_id TEXT NOT NULL, voter_record_id INTEGER NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL);\n',
    )
    // And the table that has to go.
    .replace(
      /-- ={20,}\n-- Identity, eligibility, credentials, ballots, receipts\./,
      `CREATE TABLE IF NOT EXISTS votes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  election_id TEXT NOT NULL,
  voter_record_id INTEGER NOT NULL,
  candidate_id INTEGER NOT NULL,
  selection_index INTEGER NOT NULL DEFAULT 1,
  receipt TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS votes_unique_selection ON votes (election_id, voter_record_id, selection_index);`,
    )
  return withoutNewTables
}

function tableList(db: SqlDatabase): string[] {
  return queryAll(db, "SELECT name FROM sqlite_master WHERE type = 'table'").map((row) =>
    String((row as unknown as Record<string, unknown>).name),
  )
}

beforeEach(async () => {
  const SQL = await initSqlJs()
  database = new SQL.Database() as unknown as SqlDatabase
  database.run(previousSchema())

  database.run(
    `INSERT INTO elections (id, title, description, election_type, timezone, starts_at, ends_at, status, rules, eligibility, created_at, updated_at, published_at, closed_at)
     VALUES (?, 'Old election', 'd', 'student_representative', 'UTC', '2026-09-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', 'closed', ?, '{}', ?, ?, ?, ?)`,
    [ELECTION, JSON.stringify({ votesPerVoter: 1, issueReceipts: true }), T0, T0, T0, T0],
  )
  for (const [position, name] of [
    [10, 'Option A'],
    [11, 'Option B'],
  ] as const) {
    database.run(
      'INSERT INTO candidates (election_id, name, position, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      [ELECTION, name, position, 'approved', T0, T0],
    )
  }
  // Three voters; the third is ineligible and must stay that way.
  for (const [voterId, name, eligible] of [
    ['V-1', 'One', 1],
    ['V-2', 'Two', 1],
    ['V-3', 'Three', 0],
  ] as const) {
    database.run('INSERT INTO roll_voters (election_id, voter_id, full_name, is_eligible, created_at) VALUES (?, ?, ?, ?, ?)', [
      ELECTION,
      voterId,
      name,
      eligible,
      T0,
    ])
  }
  // The mapping to be destroyed: V-1 chose option 10, V-2 chose option 11.
  for (const [voterRecordId, candidateId, receipt] of [
    [1, 10, 'AAAA-1111'],
    [2, 11, 'BBBB-2222'],
  ] as const) {
    database.run(
      'INSERT INTO votes (election_id, voter_record_id, candidate_id, selection_index, receipt, created_at) VALUES (?, ?, ?, 1, ?, ?)',
      [ELECTION, voterRecordId, candidateId, receipt, T0],
    )
  }
})

afterEach(() => {
  database.close()
})

/** Run the upgrade the way the store does: create what is missing, then migrate. */
function upgrade(): void {
  database.run(SCHEMA_SQL)
  for (const step of MIGRATION_STEPS) step(database, { warn: () => {} })
}

describe('the previous schema is reconstructed faithfully', () => {
  it('has the old votes table and none of the new ones', () => {
    const tables = tableList(database)
    expect(tables).toContain('votes')
    expect(tables).not.toContain('ballots')
    expect(tables).not.toContain('participation')
    expect(tables).not.toContain('eligibility')
  })

  it('has eligibility on the roll, as it used to', () => {
    const columns = queryAll(database, 'PRAGMA table_info(roll_voters)').map((row) =>
      String((row as unknown as Record<string, unknown>).name),
    )
    expect(columns).toContain('is_eligible')
  })

  it('can read the old mapping, which is the thing that must stop being possible', () => {
    const rows = queryAll(
      database,
      `SELECT r.voter_id, v.candidate_id FROM votes v JOIN roll_voters r ON r.id = v.voter_record_id
        ORDER BY r.voter_id`,
    )
    expect(rows.map((row) => [text(row.voter_id), Number(row.candidate_id)])).toEqual([
      ['V-1', 10],
      ['V-2', 11],
    ])
  })
})

describe('upgrading preserves the result', () => {
  it('carries every ballot across', () => {
    upgrade()
    expect(queryScalar(database, 'SELECT COUNT(*) AS total FROM ballots')).toBe(2)
    expect(countParticipants(database, ELECTION)).toBe(2)
  })

  it('keeps the tally exactly as it was', () => {
    upgrade()
    const { counts, total, ballots } = tallyBallots(database, ELECTION)
    expect(ballots).toBe(2)
    expect(total).toBe(2)
    expect(counts.get(10)).toBe(1)
    expect(counts.get(11)).toBe(1)
  })

  it('groups a multi-selection ballot into one ballot', () => {
    database.run(
      'INSERT INTO votes (election_id, voter_record_id, candidate_id, selection_index, receipt, created_at) VALUES (?, 1, 11, 2, ?, ?)',
      [ELECTION, 'DDDD-4444', T0],
    )
    upgrade()
    expect(queryScalar(database, 'SELECT COUNT(*) AS total FROM ballots')).toBe(2)
    const multi = queryAll(database, 'SELECT selections, selection_count FROM ballots WHERE selection_count = 2')
    expect(multi).toHaveLength(1)
    expect(JSON.parse(text(multi[0].selections)).sort((a: number, b: number) => a - b)).toEqual([10, 11])
  })

  it('moves eligibility into its own table, keeping who was excluded', () => {
    upgrade()
    const rows = queryAll(database, 'SELECT voter_record_id, status FROM eligibility ORDER BY voter_record_id')
    expect(rows.map((row) => [Number(row.voter_record_id), text(row.status)])).toEqual([
      [1, 'eligible'],
      [2, 'eligible'],
      [3, 'ineligible'],
    ])
    expect(
      queryScalar(database, "SELECT COUNT(*) AS total FROM eligibility WHERE status = 'eligible' AND election_id = ?", [
        ELECTION,
      ]),
    ).toBe(2)
  })
})

describe('upgrading leaves the roll as identity only', () => {
  it('drops the eligibility column rather than leaving it looking authoritative', () => {
    upgrade()
    const columns = queryAll(database, 'PRAGMA table_info(roll_voters)').map((row) =>
      String((row as unknown as Record<string, unknown>).name),
    )
    expect(columns).not.toContain('is_eligible')
  })

  it('keeps every roll row, with its identity intact', () => {
    upgrade()
    expect(queryScalar(database, 'SELECT COUNT(*) AS total FROM roll_voters')).toBe(3)
    const rows = queryAll(database, 'SELECT voter_id, full_name FROM roll_voters ORDER BY voter_id')
    expect(rows.map((row) => [text(row.voter_id), text(row.full_name)])).toEqual([
      ['V-1', 'One'],
      ['V-2', 'Two'],
      ['V-3', 'Three'],
    ])
  })

  it('preserves record ids, so participation still points at the right person', () => {
    upgrade()
    const joined = queryAll(
      database,
      `SELECT r.voter_id, p.credential_id IS NULL AS migrated
         FROM roll_voters r JOIN participation p ON p.voter_record_id = r.id
        ORDER BY r.voter_id`,
    )
    expect(joined.map((row) => text(row.voter_id))).toEqual(['V-1', 'V-2'])
  })

  it('keeps the election-scoped index', () => {
    upgrade()
    const indexes = queryAll(database, "SELECT name FROM sqlite_master WHERE type = 'index'").map((row) =>
      String((row as unknown as Record<string, unknown>).name),
    )
    expect(indexes).toContain('roll_voters_election')
  })
})

describe('upgrading destroys the mapping', () => {
  it('drops the votes table entirely', () => {
    upgrade()
    expect(tableList(database)).not.toContain('votes')
  })

  it('leaves no query that pairs a voter with a choice', () => {
    upgrade()
    const joined = queryAll(
      database,
      `SELECT r.voter_id, b.selections FROM roll_voters r
         JOIN participation p ON p.voter_record_id = r.id AND p.election_id = r.election_id
         JOIN ballots b ON b.election_id = p.election_id
        WHERE r.election_id = ?`,
      [ELECTION],
    )
    // A cross product of two ballots against two participations, not a correspondence.
    expect(joined).toHaveLength(4)
  })

  it('cannot pair them by id, because ballot ids are random', () => {
    upgrade()
    const byId = queryAll(
      database,
      `SELECT b.id FROM ballots b JOIN participation p
         ON p.election_id = b.election_id AND p.credential_id = b.id`,
    )
    expect(byId).toHaveLength(0)
    for (const row of queryAll(database, 'SELECT id FROM ballots')) {
      expect(text(row.id)).toMatch(/^[0-9a-f]{32}$/)
    }
  })

  it('no longer stores the selections in a per-row, per-candidate shape', () => {
    upgrade()
    const columns = queryAll(database, 'PRAGMA table_info(ballots)').map((row) =>
      String((row as unknown as Record<string, unknown>).name),
    )
    expect(columns).not.toContain('candidate_id')
    expect(columns).toContain('selections')
  })
})

describe('upgrading keeps receipts people already hold', () => {
  it('a receipt written before the upgrade still resolves to its ballot', () => {
    upgrade()
    const found = findReceipt(database, 'AAAA-1111')
    expect(found).not.toBeNull()
    expect(found?.electionId).toBe(ELECTION)
    expect(found?.ballot.selections).toEqual([10])
  })

  it('and resolves however the code is typed', () => {
    upgrade()
    for (const typed of ['AAAA-1111', 'aaaa1111', 'AAAA1111', 'aaaa-1111']) {
      expect(findReceipt(database, typed)?.ballot.selections).toEqual([10])
    }
  })

  it('each voter still has their own receipt, and they point at different ballots', () => {
    upgrade()
    const first = findReceipt(database, 'AAAA-1111')
    const second = findReceipt(database, 'BBBB-2222')
    expect(first?.ballot.id).not.toBe(second?.ballot.id)
    expect(first?.ballot.selections).toEqual([10])
    expect(second?.ballot.selections).toEqual([11])
  })

  it('stores receipts as a digest, as the new schema requires', () => {
    upgrade()
    const stored = queryAll(database, 'SELECT code_hash FROM receipts')
    const expected = createHash('sha256').update('AAAA1111').digest('hex')
    expect(stored.map((row) => text(row.code_hash))).toContain(expected)
    expect(JSON.stringify(stored)).not.toContain('AAAA-1111')
  })
})

describe('the migration is safe to run twice', () => {
  it('a second run changes nothing', () => {
    upgrade()
    const before = {
      ballots: queryScalar(database, 'SELECT COUNT(*) AS total FROM ballots'),
      participation: countParticipants(database, ELECTION),
      receipts: queryScalar(database, 'SELECT COUNT(*) AS total FROM receipts'),
      eligibility: queryScalar(database, 'SELECT COUNT(*) AS total FROM eligibility'),
    }
    for (const step of MIGRATION_STEPS) step(database, { warn: () => {} })
    expect({
      ballots: queryScalar(database, 'SELECT COUNT(*) AS total FROM ballots'),
      participation: countParticipants(database, ELECTION),
      receipts: queryScalar(database, 'SELECT COUNT(*) AS total FROM receipts'),
      eligibility: queryScalar(database, 'SELECT COUNT(*) AS total FROM eligibility'),
    }).toEqual(before)
  })

  it('and on a database that never had the old table it is a no-op', () => {
    const SQL = initSqlJs
    void SQL
    upgrade()
    expect(() => anonymiseVotes(database, { warn: () => {} })).not.toThrow()
    expect(() => splitEligibilityOut(database, { warn: () => {} })).not.toThrow()
  })
})

describe('migrated ballots are marked as such rather than given a false digest', () => {
  it('does not claim an integrity digest it cannot substantiate', () => {
    upgrade()
    for (const row of queryAll(database, 'SELECT integrity_digest FROM ballots')) {
      // The old schema kept no per-voter submission time, so a keyed digest over one
      // cannot be recomputed honestly. Saying "migrated" is truthful; inventing a
      // digest would let an auditor believe a historical ballot was verified when it
      // never was.
      expect(text(row.integrity_digest)).toBe('migrated')
    }
  })
})
