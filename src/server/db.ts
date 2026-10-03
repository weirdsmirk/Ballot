/**
 * SQLite persistence layer for the election platform.
 *
 * The database lives at `data/database.sqlite`, is created on first use, and is
 * never committed to Git. Writes are serialised through a single promise chain
 * and flushed atomically (write temp file, fsync, rename) so a crash can never
 * leave a half-written database behind.
 */

import fs from 'node:fs'
import path from 'node:path'
import { MIGRATION_STEPS } from './migrations'
import { writeDemoArchives, writeDemoDataset } from './demoData'

export type SqlRow = Record<string, unknown>

export type SqlStatement = {
  run(values?: unknown[]): void
  bind(values?: unknown[]): void
  step(): boolean
  get(): unknown[]
  getAsObject(): SqlRow
  free(): void
}

export type SqlDatabase = {
  run(sql: string, values?: unknown[]): void
  exec(sql: string): { columns: string[]; values: unknown[][] }[]
  prepare(sql: string): SqlStatement
  export(): Uint8Array
  close(): void
}

export type SqlStatic = {
  Database: new (data?: Uint8Array) => SqlDatabase
}

export class StaleRevisionError extends Error {
  constructor(readonly current: number) {
    super('Database revision conflict')
  }
}

export const SCHEMA_VERSION = 7

const MAX_DATABASE_BYTES = 64 * 1024 * 1024

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS app_state (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
INSERT OR IGNORE INTO app_state (key, value) VALUES ('revision', 0);

CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'election_officer',
  mfa_secret TEXT,
  mfa_enabled INTEGER NOT NULL DEFAULT 0,
  mfa_recovery_hashes TEXT NOT NULL DEFAULT '[]',
  mfa_recovery_salt TEXT,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  last_failed_at TEXT,
  last_login_ip TEXT,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  last_login_at TEXT
);

-- Administrator sessions.
--
-- The credential is not here. token_hash is a SHA-256 of the token that lives in
-- the administrator's HttpOnly cookie, so a stolen database cannot be replayed as
-- a set of live console sessions. token is a legacy column kept only so an
-- upgraded database can be rehashed; it is blanked during the upgrade and never
-- written again.
CREATE TABLE IF NOT EXISTS admin_sessions (
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
CREATE INDEX IF NOT EXISTS admin_sessions_admin ON admin_sessions (admin_id);
CREATE INDEX IF NOT EXISTS admin_sessions_admin ON admin_sessions (admin_id);

CREATE TABLE IF NOT EXISTS elections (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  election_type TEXT NOT NULL DEFAULT 'general',
  timezone TEXT NOT NULL DEFAULT 'UTC',
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  rules TEXT NOT NULL DEFAULT '{}',
  eligibility TEXT NOT NULL DEFAULT '{}',
  ever_opened INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  published_at TEXT,
  published_by INTEGER,
  closed_at TEXT,
  closed_by INTEGER,
  certified_at TEXT,
  certified_by INTEGER,
  archived_at TEXT,
  archived_by INTEGER
);
CREATE INDEX IF NOT EXISTS elections_status ON elections (status);

CREATE TABLE IF NOT EXISTS candidates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  election_id TEXT NOT NULL,
  name TEXT NOT NULL,
  organization TEXT NOT NULL DEFAULT '',
  abbreviation TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  image_url TEXT NOT NULL DEFAULT '',
  symbol TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'approved',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS candidates_election ON candidates (election_id, position);

-- =============================================================================
-- Identity, eligibility, credentials, ballots, receipts.
--
-- These are five separate ideas and are kept in five separate tables on purpose.
-- The earlier schema kept one row per selection in a votes table carrying both
-- voter_record_id and candidate_id, which made "who voted for whom" a single
-- join away for anybody who could read the database. The tables below are laid
-- out so that no such join exists, at any depth:
--
--   roll_voters        who somebody is            (identity)
--   eligibility        whether they may vote      (eligibility)
--   voter_sessions     that they proved it        (authentication)
--   voting_credentials a single-use right to vote  (credential)
--   participation      that they have voted       (participation)
--   ballots            what was chosen            (ballot)
--   receipts           proof a ballot was counted (receipt)
--
-- ballots holds no voter column and no credential column. participation
-- holds no selections. Neither references the other. There is therefore no
-- column anywhere that could be joined to turn a person into a choice, and the
-- separation is a property of the schema rather than of a query filter that a
-- future change could forget.
-- =============================================================================

-- Identity only. Note what is absent: there is no eligibility flag and no
-- voting state. Both moved to tables of their own, so a roll record can be read
-- without also learning whether the person voted.
CREATE TABLE IF NOT EXISTS roll_voters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  election_id TEXT NOT NULL,
  voter_id TEXT NOT NULL,
  full_name TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  external_ref TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE (election_id, voter_id)
);
CREATE INDEX IF NOT EXISTS roll_voters_election ON roll_voters (election_id);

-- Eligibility, as a decision with a reason and a timestamp rather than a mutable
-- flag on the roll. Keeping it separate means "who may vote" can be audited and
-- changed without touching who somebody is.
CREATE TABLE IF NOT EXISTS eligibility (
  election_id TEXT NOT NULL,
  voter_record_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'eligible',
  reason TEXT NOT NULL DEFAULT '',
  decided_at TEXT NOT NULL,
  decided_by TEXT,
  PRIMARY KEY (election_id, voter_record_id)
);

-- Anonymous ballots.
--
-- selections is a JSON array of option ids. It is deliberately *not* one row
-- per selection: a per-selection row would be a candidate id sitting in a table,
-- and any table holding candidate ids is a table that invites the join this
-- schema exists to prevent. As a single opaque column it is only ever read as a
-- whole, by code that is counting.
--
-- integrity_digest is a keyed HMAC over the contents (see ballots.ts). It is
-- keyed rather than a plain hash on purpose: a selection is a small integer from
-- a known set, so an unkeyed digest over it could be brute-forced by anybody
-- holding the database, which would undo the whole arrangement.
--
-- There is no voter column here, and none may be added.
--
-- The primary key is a random value rather than a sequence, and that is not
-- cosmetic. With an autoincrement on both this table and participation, the
-- first ballot and the first participation row both get id 1, the second both get
-- 2, and so on, so joining one id to the other pairs every voter with a ballot
-- without any column ever being joined on purpose. A random key removes both that
-- coincidence and the ordering, so the sequence in which ballots were cast is not
-- itself a record of anything.
CREATE TABLE IF NOT EXISTS ballots (
  id TEXT PRIMARY KEY,
  election_id TEXT NOT NULL,
  selections TEXT NOT NULL,
  selection_count INTEGER NOT NULL,
  submitted_at TEXT NOT NULL,
  integrity_digest TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ballots_election ON ballots (election_id);

-- Participation, which records *that* somebody voted and never *what* they chose.
-- The unique constraint is the one-vote-per-voter rule, enforced by the database
-- rather than by a check that a race could defeat.
-- credential_id is nullable on purpose. A row carried over from the old schema has
-- no credential, because the old schema had no credentials to carry; several such
-- rows may coexist, and SQLite treats NULLs as distinct in a unique index, so the
-- one-credential-one-vote guarantee still holds for every row that has one.
CREATE TABLE IF NOT EXISTS participation (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  election_id TEXT NOT NULL,
  voter_record_id INTEGER NOT NULL,
  credential_id INTEGER,
  participated_at TEXT NOT NULL,
  UNIQUE (election_id, voter_record_id),
  UNIQUE (election_id, credential_id)
);
CREATE INDEX IF NOT EXISTS participation_voter ON participation (election_id, voter_record_id);

-- Voting credentials: a short-lived, single-use right to cast one ballot in one
-- election, issued only after authentication. It links a person to the fact that
-- they were given a credential, and to nothing about any ballot.
--
-- The raw credential is never stored; only its digest. It lives in an HttpOnly
-- cookie, so the ballot subsystem can consume it without the page ever holding it.
CREATE TABLE IF NOT EXISTS voting_credentials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  credential_hash TEXT NOT NULL UNIQUE,
  election_id TEXT NOT NULL,
  voter_record_id INTEGER NOT NULL,
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  spent_at TEXT,
  revoked_at TEXT,
  revoked_reason TEXT
);
CREATE INDEX IF NOT EXISTS voting_credentials_voter
  ON voting_credentials (election_id, voter_record_id);

-- Receipts: proof that a ballot was recorded as cast. Points at a ballot, never at
-- a voter, so possessing a receipt proves nothing about who cast it to anyone who
-- does not already know the voter's selections.
--
-- code_hash rather than the code itself, for the same reason sessions store a
-- digest: a stolen database should not be a list of receipts somebody could quote.
-- ballot_id deliberately points at a ballot: that is what makes a receipt a
-- receipt. It is safe precisely because the receipt is a secret the voter holds and
-- because no receipt row carries a voter.
CREATE TABLE IF NOT EXISTS receipts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code_hash TEXT NOT NULL UNIQUE,
  election_id TEXT NOT NULL,
  ballot_id TEXT NOT NULL,
  issued_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS receipts_ballot ON receipts (ballot_id);

CREATE TABLE IF NOT EXISTS voter_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT NOT NULL UNIQUE,
  election_id TEXT NOT NULL,
  voter_record_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT,
  revoked_at TEXT,
  revoked_reason TEXT
);
CREATE INDEX IF NOT EXISTS voter_sessions_election ON voter_sessions (election_id);
CREATE INDEX IF NOT EXISTS voter_sessions_voter ON voter_sessions (election_id, voter_record_id);

-- Server-generated, single-use verification challenges.
--
-- The code is never stored: code_hash is an HMAC over a per-challenge random
-- salt, and the plaintext exists only long enough to be delivered. Every column
-- after code_hash is there so a single row answers "is this still usable, and how
-- many guesses has it already cost".
CREATE TABLE IF NOT EXISTS voter_challenges (
  id TEXT PRIMARY KEY,
  election_id TEXT NOT NULL,
  voter_record_id INTEGER NOT NULL,
  channel TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  locked_until TEXT
);
CREATE INDEX IF NOT EXISTS voter_challenges_voter ON voter_challenges (election_id, voter_record_id, channel);

CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL DEFAULT '',
  election_id TEXT,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  actor_label TEXT NOT NULL DEFAULT '',
  actor_role TEXT,
  action TEXT NOT NULL,
  resource TEXT NOT NULL DEFAULT '',
  result TEXT NOT NULL DEFAULT 'success',
  from_status TEXT,
  to_status TEXT,
  summary TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '{}',
  ip TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_events_election ON audit_events (election_id, id);
CREATE INDEX IF NOT EXISTS audit_events_result ON audit_events (result, id);
CREATE INDEX IF NOT EXISTS audit_events_actor ON audit_events (actor_id, id);

CREATE TABLE IF NOT EXISTS security_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info',
  admin_id INTEGER,
  admin_label TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}',
  ip TEXT,
  acknowledged INTEGER NOT NULL DEFAULT 0,
  acknowledged_by INTEGER,
  acknowledged_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS security_events_created ON security_events (created_at);
CREATE INDEX IF NOT EXISTS security_events_kind ON security_events (kind, id);

CREATE TABLE IF NOT EXISTS backups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL,
  filename TEXT NOT NULL,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  checksum TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'manual',
  note TEXT NOT NULL DEFAULT '',
  election_count INTEGER NOT NULL DEFAULT 0,
  vote_count INTEGER NOT NULL DEFAULT 0,
  admin_count INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER,
  created_by_label TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS backups_created ON backups (created_at);

CREATE TABLE IF NOT EXISTS approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL UNIQUE,
  request_id TEXT NOT NULL DEFAULT '',
  permission TEXT NOT NULL,
  action TEXT NOT NULL,
  resource TEXT NOT NULL DEFAULT '',
  election_id TEXT,
  payload TEXT NOT NULL DEFAULT '{}',
  payload_summary TEXT NOT NULL DEFAULT '',
  justification TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  requested_by INTEGER NOT NULL,
  requested_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  decided_by INTEGER,
  decided_at TEXT,
  decision_note TEXT NOT NULL DEFAULT '',
  executed_at TEXT
);
CREATE INDEX IF NOT EXISTS approvals_status ON approvals (status, id);

CREATE TABLE IF NOT EXISTS recovery_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id INTEGER NOT NULL,
  code_hash TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS recovery_codes_admin ON recovery_codes (admin_id);
`

type StoreOptions = {
  dataDirectory: string
  wasmPath: string
  logger?: { warn: (message: string) => void }
}

export class Store {
  private readonly dataDirectory: string
  private readonly databasePath: string
  private readonly legacyDatabasePath: string
  private readonly wasmPath: string
  private readonly logger: { warn: (message: string) => void }
  private sqlPromise: Promise<SqlStatic> | null = null
  private writeChain: Promise<unknown> = Promise.resolve()
  private openPromise: Promise<SqlDatabase> | null = null

  constructor(options: StoreOptions) {
    this.dataDirectory = options.dataDirectory
    this.databasePath = path.join(options.dataDirectory, 'database.sqlite')
    this.legacyDatabasePath = path.resolve(path.dirname(options.dataDirectory), 'database.sqlite')
    this.wasmPath = options.wasmPath
    this.logger = options.logger ?? { warn: () => {} }
  }

  get filePath(): string {
    return this.databasePath
  }

  private getSql(): Promise<SqlStatic> {
    if (!this.sqlPromise) {
      this.sqlPromise = import('sql.js')
        .then((module) => (module.default as unknown as (config: { locateFile: () => string }) => Promise<SqlStatic>)({
          locateFile: () => this.wasmPath,
        }))
        .catch((error: unknown) => {
          this.sqlPromise = null
          throw error
        })
    }
    return this.sqlPromise
  }

  /**
   * Create anything missing.
   *
   * Deliberately does **not** stamp `user_version`. The version is what
   * `migrateIfNeeded` reads to decide whether an upgrade is needed, so writing it
   * here would mark an old database as current before it had been migrated — and
   * every migration below would then be skipped forever. Ordering matters: create
   * first, migrate second, stamp last.
   */
  private initializeSchema(database: SqlDatabase): void {
    database.run('PRAGMA foreign_keys = ON;')
    database.run(SCHEMA_SQL)
    this.upgradeColumns(database)
  }

  private async build(): Promise<SqlDatabase> {
    const SQL = await this.getSql()
    fs.mkdirSync(this.dataDirectory, { recursive: true })
    if (!fs.existsSync(this.databasePath) && fs.existsSync(this.legacyDatabasePath)) {
      fs.copyFileSync(this.legacyDatabasePath, this.databasePath)
    }

    const existed = fs.existsSync(this.databasePath)
    let database: SqlDatabase
    try {
      if (existed) {
        const stat = fs.statSync(this.databasePath)
        if (stat.size > MAX_DATABASE_BYTES) throw new Error('Database file is too large')
        database = new SQL.Database(fs.readFileSync(this.databasePath))
      } else {
        database = new SQL.Database()
      }
      this.initializeSchema(database)
      this.migrateIfNeeded(database)
      if (isDatabaseEmpty(database)) this.seed(database)
      return database
    } catch (error) {
      if (!existed) throw error
      const quarantinePath = path.resolve(
        path.dirname(this.databasePath),
        `database.sqlite.corrupt.${Date.now()}`,
      )
      fs.renameSync(this.databasePath, quarantinePath)
      this.logger.warn(`[election-store] unreadable database moved to ${quarantinePath}`)
      database = new SQL.Database()
      this.initializeSchema(database)
      this.seed(database)
      return database
    }
  }

  /**
   * Drop tables left over from the pre-platform schema.
   *
   * The election platform introduces election-scoped tables that the old
   * single-election schema cannot populate, and the old data is demo content,
   * so an incompatible database is rebuilt rather than migrated.
   */
  private migrateIfNeeded(database: SqlDatabase): void {
    const version = database.exec('PRAGMA user_version')[0]?.values[0]?.[0]
    if (typeof version === 'number' && version >= SCHEMA_VERSION) return

    /*
     * The pre-platform rebuild is for a database with *no* schema version at all.
     *
     * It used to be detected by the presence of tables named `candidates` or
     * `votes`, which is wrong now that the current schema has tables of exactly
     * those names: every real database looked like legacy, and upgrading one would
     * have silently thrown away its elections and reseeded demo content instead of
     * migrating it. An unversioned database is the only reliable signal, because
     * every schema this platform has ever written stamps a version.
     */
    const tables = new Set(
      (database.exec("SELECT name FROM sqlite_master WHERE type = 'table'")?.[0]?.values ?? []).map(
        (row) => String(row[0]),
      ),
    )
    const isUnversioned = !(typeof version === 'number' && version > 0)
    // A database with no version and none of the platform's own tables is genuinely
    // from before the platform existed.
    const prePlatformTables = ['voters', 'users']
    const hasPrePlatform = prePlatformTables.some((table) => tables.has(table))
    const looksLikePlatform = tables.has('elections') || tables.has('roll_voters') || tables.has('audit_events')

    if (isUnversioned && hasPrePlatform && !looksLikePlatform) {
      this.logger.warn('[election-store] rebuilding pre-platform single-election schema')
      database.run('PRAGMA foreign_keys = OFF;')
      for (const table of ['votes', 'users', 'voters', 'candidates']) {
        if (tables.has(table)) database.run(`DROP TABLE IF EXISTS ${table}`)
      }
      database.run(`DELETE FROM sqlite_sequence WHERE name IN ('votes','users','voters','candidates')`)
      this.initializeSchema(database)
      this.seed(database)
      database.run(`PRAGMA user_version = ${SCHEMA_VERSION}`)
      return
    }

    // An ordinary upgrade. The steps live in `migrations.ts` so they can be tested
    // against a real database without a filesystem, and each is independently safe to
    // repeat, so a failure part-way through leaves a database that can still be
    // upgraded on the next start. The version is stamped last, for the same reason.
    for (const step of MIGRATION_STEPS) step(database, this.logger)
    database.run(`PRAGMA user_version = ${SCHEMA_VERSION}`)
  }

  /**
   * Add columns and tables introduced after a database was first created.
   *
   * `CREATE TABLE IF NOT EXISTS` cannot add columns to an existing table, so an
   * older database is widened in place. This preserves elections, ballots, the
   * voter roll, and the existing audit trail across an upgrade.
   */
  private upgradeColumns(database: SqlDatabase): void {
    const columnsOf = (table: string): Set<string> => {
      const rows = database.exec(`PRAGMA table_info(${table})`)?.[0]?.values ?? []
      return new Set(rows.map((row) => String(row[1])))
    }
    const addIfMissing = (table: string, column: string, definition: string) => {
      if (columnsOf(table).has(column)) return
      try {
        database.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
      } catch (error) {
        this.logger.warn(`[election-store] could not add ${table}.${column}: ${(error as Error).message}`)
      }
    }

    addIfMissing('admins', 'role', "TEXT NOT NULL DEFAULT 'election_officer'")
    addIfMissing('admins', 'mfa_secret', 'TEXT')
    addIfMissing('admins', 'mfa_enabled', 'INTEGER NOT NULL DEFAULT 0')
    addIfMissing('admins', 'mfa_recovery_hashes', "TEXT NOT NULL DEFAULT '[]'")
    addIfMissing('admins', 'mfa_recovery_salt', 'TEXT')
    addIfMissing('admins', 'failed_attempts', 'INTEGER NOT NULL DEFAULT 0')
    addIfMissing('admins', 'locked_until', 'TEXT')
    addIfMissing('admins', 'last_failed_at', 'TEXT')
    addIfMissing('admins', 'last_login_ip', 'TEXT')
    addIfMissing('admins', 'must_change_password', 'INTEGER NOT NULL DEFAULT 0')
    addIfMissing('admins', 'disabled', 'INTEGER NOT NULL DEFAULT 0')

    addIfMissing('admin_sessions', 'mfa_verified_at', 'TEXT')
    addIfMissing('admin_sessions', 'reauth_verified_at', 'TEXT')
    addIfMissing('admin_sessions', 'last_seen_at', 'TEXT')
    addIfMissing('admin_sessions', 'ip', 'TEXT')
    addIfMissing('admin_sessions', 'user_agent', 'TEXT')
    addIfMissing('admin_sessions', 'revoked_at', 'TEXT')
    addIfMissing('admin_sessions', 'revoked_reason', 'TEXT')
    // Version 6: session tokens moved to a digest. `token` is left in place so the
    // rehash step can read it, then blanked.
    addIfMissing('admin_sessions', 'token_hash', 'TEXT')
    addIfMissing('admin_sessions', 'id', 'INTEGER')

    // Version 6: voter sessions gained a surrogate key, hashed tokens, idle tracking
    // and revocation, replacing a table keyed on the raw token.
    addIfMissing('voter_sessions', 'id', 'INTEGER')
    addIfMissing('voter_sessions', 'token_hash', 'TEXT')
    addIfMissing('voter_sessions', 'last_seen_at', 'TEXT')
    addIfMissing('voter_sessions', 'ip', 'TEXT')
    addIfMissing('voter_sessions', 'user_agent', 'TEXT')
    addIfMissing('voter_sessions', 'revoked_at', 'TEXT')
    addIfMissing('voter_sessions', 'revoked_reason', 'TEXT')

    addIfMissing('audit_events', 'request_id', "TEXT NOT NULL DEFAULT ''")
    addIfMissing('audit_events', 'actor_role', 'TEXT')
    addIfMissing('audit_events', 'resource', "TEXT NOT NULL DEFAULT ''")
    addIfMissing('audit_events', 'result', "TEXT NOT NULL DEFAULT 'success'")
    addIfMissing('audit_events', 'ip', 'TEXT')

    // The first administrator on a pre-RBAC database becomes the super admin,
    // since that account was previously unconstrained.
    if (queryScalar(database, 'SELECT COUNT(*) AS total FROM admins') > 0) {
      const unroled = queryScalar(
        database,
        "SELECT COUNT(*) AS total FROM admins WHERE role IS NULL OR role = ''",
      )
      if (unroled > 0) {
        database.run("UPDATE admins SET role = 'super_admin' WHERE role IS NULL OR role = ''")
      }
    }
  }

  /**
   * Write the demonstration workspace.
   *
   * Delegates to `writeDemoDataset`, which lives in its own module because it
   * needs the real ballot, receipt and password writers. It is reached only when
   * the database holds no elections at all — see `isDatabaseEmpty` in `build` —
   * so it can never run against a workspace that has history in it.
   *
   * The whole write is one transaction. A demo dataset that half-applied would be
   * worse than none: an election with a roll but no ballots looks like a real
   * result of zero turnout.
   */
  private seed(database: SqlDatabase): void {
    const archiveOptions = {
      database,
      databasePath: this.databasePath,
      backupDirectory: path.join(this.dataDirectory, 'backups'),
      logger: this.logger,
    }
    try {
      database.run('BEGIN IMMEDIATE')
      const written = writeDemoDataset(archiveOptions)
      database.run('COMMIT')
      // After the commit, and deliberately outside it: writing an archive takes a
      // `Database.export()`, and sql.js opens and commits a transaction of its own
      // to take a consistent snapshot. Doing that inside the seed transaction
      // would commit it early and throw away every row written since.
      const archives = writeDemoArchives(archiveOptions)
      this.logger.warn(
        `[election-store] seeded the demonstration workspace: ${written.elections} elections, ` +
          `${written.ballots} ballots, ${archives} archives. Sign in as hana.wexford ` +
          'with the demo password documented in the README.',
      )
    } catch (error) {
      try {
        database.run('ROLLBACK')
      } catch {
        /* the transaction may never have opened */
      }
      throw error
    }
  }

  /** Flush the in-memory database to disk atomically. */
  private persist(database: SqlDatabase): void {
    fs.mkdirSync(this.dataDirectory, { recursive: true })
    const temporaryPath = path.join(this.dataDirectory, `.database.sqlite.tmp.${process.pid}.${Date.now()}`)
    let renamed = false
    try {
      fs.writeFileSync(temporaryPath, Buffer.from(database.export()), { mode: 0o600 })
      const descriptor = fs.openSync(temporaryPath, 'r+')
      try {
        fs.fchmodSync(descriptor, 0o600)
        fs.fsyncSync(descriptor)
      } finally {
        fs.closeSync(descriptor)
      }
      fs.renameSync(temporaryPath, this.databasePath)
      renamed = true
    } finally {
      if (!renamed) {
        try {
          if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath)
        } catch {
          /* best effort */
        }
      }
    }
    try {
      const descriptor = fs.openSync(this.dataDirectory, 'r')
      try {
        fs.fsyncSync(descriptor)
      } catch {
        /* directory fsync is not supported on every filesystem */
      }
      fs.closeSync(descriptor)
    } catch {
      /* best effort */
    }
  }

  /**
   * Run `work` against the shared database, then persist it.
   *
   * All writes go through this method so they are serialised and durable.
   */
  async write<T>(work: (database: SqlDatabase) => T | Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      const database = await this.open()
      const result = await work(database)
      this.bumpRevision(database)
      this.persist(database)
      return result
    }
    const result = this.writeChain.then(run, run)
    this.writeChain = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  /**
   * The single shared in-memory database handle.
   *
   * sql.js keeps the whole database in memory and every operation on it is
   * synchronous, so one long-lived handle is safe: a read cannot interleave
   * inside a write transaction, and there is no per-request parse cost.
   */
  async open(): Promise<SqlDatabase> {
    if (!this.openPromise) {
      this.openPromise = this.build().catch((error: unknown) => {
        this.openPromise = null
        throw error
      })
    }
    return this.openPromise
  }

  /** Read-only helper. Waits for any in-flight write to finish first. */
  async read<T>(work: (database: SqlDatabase) => T): Promise<T> {
    await this.writeChain
    return work(await this.open())
  }

  /** Ensure the database exists and is writable, reporting the path in use. */
  async initialise(): Promise<string> {
    await this.open()
    await this.read((database) => this.persist(database))
    return this.databasePath
  }

  private bumpRevision(database: SqlDatabase): void {
    database.run("UPDATE app_state SET value = value + 1 WHERE key = 'revision'")
  }
}

export function isDatabaseEmpty(database: SqlDatabase): boolean {
  const count = database.exec('SELECT COUNT(*) FROM elections')[0]?.values[0]?.[0]
  return typeof count !== 'number' || count === 0
}

export function readRevision(database: SqlDatabase): number {
  const value = database.exec("SELECT value FROM app_state WHERE key = 'revision'")[0]?.values[0]?.[0]
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

export function readRows(database: SqlDatabase, statement: string): unknown[][] {
  return database.exec(statement)[0]?.values ?? []
}

export function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export function nullableText(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null
}

export function numeric(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

export function nullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function flag(value: unknown): 0 | 1 {
  return value === 1 ? 1 : 0
}

/**
 * Run a parameterised query and return every row.
 *
 * `exec` cannot bind parameters, so any query that interpolates a value must go
 * through a prepared statement. Every value that originates from a request is
 * bound rather than interpolated.
 */
export function queryAll(database: SqlDatabase, sql: string, params: unknown[] = []): SqlRow[] {
  const statement = database.prepare(sql)
  try {
    if (params.length) statement.bind(params)
    const rows: SqlRow[] = []
    while (statement.step()) rows.push(statement.getAsObject())
    return rows
  } finally {
    statement.free()
  }
}

export function queryOne(database: SqlDatabase, sql: string, params: unknown[] = []): SqlRow | null {
  const statement = database.prepare(sql)
  try {
    if (params.length) statement.bind(params)
    return statement.step() ? statement.getAsObject() : null
  } finally {
    statement.free()
  }
}

export function queryScalar(database: SqlDatabase, sql: string, params: unknown[] = []): number {
  const row = queryOne(database, sql, params)
  if (!row) return 0
  const first = Object.values(row)[0]
  return typeof first === 'number' && Number.isFinite(first) ? first : 0
}

/** Run an INSERT/UPDATE/DELETE with bound parameters. */
export function execute(database: SqlDatabase, sql: string, params: unknown[] = []): void {
  const statement = database.prepare(sql)
  try {
    statement.run(params)
  } finally {
    statement.free()
  }
}

export function lastInsertId(database: SqlDatabase): number {
  return queryScalar(database, 'SELECT last_insert_rowid() AS id')
}

/** Run `work` inside an IMMEDIATE transaction, rolling back on any failure. */
export function transact<T>(database: SqlDatabase, work: () => T): T {
  database.run('BEGIN IMMEDIATE')
  try {
    const result = work()
    database.run('COMMIT')
    return result
  } catch (error) {
    try {
      database.run('ROLLBACK')
    } catch {
      /* transaction already closed */
    }
    throw error
  }
}
