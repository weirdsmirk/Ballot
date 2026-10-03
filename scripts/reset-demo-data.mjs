#!/usr/bin/env node
/**
 * Rebuild the demonstration workspace.
 *
 * The seed only runs against a database with no elections in it, so once you have
 * clicked around — opened a poll, certified a result, restored an archive — there
 * is no way back through the interface. This script removes the database so the
 * next `npm run dev` builds the demo workspace again from scratch.
 *
 * It is deliberately awkward to run by accident:
 *
 *   · `--force` is required. Without it the script explains what it would delete
 *     and exits non-zero, so it cannot be fired off by a stray npm invocation.
 *   · The ballot integrity key is *kept*. Deleting it would not be dangerous, but
 *     keeping it means a rebuild keeps the same digest key, so digests written
 *     before and after a reset are comparable — which is occasionally useful when
 *     investigating a tally that looks wrong.
 *   · It prints exactly which files it removed.
 *
 * Usage:
 *   npm run demo:reset -- --force
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dataDirectory = path.join(root, 'data')
const databasePath = path.join(dataDirectory, 'database.sqlite')
const backupDirectory = path.join(dataDirectory, 'backups')

const force = process.argv.includes('--force')

/** Everything this script is willing to delete. */
function targets() {
  const found = []
  if (fs.existsSync(databasePath)) found.push(databasePath)
  if (fs.existsSync(backupDirectory)) {
    for (const entry of fs.readdirSync(backupDirectory)) {
      found.push(path.join(backupDirectory, entry))
    }
  }
  // Quarantine files left behind when an unreadable database was moved aside.
  if (fs.existsSync(dataDirectory)) {
    for (const entry of fs.readdirSync(dataDirectory)) {
      if (entry.startsWith('database.sqlite.corrupt.')) found.push(path.join(dataDirectory, entry))
    }
  }
  return found
}

const existing = targets()

if (existing.length === 0) {
  process.stdout.write(
    'Nothing to reset: there is no database in data/ yet.\n' +
      'Run `npm run dev` and the demonstration workspace will be created on first start.\n',
  )
  process.exit(0)
}

if (!force) {
  process.stderr.write(
    'This would permanently delete the local election database and every archive in data/:\n\n' +
      existing.map((file) => `  ${path.relative(root, file)}`).join('\n') +
      '\n\nThe demonstration workspace will be rebuilt from fixtures on the next `npm run dev`.\n' +
      'Any elections, ballots, rolls, audit entries or administrator accounts you created are lost.\n\n' +
      'To go ahead, run:\n  npm run demo:reset -- --force\n',
  )
  process.exit(1)
}

let removed = 0
for (const file of existing) {
  try {
    fs.rmSync(file, { recursive: true, force: true })
    removed += 1
  } catch (error) {
    process.stderr.write(`  could not remove ${path.relative(root, file)}: ${error.message}\n`)
  }
}

// The directory is left in place: the integrity key lives beside it, and removing
// it would invalidate every digest ever written.
process.stdout.write(
  `Removed ${removed} file${removed === 1 ? '' : 's'}.\n` +
    'Kept data/ballot-integrity.key, so digests remain comparable across the rebuild.\n' +
    'Run `npm run dev` to rebuild the demonstration workspace.\n',
)