/**
 * Writing the demonstration workspace.
 *
 * The fixtures live in `src/lib/seed.ts`; this module is the half of the seed
 * that needs the server. It exists as a separate file for two reasons.
 *
 * First, `src/lib/` is bundled into the browser. The seed needs `node:crypto`,
 * the filesystem and the real ballot/receipt writers, none of which can be
 * imported from a module the browser also loads, so the data and the writing have
 * to be split.
 *
 * Second — and this is the part that matters — every record below is written by
 * the *same* function the application uses at runtime. Ballots go through
 * `recordBallot`, receipts through the same digest rule `issueReceipt` uses,
 * passwords through `hashPassword`. Nothing is hand-written into a table with a
 * plausible-looking value, which means a seeded digest really does verify, a
 * seeded password really does sign in, and a seeded receipt really does resolve.
 * A demo dataset that fakes these would fail at exactly the moment somebody tried
 * to use it.
 *
 * ## Write order, and why it is what it is
 *
 * Elections → options → roll → eligibility → ballots → participation →
 * receipts → administrators → audit → security → sessions → approvals → backups.
 *
 * Ballots and participation are written from *separately generated* data. The
 * ballot generator receives a weighted preference table; the participation
 * generator receives a count. Neither is given the other's input, and the two are
 * produced by different loops over different collections. So there is no
 * correspondence anywhere in this file between "who" and "what", and the seeded
 * database is as unlinkable as one produced by a real poll. Wiring them together
 * to make the demo tidier would have quietly destroyed the one property this
 * product is built around.
 */

import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'

import { createDemoDataset, type DemoAdmin, type DemoBackup, type DemoDataset } from '../lib/seed'
import { hashPassword } from './auth'
import { recordBallot, receiptDigest } from './ballots'
import { execute, lastInsertId, queryOne, queryScalar, type SqlDatabase } from './db'
import { writeSettings } from './settings'
import { hashRecoveryCode } from '../lib/totp'

/** Everything the writer needs from its host. */
export type DemoWriteOptions = {
  database: SqlDatabase
  /** Where `data/database.sqlite` lives — the ballot digest is keyed off it. */
  databasePath: string
  /** `data/backups`, created on demand. */
  backupDirectory: string
  logger?: { warn: (message: string) => void }
}

const HOUR = 3_600_000
const MINUTE = 60_000

function iso(nowMs: number, offsetMs: number): string {
  return new Date(nowMs + offsetMs).toISOString()
}

/**
 * A deterministic generator, seeded from the election id.
 *
 * Two elections must not cast identical ballots, and a reset must reproduce the
 * previous reset exactly, so the seed is derived from the id rather than shared.
 */
function lcg(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 4_294_967_296
  }
}

function seedFrom(text: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/**
 * A receipt code from the generator rather than from the CSPRNG.
 *
 * Real codes come from `createReceiptCode`, which is right for a live poll. Here
 * the point is different: the README quotes example receipt codes so somebody can
 * follow the format without casting a ballot first, and a code that changed on
 * every reset would make that documentation wrong within a day. The codes are
 * still 72 bits drawn from the seeded generator and still stored only as a
 * digest, so nothing about the secrecy arrangement changes — only the source of
 * the randomness does.
 */
const RECEIPT_ALPHABET = '0123456789ABCDEF'

function demoReceiptCode(random: () => number): string {
  let code = ''
  for (let index = 0; index < 12; index += 1) {
    code += RECEIPT_ALPHABET[Math.floor(random() * RECEIPT_ALPHABET.length) % RECEIPT_ALPHABET.length]
  }
  return code.replace(/(.{4})(?=.)/g, '$1-')
}

/** A request id shaped like the ones the server issues, for audit correlation. */
function demoRequestId(random: () => number): string {
  let id = ''
  for (let index = 0; index < 12; index += 1) {
    id += '0123456789abcdefghijklmnopqrstuvwxyz'[Math.floor(random() * 36) % 36]
  }
  return id
}

/* ------------------------------------------------------------------ ballots --- */

type ResolvedOption = { ref: string; id: number; status: string; position: number }

/**
 * Choose `count` selections for one ballot from a weighted preference table.
 *
 * Returns option refs, never ids: ids are assigned by SQLite and are not known
 * yet. When `noisy` is set the winner is demoted about a third of the time and a
 * special option draws a real share, because a results screen showing a clean
 * sweep would not exercise the tie, the "leading" highlight or the runner-up bars.
 */
function chooseSelections(
  random: () => number,
  plan: { count: number; weights: Record<string, number>; noisy?: boolean },
  ballotsWanted: number,
  optionRefs: string[],
): string[][] {
  const refs = optionRefs.filter((ref) => (plan.weights[ref] ?? 0) > 0)
  const totalWeight = refs.reduce((sum, ref) => sum + (plan.weights[ref] ?? 0), 0)
  if (refs.length === 0 || totalWeight <= 0) return []

  // One ballot per voter allowed: the number of selections matches the rule.
  const perBallot = 1
  const ballots: string[][] = []
  for (let index = 0; index < ballotsWanted; index += 1) {
    // Weighted draw without replacement, so a multi-select ballot never repeats an
    // option — the server refuses that, and a seed that produced it would be a
    // ballot the app rejects.
    const pool = [...refs]
    const chosen: string[] = []
    for (let pick = 0; pick < perBallot && pool.length > 0; pick += 1) {
      let roll = random() * totalWeight
      let cursor = pool.length - 1
      for (let index2 = 0; index2 < pool.length; index2 += 1) {
        roll -= plan.weights[pool[index2]] ?? 0
        if (roll <= 0) {
          cursor = index2
          break
        }
      }
      chosen.push(pool[cursor])
      pool.splice(cursor, 1)
    }

    if (plan.noisy) {
      // Demote the winner roughly a third of the time so the result is a contest
      // rather than a formality.
      if (chosen.length > 0 && random() < 0.34 && pool.length > 0) {
        const runnerUp = pool[Math.floor(random() * pool.length) % pool.length]
        chosen[0] = runnerUp
      }
    }
    ballots.push(chosen)
  }
  return ballots
}

/**
 * Which roll members are recorded as having voted.
 *
 * Chosen as a subset of the *eligible* members, in the generator's order and
 * without consulting `ballots`, so participation and selections stay independent.
 */
function chooseParticipants(random: () => number, eligibleIds: number[], count: number): number[] {
  const pool = [...eligibleIds]
  const picked: number[] = []
  const wanted = Math.min(count, pool.length)
  for (let index = 0; index < wanted; index += 1) {
    const cursor = Math.floor(random() * pool.length) % pool.length
    picked.push(pool[cursor])
    pool.splice(cursor, 1)
  }
  return picked
}

/* ------------------------------------------------------------------ writing --- */

/**
 * Write the whole workspace. Assumes it is inside a transaction.
 *
 * Returns the number of ballots written, so the caller can log a single honest
 * line about what it did rather than a paragraph of reassurance.
 *
 * Deliberately does *not* write archive files. `sql.js`'s `export()` opens and
 * commits a transaction of its own to take a consistent snapshot, so calling it
 * from inside this one commits the seed early and silently discards every row
 * written since. The archive step therefore runs afterwards, in
 * `writeDemoArchives`, once the transaction is safely closed.
 */
export function writeDemoDataset(options: DemoWriteOptions): { ballots: number; elections: number } {
  const { database, databasePath } = options
  const data: DemoDataset = createDemoDataset(Date.now())
  const now = data.nowMs

  let ballotsWritten = 0

  /* ---- elections, options, roll, eligibility ---- */
  const insertElection = database.prepare(
    `INSERT INTO elections (id, title, description, election_type, timezone, starts_at, ends_at,
      status, rules, eligibility, ever_opened, created_at, updated_at, published_at,
      closed_at, certified_at, archived_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const insertOption = database.prepare(
    `INSERT INTO candidates (election_id, name, organization, abbreviation, description,
      image_url, symbol, position, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const insertVoter = database.prepare(
    `INSERT INTO roll_voters (election_id, voter_id, full_name, phone, email, external_ref, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
  const insertEligibility = database.prepare(
    `INSERT INTO eligibility (election_id, voter_record_id, status, reason, decided_at, decided_by)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
  const insertBallot = database.prepare(
    `INSERT INTO ballots (id, election_id, selections, selection_count, submitted_at, integrity_digest)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
  const insertParticipation = database.prepare(
    `INSERT INTO participation (election_id, voter_record_id, credential_id, participated_at)
     VALUES (?, ?, ?, ?)`,
  )
  const insertReceipt = database.prepare(
    'INSERT INTO receipts (code_hash, election_id, ballot_id, issued_at) VALUES (?, ?, ?, ?)',
  )

  try {
    for (const election of data.elections) {
      const created = iso(now, -14 * 24 * HOUR)
      const resolved: ResolvedOption[] = []

      insertElection.run([
        election.id,
        election.title,
        election.description,
        election.election_type,
        election.timezone,
        iso(now, election.startsInMs),
        iso(now, election.endsInMs),
        election.status,
        JSON.stringify(election.rules),
        JSON.stringify(election.eligibility),
        election.ever_opened,
        created,
        iso(now, 0),
        election.publishedInMs === null ? null : iso(now, election.publishedInMs),
        election.status === 'closed' || election.status === 'certified' || election.status === 'archived'
          ? iso(now, election.endsInMs)
          : null,
        election.certifiedInMs ? iso(now, election.certifiedInMs) : null,
        election.archivedInMs ? iso(now, election.archivedInMs) : null,
      ])

      for (const option of election.options) {
        insertOption.run([
          election.id,
          option.name,
          option.organization,
          option.abbreviation,
          option.description,
          option.image_url,
          option.symbol,
          option.position,
          option.status,
          created,
          iso(now, 0),
        ])
        // Option ids come back in insertion order, so the mapping from a seed ref
        // to a real id is recorded here rather than looked up later.
        resolved.push({
          ref: option.ref,
          id: lastInsertId(database),
          status: option.status,
          position: option.position,
        })
      }

      const eligibleRecordIds: number[] = []
      for (const voter of election.voters) {
        insertVoter.run([
          election.id,
          voter.voter_id,
          voter.full_name,
          voter.phone,
          voter.email,
          voter.external_ref,
          created,
        ])
        const recordId = lastInsertId(database)
        insertEligibility.run([
          election.id,
          recordId,
          voter.is_eligible ? 'eligible' : 'ineligible',
          voter.eligibility_reason ?? '',
          created,
          'demo-seed',
        ])
        if (voter.is_eligible) eligibleRecordIds.push(recordId)
      }

      if (!election.ballots) continue

      const random = lcg(seedFrom(election.id))
      const rule = election.rules
      // Only approved options can appear on a ballot. A withdrawn or disqualified
      // option keeps its row and its history; it simply is not something a voter
      // could have chosen, and seeding a vote for one would be a ballot the
      // server refuses.
      const selectable = resolved.filter((option) => option.status === 'approved')
      const refs = [
        ...selectable.map((option) => option.ref),
        ...(rule.allowNotA ? ['NOTA'] : []),
        ...(rule.allowAbstain ? ['ABSTAIN'] : []),
      ]
      const idFor = new Map(resolved.map((option) => [option.ref, option.id]))
      const specialId = (ref: string): number => (ref === 'NOTA' ? -1 : -2)

      const ballots = chooseSelections(random, election.ballots, election.ballots.count, refs)
      // Spread submissions across the window so the turnout-over-time chart in the
      // workspace has a shape. Never outside the election's own window, so a
      // ballot is never timestamped when the poll could not have been open.
      const spanStart = Math.max(election.startsInMs, -14 * 24 * HOUR)
      const spanEnd = Math.min(election.endsInMs, 0)
      const span = Math.max(spanEnd - spanStart, MINUTE)

      const ballotIds: string[] = []
      ballots.forEach((refs2, index) => {
        const selections = refs2
          .map((ref) => (idFor.has(ref) ? (idFor.get(ref) as number) : specialId(ref)))
          .filter((id) => Number.isInteger(id))
        if (selections.length === 0) return
        // Deterministic-but-varied position across the window.
        const at = spanStart + Math.floor(random() * span)
        const ballot = recordBallot(database, {
          electionId: election.id,
          selections,
          now: now + at,
          databasePath,
        })
        ballotsWritten += 1
        ballotIds.push(ballot.id)
        index + 1
      })

      // Participation, generated independently of the ballots above.
      const participants = chooseParticipants(random, eligibleRecordIds, ballots.length)
      for (const recordId of participants) {
        insertParticipation.run([
          election.id,
          recordId,
          null,
          iso(now, Math.max(election.startsInMs, -14 * 24 * HOUR) + Math.floor(random() * span)),
        ])
      }

      // One receipt per ballot, so the receipts table is as large as the ballots
      // table and "a receipt proves a ballot was counted" is visible in the data.
      for (const ballotId of ballotIds) {
        insertReceipt.run([receiptDigest(demoReceiptCode(random)), election.id, ballotId, iso(now, 0)])
      }
    }
  } finally {
    // Every statement prepared above is released here, whatever happened. The
    // ballots/participation/receipts statements are freed per election because
    // they are re-prepared for each one; these four are prepared once.
    for (const statement of [
      insertElection,
      insertOption,
      insertVoter,
      insertEligibility,
      insertBallot,
      insertParticipation,
      insertReceipt,
    ]) {
      try {
        statement.free()
      } catch {
        /* already freed */
      }
    }
  }

  writeAdmins(database, data, now)
  writeAuditEvents(database, data, now)
  writeSecurityEvents(database, data, now)
  writeSessions(database, data, now)
  writeApprovals(database, data, now)
  writeSettings(database, data.settings)

  return { ballots: ballotsWritten, elections: data.elections.length }
}

/**
 * Write the archive records and the files behind them.
 *
 * Must run **outside** the seed transaction, because `Database.export()` issues
 * its own `BEGIN`/`COMMIT` for a consistent snapshot.
 *
 * Each record is written together with a real file containing a real export, and
 * the recorded checksum is the checksum of those bytes. That pairing matters more
 * than it looks: `BackupService.list()` deletes any row whose file has gone
 * missing — correct behaviour for a directory a user might tidy by hand — so a
 * row seeded without a file would be silently deleted the first time somebody
 * opened the Backups screen, leaving an empty table and no sign that anything had
 * been seeded. Writing the files is also what makes the archives restorable and
 * verifiable, so "restore" is a real workflow in the demo rather than a button
 * that always fails.
 */
export function writeDemoArchives(options: DemoWriteOptions): number {
  const { database, backupDirectory } = options
  const data = createDemoDataset(Date.now())
  return writeBackups(database, data, backupDirectory)
}

/* ------------------------------------------------------------------- admins --- */

/** Usernames to row ids, so audit, security and approval rows can name a person. */
function writeAdmins(database: SqlDatabase, data: DemoDataset, now: number): void {
  for (const admin of data.admins) {
    insertAdminRow(database, admin, now)
  }
}

function insertAdminRow(database: SqlDatabase, admin: DemoAdmin, now: number): void {
  execute(
    database,
    `INSERT INTO admins (username, display_name, password_hash, role, mfa_secret, mfa_enabled,
      mfa_recovery_hashes, mfa_recovery_salt, failed_attempts, locked_until, last_failed_at,
      last_login_ip, must_change_password, disabled, created_at, last_login_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      admin.username.toLowerCase(),
      admin.display_name,
      hashPassword(admin.password),
      admin.role,
      // A fixed secret so the second factor can also be exercised with an
      // authenticator app; the recovery codes below are the frictionless path.
      admin.mfa ? 'JBSWY3DPEHPK3PXP' : null,
      admin.mfa ? 1 : 0,
      '[]',
      admin.mfa ? admin.recoverySalt : null,
      // A locked account needs both the attempt count and the lock expiry, or it
      // is simply an account that has not tried to sign in.
      admin.lockedForMinutes ? 6 : 0,
      admin.lockedForMinutes ? new Date(now + admin.lockedForMinutes * MINUTE).toISOString() : null,
      admin.lockedForMinutes ? new Date(now - 40 * MINUTE).toISOString() : null,
      '127.0.0.1',
      admin.mustChangePassword ? 1 : 0,
      admin.disabled ? 1 : 0,
      new Date(now - 30 * 24 * HOUR).toISOString(),
      admin.lastSignedInMinutesAgo === undefined
        ? null
        : new Date(now - admin.lastSignedInMinutesAgo * MINUTE).toISOString(),
    ],
  )
  const adminId = lastInsertId(database)

  if (admin.mfa) {
    for (const code of admin.recoveryCodes) {
      execute(
        database,
        'INSERT INTO recovery_codes (admin_id, code_hash, created_at) VALUES (?, ?, ?)',
        [adminId, hashRecoveryCode(code, admin.recoverySalt), new Date(now - 30 * 24 * HOUR).toISOString()],
      )
    }
  }
}

/** Map `username` to the row id, for rows that reference a person. */
function adminIdFor(database: SqlDatabase, username: string): number | null {
  const row = queryOne(database, 'SELECT id FROM admins WHERE username = ?', [username.toLowerCase()])
  return row ? Number(row.id) : null
}

/* -------------------------------------------------------------- audit trail --- */

const ADMIN_LABELS: Record<string, string> = {
  'hana.wexford': 'Hana Wexford',
  'leo.marchetti': 'Leo Marchetti',
  'iris.nakamura': 'Iris Nakamura',
  'gary.whitlock': 'Gary Whitlock',
  'mira.chatterjee': 'Mira Chatterjee',
  'tomas.velasco': 'Tomás Velasco',
  'dana.kovacs': 'Dana Kovács',
}

function writeAuditEvents(database: SqlDatabase, data: DemoDataset, now: number): void {
  const random = lcg(seedFrom('audit'))
  for (const event of data.auditEvents) {
    const isAdmin = event.actorType === 'admin'
    const adminId = isAdmin ? adminIdFor(database, event.actorRef) : null
    const label = isAdmin
      ? (ADMIN_LABELS[event.actorRef] ?? event.actorRef)
      : event.actorType === 'system'
        ? 'System'
        : event.actorRef
    execute(
      database,
      `INSERT INTO audit_events (request_id, election_id, actor_type, actor_id, actor_label, actor_role,
        action, resource, result, from_status, to_status, summary, detail, ip, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        demoRequestId(random),
        event.electionId ?? null,
        event.actorType,
        adminId,
        label,
        isAdmin ? roleOf(database, adminId) : event.actorType === 'system' ? 'system' : null,
        event.action,
        event.resource,
        event.result,
        event.fromStatus ?? null,
        event.toStatus ?? null,
        event.summary,
        JSON.stringify(event.detail ?? {}),
        event.ip ?? '127.0.0.1',
        new Date(now - event.minutesAgo * MINUTE).toISOString(),
      ],
    )
  }
}

function roleOf(database: SqlDatabase, adminId: number | null): string | null {
  if (adminId === null) return null
  const row = queryOne(database, 'SELECT role FROM admins WHERE id = ?', [adminId])
  return row && typeof row.role === 'string' ? row.role : null
}

/* ---------------------------------------------------------- security events --- */

function writeSecurityEvents(database: SqlDatabase, data: DemoDataset, now: number): void {
  const random = lcg(seedFrom('security'))
  for (const event of data.securityEvents) {
    const adminId = event.adminRef ? adminIdFor(database, event.adminRef) : null
    const at = new Date(now - event.minutesAgo * MINUTE)
    const acknowledgedAt = event.acknowledgedMinutesAgo
    const acknowledged = acknowledgedAt !== undefined
    execute(
      database,
      `INSERT INTO security_events (request_id, kind, severity, admin_id, admin_label,
        summary, detail, ip, acknowledged, acknowledged_by, acknowledged_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        demoRequestId(random),
        event.kind,
        event.severity,
        adminId,
        event.adminRef ? (ADMIN_LABELS[event.adminRef] ?? event.adminRef) : '',
        event.summary,
        JSON.stringify(event.detail ?? {}),
        event.ip ?? '127.0.0.1',
        acknowledged ? 1 : 0,
        acknowledged ? adminId : null,
        acknowledged ? new Date(now - acknowledgedAt * MINUTE).toISOString() : null,
        at.toISOString(),
      ],
    )
  }
}

/* ----------------------------------------------------------------- sessions --- */

/**
 * Seed closed administrator sessions only.
 *
 * The token digest is random and unrecoverable, so none of these rows can be
 * turned into a working session: they exist to give the Sessions tab its expired
 * and revoked states, not to pre-authenticate anybody. A live row is never
 * written here, because a repository that shipped usable console tokens would be
 * a repository that shipped console access.
 */
function writeSessions(database: SqlDatabase, data: DemoDataset, now: number): void {
  for (const session of data.sessions) {
    const adminId = adminIdFor(database, session.adminRef)
    if (adminId === null) continue
    const revokedAt = session.revokedAfterMinutes
      ? new Date(now + session.startedInMs + session.revokedAfterMinutes * MINUTE).toISOString()
      : null
    /*
     * The expiry is in the future, and that is load-bearing rather than cosmetic.
     * `purgeExpiredSessions()` runs on every sign-in and deletes every session
     * whose `expires_at` has passed, so an archive of *expired* sessions would be
     * swept away the first time anybody signed in and the Sessions tab would be
     * empty again. A revoked session that has not yet reached its expiry is the
     * state this table can actually hold, and it is the one worth showing: it is
     * what "this account was signed out" looks like.
     */
    const expiresAt = new Date(now + 6 * HOUR).toISOString()
    execute(
      database,
      `INSERT INTO admin_sessions (token_hash, token, admin_id, created_at, expires_at,
        mfa_verified_at, reauth_verified_at, last_seen_at, ip, user_agent, revoked_at, revoked_reason)
       VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        createHash('sha256').update(randomBytes(32)).digest('hex'),
        adminId,
        new Date(now + session.startedInMs).toISOString(),
        expiresAt,
        session.mfaVerified ? new Date(now + session.startedInMs + 1000).toISOString() : null,
        null,
        new Date(now + session.lastSeenInMs).toISOString(),
        session.ip,
        session.userAgent,
        revokedAt,
        session.revokedReason ?? null,
      ],
    )
  }
}

/* --------------------------------------------------------------- approvals --- */

function writeApprovals(database: SqlDatabase, data: DemoDataset, now: number): void {
  const random = lcg(seedFrom('approvals'))
  for (const approval of data.approvals) {
    const requestedBy = adminIdFor(database, approval.requestedBy)
    if (requestedBy === null) continue
    const decidedBy = approval.decidedBy ? adminIdFor(database, approval.decidedBy) : null
    const requestedAt = new Date(now - approval.minutesAgo * MINUTE)
    const decidedAt =
      approval.status === 'pending' ? null : new Date(now - (approval.minutesAgo - 4) * MINUTE)
    execute(
      database,
      `INSERT INTO approvals (token, request_id, permission, action, resource, election_id,
        payload, payload_summary, justification, status, requested_by, requested_at,
        expires_at, decided_by, decided_at, decision_note, executed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        randomBytes(12).toString('hex'),
        demoRequestId(random),
        approval.permission,
        approval.action,
        approval.resource,
        approval.electionId ?? null,
        JSON.stringify({ seeded: true }),
        approval.payloadSummary,
        approval.justification,
        approval.status,
        requestedBy,
        requestedAt.toISOString(),
        // Pending requests must still be live, or the Approvals tab shows an
        // expired row where the interesting one should be.
        new Date(requestedAt.getTime() + 30 * MINUTE).toISOString(),
        decidedBy,
        decidedAt ? decidedAt.toISOString() : null,
        approval.decisionNote ?? '',
        approval.executedMinutesAgo
          ? new Date(now - approval.executedMinutesAgo * MINUTE).toISOString()
          : null,
      ],
    )
  }
}

/* ----------------------------------------------------------------- backups --- */

/**
 * Seed archive records *and* the files they point at.
 *
 * The `election_count` and `vote_count` on each row are measured rather than
 * stated, because these files are a real export of the seeded workspace: a row
 * claiming a different tally from the file it points at would be a lie that the
 * restore path could disprove.
 */
function writeBackups(database: SqlDatabase, data: DemoDataset, backupDirectory: string): number {
  try {
    fs.mkdirSync(backupDirectory, { recursive: true, mode: 0o700 })
  } catch (error) {
    return 0
  }

  // One export, reused for every archive. Taken outside any transaction.
  const bytes = Buffer.from(database.export())
  let written = 0
  for (const backup of data.backups) {
    if (writeBackupRow(database, backup, data.nowMs, backupDirectory, bytes)) written += 1
  }
  return written
}

function writeBackupRow(
  database: SqlDatabase,
  backup: DemoBackup,
  now: number,
  backupDirectory: string,
  bytes: Buffer,
): boolean {
  const takenAt = new Date(now + backup.takenInMs)
  const stamp = takenAt.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
  const filename = `backup-${stamp}-${slug(backup.label)}.sqlite`
  const target = path.join(backupDirectory, filename)

  // Idempotence. An archive filename carries the instant it was taken, so a second
  // run a second later would otherwise produce a *different* filename for the same
  // label and write a second file rather than reusing the first. The seed only
  // runs against an empty database, but a development server restart mid-seed
  // reaches this code again, and "every restart adds six archives" is the kind of
  // thing that quietly fills a disk. One row per label is the contract.
  const existing = queryOne(database, 'SELECT id FROM backups WHERE label = ?', [backup.label])
  if (existing) return false

  try {
    if (!fs.existsSync(target)) fs.writeFileSync(target, bytes, { mode: 0o600 })
  } catch {
    // A directory that cannot be written to is survivable: the row is skipped so
    // the Backups screen never lists an archive it cannot actually restore.
    return false
  }

  const elections = queryScalar(database, 'SELECT COUNT(*) AS total FROM elections')
  const votes = queryScalar(database, 'SELECT COUNT(*) AS total FROM ballots')
  const admins = queryScalar(database, 'SELECT COUNT(*) AS total FROM admins')

  execute(
    database,
    `INSERT INTO backups (label, filename, size_bytes, checksum, kind, note,
      election_count, vote_count, admin_count, created_by, created_by_label, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      backup.label,
      filename,
      bytes.length,
      createHash('sha256').update(bytes).digest('hex'),
      backup.kind,
      backup.note,
      elections,
      votes,
      admins,
      backup.createdBy && backup.createdBy !== 'system' ? adminIdFor(database, backup.createdBy) : null,
      backup.createdBy === 'system' ? 'System' : (ADMIN_LABELS[backup.createdBy ?? ''] ?? ''),
      takenAt.toISOString(),
    ],
  )
  return true
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'manual'
  )
}