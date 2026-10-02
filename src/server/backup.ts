/**
 * Backups.
 *
 * A backup is a byte-for-byte export of the SQLite database written to
 * `data/backups/`, which sits inside the Git-ignored data directory so archives
 * containing personal data can never be committed.
 *
 * Restoring is destructive, so the current database is snapshotted to a
 * `pre_restore` backup first. That is the only thing standing between an
 * operator and an unrecoverable mistake, so it happens unconditionally before
 * any overwrite.
 */

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { execute, lastInsertId, queryAll, queryOne, queryScalar, text, type SqlDatabase } from './db'
import type { BackupList, BackupRecord } from '../lib/adminTypes'

const FILENAME_PATTERN = /^backup-(\d{8}T\d{6}Z)(-[\w-]+)?\.sqlite$/

export class BackupError extends Error {}

function stamp(atMs: number): string {
  return new Date(atMs).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
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

function toBackup(row: Record<string, unknown>): BackupRecord {
  return {
    id: Number(row.id ?? 0),
    label: text(row.label),
    filename: text(row.filename),
    size_bytes: Number(row.size_bytes) || 0,
    created_at: text(row.created_at),
    created_by: typeof row.created_by === 'number' ? row.created_by : null,
    created_by_label: text(row.created_by_label),
    kind: (text(row.kind) || 'manual') as BackupRecord['kind'],
    election_count: Number(row.election_count) || 0,
    vote_count: Number(row.vote_count) || 0,
    admin_count: Number(row.admin_count) || 0,
    checksum: text(row.checksum),
    note: text(row.note),
  }
}

export class BackupService {
  constructor(private readonly directory: string) {}

  ensureDirectory(): void {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 })
  }

  /**
   * Write a backup of the in-memory database.
   *
   * The export happens in memory, so this works whether or not the on-disk file
   * has caught up with the current state.
   */
  create(
    database: SqlDatabase,
    input: { label: string; kind: BackupRecord['kind']; note?: string; createdBy?: number | null; createdByLabel?: string; atMs?: number },
  ): BackupRecord {
    this.ensureDirectory()
    const at = input.atMs ?? Date.now()
    const name = `backup-${stamp(at)}-${slug(input.label)}.sqlite`
    const target = path.join(this.directory, name)

    if (fs.existsSync(target)) {
      throw new BackupError('A backup with that name already exists. Choose a different label.')
    }

    const bytes = Buffer.from(database.export())
    // Write to a temporary file then rename, so a partial file can never be
    // listed as a usable backup.
    const temporary = `${target}.partial`
    try {
      fs.writeFileSync(temporary, bytes, { mode: 0o600 })
      fs.renameSync(temporary, target)
    } catch (error) {
      try {
        if (fs.existsSync(temporary)) fs.unlinkSync(temporary)
      } catch {
        /* best effort */
      }
      throw new BackupError(`Could not write the backup: ${(error as Error).message}`)
    }

    const checksum = createHash('sha256').update(bytes).digest('hex')
    const stats = {
      elections: queryScalar(database, 'SELECT COUNT(*) AS total FROM elections'),
      ballots: queryScalar(database, 'SELECT COUNT(*) AS total FROM ballots'),
      admins: queryScalar(database, 'SELECT COUNT(*) AS total FROM admins'),
    }
    const createdAt = new Date(at).toISOString()

    execute(
      database,
      `INSERT INTO backups (label, filename, size_bytes, checksum, kind, note,
        election_count, vote_count, admin_count, created_by, created_by_label, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.label,
        name,
        bytes.length,
        checksum,
        input.kind,
        input.note ?? '',
        stats.elections,
        stats.ballots,
        stats.admins,
        input.createdBy ?? null,
        input.createdByLabel ?? '',
        createdAt,
      ],
    )

    const row = queryOne(database, 'SELECT * FROM backups WHERE id = ?', [lastInsertId(database)])
    return toBackup(row ?? {})
  }

  list(database: SqlDatabase): BackupList {
    this.ensureDirectory()
    const rows = queryAll(database, 'SELECT * FROM backups ORDER BY id DESC').map(toBackup)
    // Drop records whose file has been removed outside the application.
    const present = rows.filter((row) => {
      const file = path.join(this.directory, row.filename)
      if (fs.existsSync(file)) return true
      execute(database, 'DELETE FROM backups WHERE id = ?', [row.id])
      return false
    })
    return {
      backups: present,
      directory: this.directory,
      total_size_bytes: present.reduce((sum, row) => sum + row.size_bytes, 0),
    }
  }

  resolve(database: SqlDatabase, id: number): { record: BackupRecord; file: string } | null {
    const row = queryOne(database, 'SELECT * FROM backups WHERE id = ?', [id])
    if (!row) return null
    const record = toBackup(row)
    const file = path.join(this.directory, record.filename)
    if (!fs.existsSync(file)) return null
    return { record, file }
  }

  verify(file: string, expectedChecksum: string): boolean {
    try {
      const actual = createHash('sha256').update(fs.readFileSync(file)).digest('hex')
      return actual === expectedChecksum
    } catch {
      return false
    }
  }

  /** Read a backup's bytes, used by the restore path. */
  read(file: string): Buffer {
    return fs.readFileSync(file)
  }

  /**
   * Replace the live database file with a backup's contents.
   *
   * The current file is copied to a timestamped sidecar first so an operator can
   * undo this without having taken a backup themselves.
   */
  restoreInto(liveDatabasePath: string, file: string): { undoPath: string } {
    let undoPath = ''
    if (fs.existsSync(liveDatabasePath)) {
      undoPath = `${liveDatabasePath}.pre-restore.${stamp(Date.now())}`
      fs.copyFileSync(liveDatabasePath, undoPath)
    }
    const temporary = `${liveDatabasePath}.restoring`
    fs.copyFileSync(file, temporary)
    fs.renameSync(temporary, liveDatabasePath)
    return { undoPath }
  }

  /** Apply the retention policy, keeping the newest `keep` archives. */
  prune(database: SqlDatabase, keep: number): number {
    const rows = queryAll(database, 'SELECT * FROM backups ORDER BY id DESC').map(toBackup)
    const excess = rows.slice(Math.max(1, keep))
    let removed = 0
    for (const row of excess) {
      const file = path.join(this.directory, row.filename)
      try {
        if (fs.existsSync(file)) fs.unlinkSync(file)
        execute(database, 'DELETE FROM backups WHERE id = ?', [row.id])
        removed += 1
      } catch {
        /* keep the record if the file could not be removed */
      }
    }
    return removed
  }

  latest(database: SqlDatabase): BackupRecord | null {
    const row = queryOne(database, 'SELECT * FROM backups ORDER BY id DESC LIMIT 1')
    return row ? toBackup(row) : null
  }

  totalSize(database: SqlDatabase): number {
    return queryScalar(database, 'SELECT COALESCE(SUM(size_bytes), 0) AS total FROM backups')
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`
}

export { FILENAME_PATTERN }
