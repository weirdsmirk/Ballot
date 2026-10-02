/**
 * Row mapping and read queries.
 *
 * Everything that turns a database row into a domain object lives here, so the
 * command handlers never deal in raw arrays.
 */

import { execute, flag, nullableNumber, nullableText, numeric, queryAll, queryOne, queryScalar, text, type SqlDatabase } from './db'
import {
  CANDIDATE_STATUSES,
  ELECTION_STATUSES,
  ELECTION_TYPES,
  RESULTS_VISIBILITIES,
  type AuditEvent,
  type Candidate,
  type CandidateStatus,
  type CandidateWithTally,
  type Election,
  type ElectionRules,
  type ElectionStatus,
  type ElectionType,
  type EligibilityRules,
  type EligibilityRecord,
  type RollVoter,
  type RollVoterWithStatus,
} from '../lib/types'
import { defaultEligibility, defaultRules } from '../lib/validate'
import { tallyBallots } from './ballots'

function safeJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || !value) return fallback
  try {
    const parsed: unknown = JSON.parse(value)
    if (!parsed || typeof parsed !== 'object') return fallback
    return { ...fallback, ...(parsed as T) }
  } catch {
    return fallback
  }
}

function parseRules(value: unknown): ElectionRules {
  const base = defaultRules()
  const merged = safeJson<Partial<ElectionRules>>(value, {})
  return {
    votesPerVoter: clampInt(merged.votesPerVoter, 1, 20, base.votesPerVoter),
    allowNotA: merged.allowNotA === true,
    allowAbstain: merged.allowAbstain === true,
    requireOtp: merged.requireOtp !== false,
    requirePhone: merged.requirePhone !== false,
    requireEmail: merged.requireEmail !== false,
    resultsVisibility: oneOf(merged.resultsVisibility, RESULTS_VISIBILITIES, base.resultsVisibility),
    // Force-disabled, whatever the stored rules say.
    //
    // Replacing a ballot means finding it, and finding it means the voter can be
    // linked to it — which is the exact capability this schema was rebuilt to
    // remove. Honouring the flag would mean quietly reintroducing a voter-to-choice
    // mapping for elections that had it switched on, so the switch is read and
    // ignored. A secret ballot cannot be changed; that is not a limitation of this
    // implementation but the property the design is for.
    allowVoteChange: false,
    issueReceipts: merged.issueReceipts !== false,
    randomizeBallotOrder: merged.randomizeBallotOrder === true,
    showCandidateImages: merged.showCandidateImages !== false,
  }
}

function parseEligibility(value: unknown): EligibilityRules {
  const base = defaultEligibility()
  const merged = safeJson<Partial<EligibilityRules>>(value, {})
  return {
    mode: merged.mode === 'open_registration' ? 'open_registration' : 'roll',
    identifierLabel: text(merged.identifierLabel) || base.identifierLabel,
    groupLabel: text(merged.groupLabel),
    notes: text(merged.notes),
  }
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const numericValue = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numericValue)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(numericValue)))
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && allowed.includes(value as T) ? (value as T) : fallback
}

export function toElection(row: Record<string, unknown>): Election {
  return {
    id: text(row.id),
    title: text(row.title),
    description: text(row.description),
    election_type: oneOf(row.election_type, ELECTION_TYPES, 'general') as ElectionType,
    timezone: text(row.timezone) || 'UTC',
    starts_at: text(row.starts_at),
    ends_at: text(row.ends_at),
    status: oneOf(row.status, ELECTION_STATUSES, 'draft') as ElectionStatus,
    rules: parseRules(row.rules),
    eligibility: parseEligibility(row.eligibility),
    created_by: nullableNumber(row.created_by),
    created_at: text(row.created_at),
    updated_at: text(row.updated_at),
    published_at: nullableText(row.published_at),
    published_by: nullableNumber(row.published_by),
    closed_at: nullableText(row.closed_at),
    closed_by: nullableNumber(row.closed_by),
    certified_at: nullableText(row.certified_at),
    certified_by: nullableNumber(row.certified_by),
    archived_at: nullableText(row.archived_at),
    archived_by: nullableNumber(row.archived_by),
  }
}

export function toCandidate(row: Record<string, unknown>): Candidate {
  return {
    id: numeric(row.id),
    election_id: text(row.election_id),
    name: text(row.name),
    organization: text(row.organization),
    abbreviation: text(row.abbreviation),
    description: text(row.description),
    image_url: text(row.image_url),
    symbol: text(row.symbol),
    position: numeric(row.position),
    status: oneOf(row.status, CANDIDATE_STATUSES, 'approved') as CandidateStatus,
    created_at: text(row.created_at),
    updated_at: text(row.updated_at),
  }
}

export function toRollVoter(row: Record<string, unknown>): RollVoter {
  return {
    id: numeric(row.id),
    election_id: text(row.election_id),
    voter_id: text(row.voter_id),
    full_name: text(row.full_name),
    phone: text(row.phone),
    email: text(row.email),
    external_ref: text(row.external_ref),
    created_at: text(row.created_at),
  }
}

export function toAuditEvent(row: Record<string, unknown>): AuditEvent {
  return {
    id: numeric(row.id),
    election_id: nullableText(row.election_id),
    actor_type: oneOf(row.actor_type, ['admin', 'system', 'voter'] as const, 'system'),
    actor_id: nullableText(row.actor_id),
    actor_label: text(row.actor_label),
    action: text(row.action),
    from_status: nullableText(row.from_status),
    to_status: nullableText(row.to_status),
    summary: text(row.summary),
    detail: text(row.detail) || '{}',
    created_at: text(row.created_at),
  }
}

const ELECTION_COLUMNS = `id, title, description, election_type, timezone, starts_at, ends_at, status,
  rules, eligibility, created_by, created_at, updated_at, published_at, published_by,
  closed_at, closed_by, certified_at, certified_by, archived_at, archived_by, ever_opened`

export function findElectionRow(database: SqlDatabase, electionId: string): Record<string, unknown> | null {
  return queryOne(database, `SELECT ${ELECTION_COLUMNS} FROM elections WHERE id = ?`, [electionId])
}

export function findElection(database: SqlDatabase, electionId: string): Election | null {
  const row = findElectionRow(database, electionId)
  return row ? toElection(row) : null
}

export function listElectionRows(database: SqlDatabase, includeArchived: boolean): Record<string, unknown>[] {
  const sql = includeArchived
    ? `SELECT ${ELECTION_COLUMNS} FROM elections ORDER BY created_at DESC, id`
    : `SELECT ${ELECTION_COLUMNS} FROM elections WHERE status != 'archived' ORDER BY created_at DESC, id`
  return queryAll(database, sql)
}

export function listElections(database: SqlDatabase, includeArchived: boolean): Election[] {
  return listElectionRows(database, includeArchived).map(toElection)
}

export function listCandidates(database: SqlDatabase, electionId: string): CandidateWithTally[] {
  // The vote count cannot be a correlated subquery any more: ballots keep their
  // selections in one opaque column, so there is no candidate id in the table to
  // match on. Counting happens in `tallyBallots` and is attached here.
  const counts = tallyBallots(database, electionId).counts
  return queryAll(database, 'SELECT * FROM candidates WHERE election_id = ? ORDER BY position, id', [electionId]).map(
    (row) => {
      const candidate = toCandidate(row)
      return { ...candidate, vote_count: counts.get(candidate.id) ?? 0 }
    },
  )
}

export function findCandidateRow(database: SqlDatabase, electionId: string, candidateId: number): Record<string, unknown> | null {
  return queryOne(database, 'SELECT * FROM candidates WHERE election_id = ? AND id = ?', [electionId, candidateId])
}

/**
 * The roll, with eligibility and participation folded in.
 *
 * Both are correlated subqueries against their own tables, so the roll row itself
 * stays a pure identity record while the two facts an operator needs are still
 * available. Neither subquery can reach a selection: `participation` has no
 * selections column and `ballots` has no voter column, so there is nothing here
 * to join to even if somebody tried.
 */
export function listRollVoters(database: SqlDatabase, electionId: string): RollVoterWithStatus[] {
  const rows = queryAll(
    database,
    `SELECT r.*,
        (SELECT COUNT(*) FROM participation p
          WHERE p.election_id = r.election_id AND p.voter_record_id = r.id) AS has_voted,
        (SELECT COUNT(*) FROM eligibility e
          WHERE e.election_id = r.election_id AND e.voter_record_id = r.id AND e.status = 'eligible') AS is_eligible
       FROM roll_voters r WHERE r.election_id = ? ORDER BY r.voter_id`,
    [electionId],
  )
  return rows.map((row) => ({
    ...toRollVoter(row),
    is_eligible: flag(row.is_eligible) as 0 | 1,
    has_voted: flag(row.has_voted),
  }))
}

export function findRollVoterRow(
  database: SqlDatabase,
  electionId: string,
  voterId: string,
): Record<string, unknown> | null {
  return queryOne(database, 'SELECT * FROM roll_voters WHERE election_id = ? AND voter_id = ?', [
    electionId,
    voterId.toUpperCase(),
  ])
}

export function countCandidates(database: SqlDatabase, electionId: string, approvedOnly = true): number {
  return approvedOnly
    ? queryScalar(database, "SELECT COUNT(*) AS total FROM candidates WHERE election_id = ? AND status = 'approved'", [electionId])
    : queryScalar(database, 'SELECT COUNT(*) AS total FROM candidates WHERE election_id = ?', [electionId])
}

export function countEligibleVoters(database: SqlDatabase, electionId: string): number {
  return queryScalar(
    database,
    `SELECT COUNT(*) AS total FROM eligibility WHERE election_id = ? AND status = 'eligible'`,
    [electionId],
  )
}

export function findEligibility(
  database: SqlDatabase,
  electionId: string,
  voterRecordId: number,
): EligibilityRecord | null {
  const row = queryOne(database, 'SELECT * FROM eligibility WHERE election_id = ? AND voter_record_id = ?', [
    electionId,
    voterRecordId,
  ])
  if (!row) return null
  return {
    election_id: text(row.election_id),
    voter_record_id: Number(row.voter_record_id),
    status: text(row.status) === 'ineligible' ? 'ineligible' : 'eligible',
    reason: text(row.reason),
    decided_at: text(row.decided_at),
    decided_by: typeof row.decided_by === 'string' && row.decided_by ? row.decided_by : null,
  }
}

/**
 * Record an eligibility decision.
 *
 * Written as its own row so the decision has a reason, a time and an author, and
 * so a change to who may vote is never confused with a change to who somebody is.
 */
export function setEligibility(
  database: SqlDatabase,
  input: {
    electionId: string
    voterRecordId: number
    eligible: boolean
    reason?: string
    decidedBy?: string | null
    now: number
  },
): void {
  execute(
    database,
    `INSERT INTO eligibility (election_id, voter_record_id, status, reason, decided_at, decided_by)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (election_id, voter_record_id)
     DO UPDATE SET status = excluded.status, reason = excluded.reason,
                   decided_at = excluded.decided_at, decided_by = excluded.decided_by`,
    [
      input.electionId,
      input.voterRecordId,
      input.eligible ? 'eligible' : 'ineligible',
      input.reason ?? '',
      new Date(input.now).toISOString(),
      input.decidedBy ?? null,
    ],
  )
}

export function countBallotRows(database: SqlDatabase, electionId: string): number {
  return queryScalar(database, 'SELECT COUNT(*) AS total FROM ballots WHERE election_id = ?', [electionId])
}

export function hasEverOpened(database: SqlDatabase, electionId: string): boolean {
  const row = findElectionRow(database, electionId)
  return row ? numeric(row.ever_opened) === 1 : false
}

export function listAuditEvents(database: SqlDatabase, electionId: string | null, limit: number): AuditEvent[] {
  const rows = electionId
    ? queryAll(database, 'SELECT * FROM audit_events WHERE election_id = ? ORDER BY id DESC LIMIT ?', [electionId, limit])
    : queryAll(database, 'SELECT * FROM audit_events ORDER BY id DESC LIMIT ?', [limit])
  return rows.map(toAuditEvent)
}
