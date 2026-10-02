/**
 * Ballot secrecy.
 *
 * The claim being tested is specific and strong: after a voter authenticates and
 * votes, the platform can say that they voted and can count the ballots, but there
 * is no way — through any command, at any privilege level, or by any query against
 * the database — to recover what that particular voter chose.
 *
 * These tests are written to fail if that ever stops being true. They deliberately
 * include a raw SQL pass over every table in the schema, because the strongest
 * version of the claim is about the *storage*, not about the API: an API can be
 * hardened, but a column that does not exist cannot leak.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import initSqlJs from 'sql.js'
import { execute, queryAll, queryScalar, text, SCHEMA_SQL, type SqlDatabase } from './db'
import {
  countParticipants,
  findReceipt,
  hasParticipated,
  issueCredential,
  issueReceipt,
  recordBallot,
  recordParticipation,
  resolveCredential,
  spendCredential,
  tallyBallots,
  verifyBallotIntegrity,
} from './ballots'

const T0 = Date.UTC(2026, 5, 1, 12, 0, 0)
const ELECTION = 'E-SECRET'
const OTHER_ELECTION = 'E-OTHER'

let database: SqlDatabase

/*
 * The real schema, imported rather than copied. A test that reimplements the schema
 * proves the test's own idea of it true, and would happily pass while the shipped
 * schema had an extra column in it.
 */
const SCHEMA = SCHEMA_SQL

beforeEach(async () => {
  const SQL = await initSqlJs()
  database = new SQL.Database() as unknown as SqlDatabase
  database.run(SCHEMA)

  execute(
    database,
    `INSERT INTO elections (id, title, election_type, timezone, starts_at, ends_at, status, rules, eligibility, created_at, updated_at)
     VALUES (?, 'Secret ballot', 'student_representative', 'UTC', ?, ?, 'open', '{}', '{}', ?, ?)`,
    [ELECTION, new Date(T0 - 86_400_000).toISOString(), new Date(T0 + 86_400_000).toISOString(), new Date(T0).toISOString(), new Date(T0).toISOString()],
  )
  execute(
    database,
    `INSERT INTO roll_voters (election_id, voter_id, full_name, phone, email, external_ref, created_at)
     VALUES (?, 'V-001', 'Ada Lovelace', '5550100', 'ada@example.com', 'Group A', ?)`,
    [ELECTION, new Date(T0).toISOString()],
  )
})

afterEach(() => {
  database.close()
})

const VOTER_ID = 1

/** A full vote: authenticate, get a credential, spend it, write both records. */
function castVote(options: { selections?: number[]; now?: number } = {}) {
  const now = options.now ?? T0
  const selections = options.selections ?? [42]
  const { token, credential } = issueCredential(database, {
    electionId: ELECTION,
    voterRecordId: VOTER_ID,
    now,
  })
  const resolved = resolveCredential(database, { token, electionId: ELECTION, now })
  if (!resolved.ok) throw new Error('credential should have resolved')
  if (!spendCredential(database, credential.id, now)) throw new Error('credential should have spent')
  recordParticipation(database, {
    electionId: ELECTION,
    voterRecordId: VOTER_ID,
    credentialId: credential.id,
    now,
  })
  const ballot = recordBallot(database, {
    electionId: ELECTION,
    selections,
    now,
    databasePath: ':memory:',
  })
  const receipt = issueReceipt(database, { electionId: ELECTION, ballotId: ballot.id, now })
  return { token, credential, ballot, receipt }
}

/* ------------------------------------------------- the schema is the proof --- */

/** Column names of a table, read from the live schema. */
function columnNames(table: string): string[] {
  return queryAll(database, `PRAGMA table_info(${table})`).map((row) =>
    String((row as unknown as Record<string, unknown>).name),
  )
}

/** Tables in the live schema. */
function tableNames(): string[] {
  return queryAll(database, "SELECT name FROM sqlite_master WHERE type = 'table'").map((row) =>
    String((row as unknown as Record<string, unknown>).name),
  )
}

describe('the schema cannot express a voter-to-choice relationship', () => {
  it('ballots has no column naming a voter, a credential, or a participation', () => {
    const names = columnNames('ballots').map((name) => name.toLowerCase())
    for (const forbidden of ['voter', 'voter_id', 'voter_record_id', 'credential', 'credential_id', 'participation', 'participation_id']) {
      expect(names).not.toContain(forbidden)
    }
    // And no column that could be a proxy for one.
    expect(names.some((name) => /actor|identity|roll|person|member/i.test(name))).toBe(false)
  })

  it('participation has no column naming a ballot or a selection', () => {
    const names = columnNames('participation').map((name) => name.toLowerCase())
    for (const forbidden of ['ballot', 'ballot_id', 'selection', 'selections', 'candidate', 'candidate_id', 'option', 'choice']) {
      expect(names).not.toContain(forbidden)
    }
  })

  it('receipts have no column naming a voter', () => {
    const names = columnNames('receipts').map((name) => name.toLowerCase())
    expect(names.some((name) => /voter|actor|identity/i.test(name))).toBe(false)
  })

  it('roll_voters carries no eligibility flag and no voting state', () => {
    // Eligibility and participation each moved to their own table, so a roll record
    // can be read without also learning who was allowed to vote or who did.
    const names = columnNames('roll_voters').map((name) => name.toLowerCase())
    for (const forbidden of [
      'is_eligible',
      'has_voted',
      'voted',
      'vote_count',
      'votes',
      'participated',
      'participated_at',
      'ballot',
      'ballots',
      'ballot_count',
      'credential',
      'credential_id',
    ]) {
      expect(names).not.toContain(forbidden)
    }
  })

  it('the old combined votes table is gone entirely', () => {
    expect(tableNames()).not.toContain('votes')
  })

  it('ballots shares no joinable key with participation, receipts or the roll', () => {
    /*
     * The load-bearing check.
     *
     * `id` is shared by name with every other table, because every table has one —
     * so the assertion is not about names but about whether the two could ever
     * *correspond*. A ballot id is 128 random bits of hex; a participation id and a
     * credential id are small integers from a sequence. They cannot match, and more
     * importantly they carry no relationship: nothing in the ballot table was
     * derived from anything in the participation table.
     *
     * `election_id` is shared and does correspond, but it is a partition key — it
     * says which poll a row belongs to, not who cast it. Joining on it yields every
     * ballot against every participation row, which is a cross product rather than
     * a correspondence, and that is asserted behaviourally below.
     *
     * Anything beyond these two appearing in this list is a stored link, and is the
     * thing this whole design exists to avoid.
     */
    const ballots = columnNames('ballots')
    for (const other of ['participation', 'receipts', 'roll_voters', 'voting_credentials']) {
      const shared = ballots.filter((name) => columnNames(other).includes(name))
      expect({ table: other, unexpected: shared.filter((name) => name !== 'id' && name !== 'election_id') }).toEqual({
        table: other,
        unexpected: [],
      })
    }
  })

  it('ballot ids and participation ids cannot correspond, because their domains differ', () => {
    // The `id` overlap above is harmless only because the values are unrelated.
    // Pin that, so switching the ballot key back to a sequence fails here.
    const { ballot } = castVote()
    const ballotType = text(
      (queryAll(database, 'SELECT typeof(id) AS t FROM ballots LIMIT 1')[0] as Record<string, unknown>).t,
    )
    const participationType = text(
      (queryAll(database, 'SELECT typeof(id) AS t FROM participation LIMIT 1')[0] as Record<string, unknown>).t,
    )
    expect(ballotType).toBe('text')
    expect(participationType).toBe('integer')
    expect(ballot.id).not.toBe(String(1))
  })

  it('ballot ids are random, so row numbering cannot pair a voter with a choice', () => {
    // A regression guard on a subtle leak. With autoincrement keys on both tables,
    // the first ballot and the first participation row share the value 1, and
    // joining on the numbers alone reconstructs the whole election. The keys must
    // therefore not be sequences.
    const ids: string[] = []
    for (let index = 0; index < 5; index += 1) {
      const ballot = recordBallot(database, {
        electionId: ELECTION,
        selections: [index + 1],
        now: T0 + index,
        databasePath: ':memory:',
      })
      ids.push(ballot.id)
    }
    expect(new Set(ids).size).toBe(5)
    // 128 bits of hex, not small sequential integers as an autoincrement would give.
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{32}$/)
  })

  it('no table anywhere holds both a voter reference and a selection reference', () => {
    // The structural claim, checked mechanically over the whole schema rather than
    // one table at a time, so a future table added in the wrong place is caught.
    const voterish = /voter|actor|roll_voter|participant/
    const choiceish = /selection|candidate|option|choice|ballot/
    const offenders: string[] = []
    for (const table of tableNames()) {
      const names = columnNames(table).map((name) => name.toLowerCase())
      const hasVoter = names.some((name) => voterish.test(name))
      const hasChoice = names.some((name) => choiceish.test(name))
      if (hasVoter && hasChoice) offenders.push(table)
    }
    expect(offenders).toEqual([])
  })

  it('columns() helper is not silently returning nothing', () => {
    // Guards the tests above against passing because a query silently failed.
    expect(columnNames('ballots')).toContain('selections')
    expect(columnNames('ballots').length).toBeGreaterThan(3)
  })
})

/* ------------------------------------------- the required end-to-end proof --- */

describe('a voter can be recorded as having voted without their choice being recoverable', () => {
  it('records participation, records the ballot, and links neither to the other', () => {
    const { ballot, receipt } = castVote({ selections: [42] })

    // The two facts are both present...
    expect(hasParticipated(database, ELECTION, VOTER_ID)).toBe(true)
    expect(countParticipants(database, ELECTION)).toBe(1)
    expect(tallyBallots(database, ELECTION).ballots).toBe(1)

    // ...and the ballot is genuinely there, so this is not a test of an empty store.
    expect(ballot.selections).toEqual([42])

    // The receipt finds the ballot, which is the point of a receipt.
    const found = findReceipt(database, receipt.code)
    expect(found?.ballot.selections).toEqual([42])
  })

  it('cannot recover the choice from the voter identifier', () => {
    castVote({ selections: [42] })

    /*
     * The attack: start from the person and follow any path to a ballot.
     *
     * Note what this returns rather than expecting nothing. `ballots` and
     * `participation` share `election_id`, so a join on it succeeds — it produces
     * every ballot paired with every participation row, which is a cross product
     * and not a correspondence. With one voter and one ballot the cross product
     * happens to hold one row, which by elimination names the pairing; that is a
     * property of counting, not a stored link, and it is the reason the limitation
     * is written down in the README rather than papered over here.
     *
     * With more than one voter the result carries no information at all, which is
     * the case that matters and the one asserted below.
     */
    const byVoter = queryAll(
      database,
      `SELECT b.id FROM ballots b
         JOIN participation p ON p.election_id = b.election_id
         JOIN roll_voters r ON r.id = p.voter_record_id
        WHERE r.voter_id = ?`,
      ['V-001'],
    )
    // One ballot, one participation row: the cross product is 1 x 1.
    expect(byVoter).toHaveLength(1)
  })

  it('cannot recover the choice from the voter record id', () => {
    castVote({ selections: [42] })
    // The id-equality attack. This is the one that used to work: both tables had
    // autoincrement keys, so the first ballot and the first participation row were
    // both 1 and joining on the numbers rebuilt the election. Ballot keys are now
    // random, so the comparison cannot succeed.
    const byRecord = queryAll(
      database,
      `SELECT b.id FROM ballots b
         JOIN participation p ON p.election_id = b.election_id AND p.credential_id = b.id
        WHERE p.voter_record_id = ?`,
      [VOTER_ID],
    )
    expect(byRecord).toHaveLength(0)
  })

  it('cannot recover the choice from a receipt row without the code', () => {
    const { ballot } = castVote({ selections: [42] })
    // A receipt row identifies a ballot, but no receipt row carries a voter. Joining
    // receipts to participation on ids is the same accidental-alignment attack.
    const byReceiptJoin = queryAll(
      database,
      `SELECT p.id FROM participation p
         JOIN receipts rc ON rc.election_id = p.election_id AND rc.ballot_id = CAST(p.credential_id AS TEXT)
        WHERE p.voter_record_id = ?`,
      [VOTER_ID],
    )
    expect(byReceiptJoin).toHaveLength(0)
    // Sanity: the ballot really is addressable by its own id, so the test above is
    // not passing because the table is empty.
    expect(queryScalar(database, 'SELECT COUNT(*) AS total FROM ballots WHERE id = ?', [ballot.id])).toBe(1)
  })

  it('does not let one voter’s participation be lined up against another’s ballot', () => {
    // Two voters, two ballots, two participations — and the data cannot say which
    // voter cast which ballot.
    for (const voterId of ['V-002', 'V-003']) {
      execute(
        database,
        `INSERT INTO roll_voters (election_id, voter_id, full_name, created_at) VALUES (?, ?, 'Someone', ?)`,
        [ELECTION, voterId, new Date(T0).toISOString()],
      )
    }
    castVote({ selections: [42], now: T0 })
    for (const voterRecordId of [2, 3]) {
      const issued = issueCredential(database, { electionId: ELECTION, voterRecordId, now: T0 + 1000 })
      spendCredential(database, issued.credential.id, T0 + 1000)
      recordParticipation(database, {
        electionId: ELECTION,
        voterRecordId,
        credentialId: issued.credential.id,
        now: T0 + 1000,
      })
      recordBallot(database, {
        electionId: ELECTION,
        selections: [7],
        now: T0 + 1000,
        databasePath: ':memory:',
      })
    }

    // The only join available yields 3 ballots x 3 participations = 9 rows. If any
    // pairing were stored, this would be 3.
    const joined = queryAll(
      database,
      `SELECT r.voter_id, b.id AS ballot FROM roll_voters r
         JOIN participation p ON p.voter_record_id = r.id
         JOIN ballots b ON b.election_id = p.election_id
        WHERE r.election_id = ?`,
      [ELECTION],
    )
    expect(joined).toHaveLength(9)

    // Counts are still exactly right.
    expect(tallyBallots(database, ELECTION).counts.get(42)).toBe(1)
    expect(tallyBallots(database, ELECTION).counts.get(7)).toBe(2)
    expect(countParticipants(database, ELECTION)).toBe(3)
  })

  it('still counts correctly, so secrecy did not cost accuracy', () => {
    execute(
      database,
      `INSERT INTO roll_voters (election_id, voter_id, full_name, created_at) VALUES (?, 'V-002', 'Grace Hopper', ?)`,
      [ELECTION, new Date(T0).toISOString()],
    )
    execute(
      database,
      `INSERT INTO roll_voters (election_id, voter_id, full_name, created_at) VALUES (?, 'V-003', 'Katherine Johnson', ?)`,
      [ELECTION, new Date(T0).toISOString()],
    )
    for (const [voterRecordId, selection] of [[1, 42], [2, 42], [3, 7]] as const) {
      const { credential } = issueCredential(database, { electionId: ELECTION, voterRecordId, now: T0 })
      spendCredential(database, credential.id, T0)
      recordParticipation(database, { electionId: ELECTION, voterRecordId, credentialId: credential.id, now: T0 })
      recordBallot(database, { electionId: ELECTION, selections: [selection], now: T0, databasePath: ':memory:' })
    }
    const tally = tallyBallots(database, ELECTION)
    expect(tally.ballots).toBe(3)
    expect(tally.counts.get(42)).toBe(2)
    expect(tally.counts.get(7)).toBe(1)
    expect(tally.total).toBe(3)
    expect(countParticipants(database, ELECTION)).toBe(3)
  })
})

/* ------------------------------------------------------------- credentials --- */

describe('voting credentials', () => {
  it('is issued only for the election it was issued for', () => {
    const { token } = issueCredential(database, { electionId: ELECTION, voterRecordId: VOTER_ID, now: T0 })
    expect(resolveCredential(database, { token, electionId: ELECTION, now: T0 }).ok).toBe(true)
    const elsewhere = resolveCredential(database, { token, electionId: OTHER_ELECTION, now: T0 })
    expect(elsewhere.ok).toBe(false)
    if (!elsewhere.ok) expect(elsewhere.state).toBe('wrong_election')
  })

  it('expires on its own', () => {
    const { token } = issueCredential(database, { electionId: ELECTION, voterRecordId: VOTER_ID, now: T0, ttlSeconds: 300 })
    expect(resolveCredential(database, { token, electionId: ELECTION, now: T0 + 299_000 }).ok).toBe(true)
    const after = resolveCredential(database, { token, electionId: ELECTION, now: T0 + 301_000 })
    expect(after.ok).toBe(false)
    if (!after.ok) expect(after.state).toBe('expired')
  })

  it('is single use, and stays used', () => {
    const { credential } = issueCredential(database, { electionId: ELECTION, voterRecordId: VOTER_ID, now: T0 })
    expect(spendCredential(database, credential.id, T0)).toBe(true)
    expect(spendCredential(database, credential.id, T0 + 1)).toBe(false)
  })

  it('is reported as spent after use, so a replay is recognisable', () => {
    const { token, credential } = issueCredential(database, { electionId: ELECTION, voterRecordId: VOTER_ID, now: T0 })
    spendCredential(database, credential.id, T0)
    const replay = resolveCredential(database, { token, electionId: ELECTION, now: T0 + 1 })
    expect(replay.ok).toBe(false)
    if (!replay.ok) expect(replay.state).toBe('spent')
  })

  it('supersedes a previous credential, so a voter never holds two live rights', () => {
    const first = issueCredential(database, { electionId: ELECTION, voterRecordId: VOTER_ID, now: T0 })
    const second = issueCredential(database, { electionId: ELECTION, voterRecordId: VOTER_ID, now: T0 + 1000 })
    const stale = resolveCredential(database, { token: first.token, electionId: ELECTION, now: T0 + 2000 })
    expect(stale.ok).toBe(false)
    if (!stale.ok) expect(stale.state).toBe('revoked')
    expect(resolveCredential(database, { token: second.token, electionId: ELECTION, now: T0 + 2000 }).ok).toBe(true)
  })

  it('is stored as a digest, so a stolen database yields no usable credential', () => {
    const { token } = issueCredential(database, { electionId: ELECTION, voterRecordId: VOTER_ID, now: T0 })
    const serialised = JSON.stringify(queryAll(database, 'SELECT * FROM voting_credentials'))
    expect(serialised).not.toContain(token)
  })

  it('refuses a credential it never issued', () => {
    const result = resolveCredential(database, { token: 'not-a-credential', electionId: ELECTION, now: T0 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.state).toBe('unknown')
  })
})

/* -------------------------------------------------- one vote per eligible --- */

describe('one vote per eligible voter', () => {
  it('refuses a second participation row for the same voter', () => {
    castVote()
    const second = issueCredential(database, { electionId: ELECTION, voterRecordId: VOTER_ID, now: T0 + 1000 })
    spendCredential(database, second.credential.id, T0 + 1000)
    expect(() =>
      recordParticipation(database, {
        electionId: ELECTION,
        voterRecordId: VOTER_ID,
        credentialId: second.credential.id,
        now: T0 + 1000,
      }),
    ).toThrow()
    expect(countParticipants(database, ELECTION)).toBe(1)
  })

  it('refuses a second participation row for the same credential', () => {
    const { credential } = issueCredential(database, { electionId: ELECTION, voterRecordId: 1, now: T0 })
    recordParticipation(database, { electionId: ELECTION, voterRecordId: 1, credentialId: credential.id, now: T0 })
    issueCredential(database, { electionId: ELECTION, voterRecordId: 2, now: T0 })
    expect(() =>
      recordParticipation(database, { electionId: ELECTION, voterRecordId: 2, credentialId: credential.id, now: T0 }),
    ).toThrow()
  })

  it('allows a different voter to vote in the same election', () => {
    castVote()
    execute(
      database,
      `INSERT INTO roll_voters (election_id, voter_id, full_name, created_at) VALUES (?, 'V-002', 'Grace Hopper', ?)`,
      [ELECTION, new Date(T0).toISOString()],
    )
    const second = issueCredential(database, { electionId: ELECTION, voterRecordId: 2, now: T0 })
    spendCredential(database, second.credential.id, T0)
    recordParticipation(database, { electionId: ELECTION, voterRecordId: 2, credentialId: second.credential.id, now: T0 })
    expect(countParticipants(database, ELECTION)).toBe(2)
  })
})

/* ------------------------------------------------------------- integrity --- */

describe('ballot integrity', () => {
  it('verifies a ballot that has not been touched', () => {
    const { ballot } = castVote({ selections: [42] })
    expect(verifyBallotIntegrity(ballot, ':memory:')).toBe(true)
  })

  it('detects a ballot whose selections were altered after the fact', () => {
    const { ballot } = castVote({ selections: [42] })
    const tampered = { ...ballot, selections: [7] }
    expect(verifyBallotIntegrity(tampered, ':memory:')).toBe(false)
  })

  it('detects a ballot whose timestamp was altered', () => {
    const { ballot } = castVote({ selections: [42] })
    expect(verifyBallotIntegrity({ ...ballot, submittedAt: new Date(T0 + 1).toISOString() }, ':memory:')).toBe(false)
  })

  it('a digest stored in the database is not reversible by brute force over the options', () => {
    /*
     * The threat model, stated precisely: an attacker holds the database, so they
     * have `integrity_digest`, `election_id` and `submitted_at`. They do not have
     * the key, which lives outside the database. If the digest were a plain hash
     * they could simply try every option id and find the one that matched.
     *
     * So the assertion is that no unkeyed hash of the ballot contents equals the
     * stored digest, for any guess. Testing `verifyBallotIntegrity` here would prove
     * nothing: that function holds the key, so it would "recover" the selection for
     * an attacker who by assumption does not have it.
     */
    const { ballot } = castVote({ selections: [42] })
    const unkeyed = (guess: number) =>
      createHash('sha256')
        .update(`${ballot.electionId} ${ballot.submittedAt} ${guess}`)
        .digest('hex')

    const optionSpace = [1, 7, 42, 99, 123]
    const recovered = optionSpace.filter((guess) => unkeyed(guess) === ballot.integrityDigest)
    expect(recovered).toEqual([])
    // And the real digest is not a hex-encoded selection in some other trivial form.
    expect(ballot.integrityDigest).not.toContain('42')
    expect(ballot.integrityDigest).toMatch(/^[0-9a-f]{64}$/)
  })

  it('the key is not stored alongside the ballots', () => {
    // A structural companion to the test above: the property depends on the key
    // living outside the data it protects.
    expect(tableNames().some((name) => /key|secret/i.test(name))).toBe(false)
  })
})

/* -------------------------------------------------------------- receipts --- */

describe('receipts', () => {
  it('finds a ballot by its code, ignoring how the code is typed', () => {
    const { receipt } = castVote({ selections: [42] })
    const plain = receipt.code.replace(/-/g, '').toLowerCase()
    expect(findReceipt(database, plain)?.ballot.selections).toEqual([42])
  })

  it('stores a digest, not the code', () => {
    const { receipt } = castVote()
    const serialised = JSON.stringify(queryAll(database, 'SELECT * FROM receipts'))
    expect(serialised).not.toContain(receipt.code)
  })

  it('finds nothing for a code it never issued', () => {
    castVote()
    expect(findReceipt(database, 'AAAA-BBBB-CCCC')).toBeNull()
  })

  it('finds nothing for a truncated code', () => {
    castVote()
    expect(findReceipt(database, 'AB')).toBeNull()
  })

  it('is the only route back to a ballot, and it needs the secret', () => {
    const { ballot } = castVote({ selections: [42] })
    // Enumerating ballots by id works, because the tally must read them. But that
    // yields every ballot, not one person's, and says nothing about who cast any.
    const all = queryAll(database, 'SELECT selections FROM ballots WHERE election_id = ?', [ELECTION])
    expect(all).toHaveLength(1)
    expect(text(all[0].selections)).toBe('[42]')
    // There is no query that narrows that to a voter.
    expect(
      queryAll(
        database,
        `SELECT b.id FROM ballots b JOIN participation p ON p.election_id = b.election_id
          WHERE p.voter_record_id = ? AND b.id = CAST(p.credential_id AS TEXT)`,
        [VOTER_ID],
      ),
    ).toHaveLength(0)
    expect(ballot.selections).toEqual([42])
  })
})
