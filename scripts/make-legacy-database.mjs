/**
 * Build a version-6 database with real votes, for testing the upgrade by hand.
 *
 * The schema is the shipped one with the ballot split reverted, so the only way this
 * fixture can be wrong is if the migration and this file disagree — and they are
 * derived from the same source, which is the point.
 *
 * Run with: node --experimental-strip-types scripts/make-legacy-database.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import initSqlJs from 'sql.js'

const target = process.argv[2] ?? path.resolve('data-legacy')
const source = fs.readFileSync(new URL('../src/server/db.ts', import.meta.url), 'utf8')
const current = /export const SCHEMA_SQL = `([\s\S]*?)`\n/.exec(source)?.[1]
if (!current) throw new Error('could not read SCHEMA_SQL from db.ts')

const previous = current
  .replace(/CREATE TABLE IF NOT EXISTS (ballots|participation|receipts|voting_credentials|eligibility) \([\s\S]*?\);\n/g, '')
  .replace(/CREATE INDEX IF NOT EXISTS (ballots_election|participation_voter|receipts_ballot)[^\n]*\n/g, '')
  .replace(/CREATE INDEX IF NOT EXISTS voting_credentials_voter\s*\n?\s*ON voting_credentials[^\n]*\n/g, '')
  .replace(
    "  external_ref TEXT NOT NULL DEFAULT '',\n  created_at TEXT NOT NULL,\n  UNIQUE (election_id, voter_id)",
    "  external_ref TEXT NOT NULL DEFAULT '',\n  is_eligible INTEGER NOT NULL DEFAULT 1,\n  created_at TEXT NOT NULL,\n  UNIQUE (election_id, voter_id)",
  )
  .replace(
    /CREATE TABLE IF NOT EXISTS admin_sessions \([\s\S]*?\);\n/,
    'CREATE TABLE IF NOT EXISTS admin_sessions (token TEXT PRIMARY KEY, admin_id INTEGER NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, mfa_verified_at TEXT, reauth_verified_at TEXT, last_seen_at TEXT, ip TEXT, user_agent TEXT, revoked_at TEXT, revoked_reason TEXT);\n',
  )
  .replace(
    /CREATE TABLE IF NOT EXISTS voter_sessions \([\s\S]*?\);\n/,
    'CREATE TABLE IF NOT EXISTS voter_sessions (token TEXT PRIMARY KEY, election_id TEXT NOT NULL, voter_record_id INTEGER NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL);\n',
  )
  .replace(
    /-- ={20,}\n-- Identity, eligibility, credentials, ballots, receipts\./,
    `CREATE TABLE IF NOT EXISTS votes (id INTEGER PRIMARY KEY AUTOINCREMENT, election_id TEXT NOT NULL, voter_record_id INTEGER NOT NULL, candidate_id INTEGER NOT NULL, selection_index INTEGER NOT NULL DEFAULT 1, receipt TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS votes_unique_selection ON votes (election_id, voter_record_id, selection_index);`,
  )

if (!/CREATE TABLE IF NOT EXISTS votes/.test(previous)) throw new Error('failed to revert the schema')
if (/CREATE TABLE IF NOT EXISTS ballots/.test(previous)) throw new Error('failed to remove the ballots table')

const SQL = await initSqlJs()
const db = new SQL.Database()
db.run(previous)
const T = '2026-09-20T10:00:00.000Z'

db.run(
  `INSERT INTO elections (id, title, description, election_type, timezone, starts_at, ends_at, status, rules, eligibility, created_at, updated_at, published_at, closed_at)
   VALUES ('E-OLD', 'Old election', 'd', 'student_representative', 'UTC', '2026-09-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', 'closed', ?, '{}', ?, ?, ?, ?)`,
  [JSON.stringify({ votesPerVoter: 1, issueReceipts: true }), T, T, T, T],
)
for (const [position, name] of [
  [10, 'Option A'],
  [11, 'Option B'],
]) {
  db.run('INSERT INTO candidates (election_id, name, position, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [
    'E-OLD',
    name,
    position,
    'approved',
    T,
    T,
  ])
}
for (const [voterId, name, eligible] of [
  ['V-1', 'One', 1],
  ['V-2', 'Two', 1],
  ['V-3', 'Three', 0],
]) {
  db.run('INSERT INTO roll_voters (election_id, voter_id, full_name, is_eligible, created_at) VALUES (?, ?, ?, ?, ?)', [
    'E-OLD',
    voterId,
    name,
    eligible,
    T,
  ])
}
// V-1 chose both options; V-2 chose one. The old table stored that mapping directly.
for (const [voterRecordId, candidateId, index, receipt] of [
  [1, 10, 1, 'AAAA-1111'],
  [1, 11, 2, 'DDDD-4444'],
  [2, 11, 1, 'BBBB-2222'],
]) {
  db.run(
    'INSERT INTO votes (election_id, voter_record_id, candidate_id, selection_index, receipt, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ['E-OLD', voterRecordId, candidateId, index, receipt, T],
  )
}
db.run('PRAGMA user_version = 6')

fs.mkdirSync(target, { recursive: true })
fs.writeFileSync(path.join(target, 'database.sqlite'), Buffer.from(db.export()))

console.log(`wrote a version-6 database to ${target}`)
console.log('  the mapping is directly readable:')
for (const row of db.exec(
  'SELECT r.voter_id, v.candidate_id, v.selection_index FROM votes v JOIN roll_voters r ON r.id = v.voter_record_id ORDER BY r.voter_id, v.selection_index',
)[0].values) {
  console.log(`    ${row[0]} -> option ${row[1]} (selection ${row[2]})`)
}
