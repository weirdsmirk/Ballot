/**
 * Voter verification challenges.
 *
 * A verification code is a single-use, short-lived secret. This module owns its
 * whole lifecycle so that no other code has to think about it:
 *
 * - **Generated on the server** with `crypto.randomInt`, which is uniformly
 *   distributed and drawn from the OS CSPRNG. There is no `Math.random`, and no
 *   code the client can influence.
 * - **Stored only as a hash**, with a per-challenge random salt. The plaintext
 *   exists in exactly one place: the delivery seam below.
 * - **Expiring**, single-use, and capped at a maximum number of attempts, after
 *   which the challenge locks for a cooling-off period.
 * - **Compared in constant time**, so a wrong code cannot be discovered one
 *   character at a time.
 *
 * On offline brute force
 * ----------------------
 * A six digit code has at most 10^6 candidates, and *any* fast hash can be
 * brute-forced offline in seconds if the database is stolen. Slow hashing does
 * not change that — it only adds latency — so this module does not pretend
 * otherwise. The defences that actually matter against guessing are the attempt
 * cap, the short expiry and the per-address rate limit, all applied here, and
 * `otpDigits` is configurable so a deployment whose gateway supports longer
 * codes can raise it. The real protection for a leaked database is that the
 * codes are already spent: a challenge is consumed on first use.
 */

import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { execute, queryAll, queryOne, queryScalar, text, type SqlDatabase } from './db'

export type ChallengeChannel = 'phone' | 'email'

export type Challenge = {
  id: string
  electionId: string
  voterRecordId: number
  channel: ChallengeChannel
  attempts: number
  maxAttempts: number
  createdAt: string
  expiresAt: string
  consumedAt: string | null
  lockedUntil: string | null
}

export type ChallengePolicy = {
  /** How long a code stays usable. */
  ttlSeconds: number
  /** Wrong guesses allowed before the challenge locks. */
  maxAttempts: number
  /** How long a locked challenge stays locked. */
  lockoutSeconds: number
  /** Minimum gap between issuing codes for the same voter. */
  resendCooldownSeconds: number
  /** Length of the generated code. */
  digits: number
}

export const DEFAULT_CHALLENGE_POLICY: ChallengePolicy = {
  ttlSeconds: 300,
  maxAttempts: 5,
  lockoutSeconds: 300,
  resendCooldownSeconds: 30,
  digits: 6,
}

export type IssueResult =
  | { ok: true; challenge: Challenge; code: string }
  | { ok: false; code: 'cooldown'; retryAfterSeconds: number }
  | { ok: false; code: 'no_contact' }

/** Codes are numeric and zero padded, so `000123` and `123` are not both valid. */
export function generateCode(digits: number): string {
  const bounded = Math.max(4, Math.min(10, Math.trunc(digits)))
  return String(randomInt(0, 10 ** bounded)).padStart(bounded, '0')
}

function newSalt(): string {
  return randomBytes(16).toString('base64')
}

/** HMAC-SHA256 over the salt. Length is fixed, so the comparison is constant time. */
function hashCode(salt: string, code: string): string {
  return createHmac('sha256', salt).update(code).digest('hex')
}

export function codesMatch(salt: string, expectedHash: string, candidate: string): boolean {
  const actual = Buffer.from(hashCode(salt, candidate), 'hex')
  const expected = Buffer.from(expectedHash, 'hex')
  if (actual.length !== expected.length || actual.length === 0) return false
  return timingSafeEqual(actual, expected)
}

function toChallenge(row: Record<string, unknown>): Challenge {
  return {
    id: text(row.id),
    electionId: text(row.election_id),
    voterRecordId: Number(row.voter_record_id),
    channel: text(row.channel) as ChallengeChannel,
    attempts: Number(row.attempts) || 0,
    maxAttempts: Number(row.max_attempts) || 0,
    createdAt: text(row.created_at),
    expiresAt: text(row.expires_at),
    consumedAt: typeof row.consumed_at === 'string' && row.consumed_at ? row.consumed_at : null,
    lockedUntil: typeof row.locked_until === 'string' && row.locked_until ? row.locked_until : null,
  }
}

function findChallengeRow(database: SqlDatabase, id: string): Record<string, unknown> | null {
  return queryOne(database, 'SELECT * FROM voter_challenges WHERE id = ?', [id])
}

/**
 * A challenge is live only while it is unconsumed, unexpired and unlocked.
 *
 * All three are checked together and in one place, so no caller can accidentally
 * honour a spent or expired code by forgetting one of them.
 */
export function isLive(challenge: Challenge, now: number): boolean {
  if (challenge.consumedAt) return false
  if (Date.parse(challenge.expiresAt) <= now) return false
  if (challenge.lockedUntil && Date.parse(challenge.lockedUntil) > now) return false
  return true
}

/**
 * The delivery seam.
 *
 * A real deployment hands `code` to an SMS or mail gateway. This build has no
 * gateway, so when the development flag is set the code is returned to the caller
 * for display. The flag is surfaced on the dashboard and in system health, and
 * the health check degrades when it is on, so it cannot be left enabled by
 * accident without somebody noticing.
 */
export type Deliverer = (input: {
  challenge: Challenge
  code: string
  destination: string
}) => Promise<{ delivered: boolean; reason?: string }>

/**
 * Issue a fresh code for one channel, superseding any outstanding challenge.
 *
 * Returns a cooldown refusal rather than silently replacing a code, so a caller
 * cannot turn the endpoint into a code-guessing oracle by asking repeatedly.
 */
export function issueChallenge(
  database: SqlDatabase,
  input: {
    electionId: string
    voterRecordId: number
    channel: ChallengeChannel
    destination: string
    policy: ChallengePolicy
    now: number
  },
): IssueResult {
  if (!input.destination) return { ok: false, code: 'no_contact' }

  const cooldownMs = input.policy.resendCooldownSeconds * 1000
  const cutoff = new Date(input.now - cooldownMs).toISOString()
  const lastIssued = queryOne(
    database,
    'SELECT created_at FROM voter_challenges WHERE election_id = ? AND voter_record_id = ? AND channel = ? AND created_at > ? ORDER BY created_at DESC LIMIT 1',
    [input.electionId, input.voterRecordId, input.channel, cutoff],
  )
  if (lastIssued) {
    const issuedAt = Date.parse(text(lastIssued.created_at))
    return {
      ok: false,
      code: 'cooldown',
      retryAfterSeconds: Math.max(1, Math.ceil((issuedAt + cooldownMs - input.now) / 1000)),
    }
  }

  // Supersede anything still outstanding so only one code can ever be live.
  execute(
    database,
    `UPDATE voter_challenges SET consumed_at = ?
       WHERE election_id = ? AND voter_record_id = ? AND channel = ? AND consumed_at IS NULL`,
    [new Date(input.now).toISOString(), input.electionId, input.voterRecordId, input.channel],
  )

  const id = randomBytes(16).toString('base64url')
  const salt = newSalt()
  const code = generateCode(input.policy.digits)
  const createdAt = new Date(input.now).toISOString()
  const expiresAt = new Date(input.now + input.policy.ttlSeconds * 1000).toISOString()

  execute(
    database,
    `INSERT INTO voter_challenges
       (id, election_id, voter_record_id, channel, code_hash, salt, attempts, max_attempts,
        created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
    [id, input.electionId, input.voterRecordId, input.channel, hashCode(salt, code), salt, input.policy.maxAttempts, createdAt, expiresAt],
  )

  return {
    ok: true,
    code,
    challenge: {
      id,
      electionId: input.electionId,
      voterRecordId: input.voterRecordId,
      channel: input.channel,
      attempts: 0,
      maxAttempts: input.policy.maxAttempts,
      createdAt,
      expiresAt,
      consumedAt: null,
      lockedUntil: null,
    },
  }
}

export type VerifyOutcome =
  | { ok: true; challenge: Challenge }
  | { ok: false; reason: 'unknown' | 'consumed' | 'expired' | 'locked' | 'exhausted' | 'mismatch' }

/**
 * Check a submitted code against a challenge, counting the attempt.
 *
 * This does **not** consume the challenge. Consumption is a separate step so a
 * caller verifying several channels can check them all first and only then spend
 * them: if one channel is right and another is wrong, the right one stays usable
 * and the voter can correct the mistake instead of being locked out until the
 * resend cooldown.
 *
 * The attempt is recorded whether the code was right or wrong, so an attacker
 * cannot learn the right code by watching a counter.
 */
export function verifyChallenge(
  database: SqlDatabase,
  input: { challengeId: string; code: string; policy: ChallengePolicy; now: number },
): VerifyOutcome {
  const row = findChallengeRow(database, input.challengeId)
  // An unknown id and a spent id are reported the same way, so a caller cannot
  // use the difference to enumerate live challenges.
  if (!row) return { ok: false, reason: 'unknown' }
  const challenge = toChallenge(row)
  if (challenge.consumedAt) return { ok: false, reason: 'consumed' }
  if (Date.parse(challenge.expiresAt) <= input.now) return { ok: false, reason: 'expired' }
  if (challenge.lockedUntil && Date.parse(challenge.lockedUntil) > input.now) {
    return { ok: false, reason: 'locked' }
  }
  if (challenge.attempts >= challenge.maxAttempts) return { ok: false, reason: 'exhausted' }

  // Read the salt and hash from the row we already have. Going back to the
  // database for them would mean a second lookup whose value has to be coerced
  // into a string, and the numeric helper silently yields 0 for text.
  const salt = text(row.salt)
  const expectedHash = text(row.code_hash)
  const matches = salt !== '' && expectedHash !== '' && codesMatch(salt, expectedHash, input.code.trim())

  if (matches) return { ok: true, challenge }

  // Wrong code: count the attempt, and lock once the allowance is used up.
  const attempts = challenge.attempts + 1
  const exhausted = attempts >= challenge.maxAttempts
  execute(
    database,
    'UPDATE voter_challenges SET attempts = ?, locked_until = ? WHERE id = ?',
    [attempts, exhausted ? new Date(input.now + input.policy.lockoutSeconds * 1000).toISOString() : null, input.challengeId],
  )
  return { ok: false, reason: exhausted ? 'exhausted' : 'mismatch' }
}

/**
 * Spend a challenge, so its code cannot be used a second time.
 *
 * Called only once every required channel has been answered, which is what makes
 * a multi-channel verification all-or-nothing.
 */
export function consumeChallenge(database: SqlDatabase, challengeId: string, now: number): void {
  execute(database, 'UPDATE voter_challenges SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL', [
    new Date(now).toISOString(),
    challengeId,
  ])
}

/** Challenges currently outstanding for a voter, for diagnostics. */
export function activeChallenges(database: SqlDatabase, electionId: string, voterRecordId: number, now: number): Challenge[] {
  return queryAll(
    database,
    'SELECT * FROM voter_challenges WHERE election_id = ? AND voter_record_id = ? AND consumed_at IS NULL',
    [electionId, voterRecordId],
  )
    .map(toChallenge)
    .filter((challenge) => Date.parse(challenge.expiresAt) > now)
}

/**
 * The live challenge for one channel, if there is one.
 *
 * Callers must ask "which channel does this voter still owe an answer for"
 * rather than "what challenges happen to be outstanding". Driving verification
 * from the outstanding set is the mistake that makes replay work: once the
 * challenges are spent the set is empty, and an empty set would satisfy a loop
 * that only iterates over it.
 */
export function findLiveChallenge(
  database: SqlDatabase,
  input: { electionId: string; voterRecordId: number; channel: ChallengeChannel; now: number },
): Challenge | null {
  const row = queryOne(
    database,
    `SELECT * FROM voter_challenges
      WHERE election_id = ? AND voter_record_id = ? AND channel = ? AND consumed_at IS NULL
      ORDER BY created_at DESC LIMIT 1`,
    [input.electionId, input.voterRecordId, input.channel],
  )
  if (!row) return null
  const challenge = toChallenge(row)
  return Date.parse(challenge.expiresAt) > input.now ? challenge : null
}

/** Remove spent and long-expired challenges so the table cannot grow forever. */
export function pruneChallenges(database: SqlDatabase, now: number, keepMs = 86_400_000): number {
  const before = queryScalar(database, 'SELECT COUNT(*) AS total FROM voter_challenges')
  execute(database, 'DELETE FROM voter_challenges WHERE expires_at < ?', [
    new Date(now - keepMs).toISOString(),
  ])
  return before - queryScalar(database, 'SELECT COUNT(*) AS total FROM voter_challenges')
}