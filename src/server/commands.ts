/**
 * Command handlers.
 *
 * The client never writes rows. It sends an intent ("open this election",
 * "cast this vote") and this module decides whether that is allowed, using the
 * server clock and the persisted lifecycle state. That is what makes the start
 * and end times, the one-vote rule, and the configuration lock real rather than
 * cosmetic: a modified client cannot talk to SQLite directly.
 */

import { randomBytes } from 'node:crypto'
import { checkPermissionOnly } from './authorize'
import { readSettings } from './settings'
import {
  consumeChallenge,
  findLiveChallenge,
  generateCode,
  issueChallenge,
  verifyChallenge,
  type ChallengeChannel,
} from './otp'
import {
  createSession as createVoterSession,
  noteSuspiciousVerification,
  resolveSession as resolveVoterSessionToken,
  revokeToken as revokeVoterToken,
} from './voterSession'
import {
  allowsControlledChanges,
  allowsStructuralEdits,
  checkPublishable,
  controlledChangeGuard,
  describeActions,
  effectiveStatus,
  hasScheduleDrift,
  isTerminalStatus,
  STATUS_LABELS,
  structuralEditGuard,
  transitionGuard,
  transitionTarget,
} from '../lib/lifecycle'
import {
  SPECIAL_OPTION_IDS,
  isSpecialOptionId,
  type ActionResult,
  type AuditEvent,
  type BallotOption,
  type BallotPreview,
  type BootstrapState,
  type CandidateWithTally,
  type Election,
  type ElectionSummary,
  type ElectionResults,
  type RedactedRollVoter,
  type RollVoterWithStatus,
  type TallyRow,
} from '../lib/types'
import {
  defaultEligibility,
  defaultRules,
  parseCandidateInput,
  parseCandidatePatch,
  parseElectionDraft,
  parseElectionId,
  parseElectionPatch,
  parseIdList,
  parseRollVoterBatch,
  parseRules,
  parseEligibility,
  ValidationError,
  type CandidateInput,
  type RollVoterInput,
} from '../lib/validate'
import { recordAudit } from './audit'
import {
  countParticipants,
  findParticipation,
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
import { recordSecurityEvent } from './security'
import type { AdminAccount, AdminSession } from '../lib/adminTypes'
import { countAdmins, pruneVoterSessions } from './auth'
import {
  execute,
  lastInsertId,
  queryAll,
  queryOne,
  queryScalar,
  text,
  transact,
  type SqlDatabase,
} from './db'
import {
  countCandidates,
  countBallotRows,
  countEligibleVoters,
  findEligibility,
  setEligibility,
  findCandidateRow,
  findElection,
  findElectionRow,
  findRollVoterRow,
  listAuditEvents,
  listCandidates,
  listElectionRows,
  listRollVoters,
  toCandidate,
  toElection,
} from './repository'
import { isValidTimeZone } from '../lib/time'

export type CommandContext = {
  database: SqlDatabase
  adminToken: string | null
  voterToken: string | null
  now: number
  /**
   * Show verification codes in the voter flow. Demonstration affordance only.
   *
   * On if the deployment was started with `ELECTION_DEMO_OTP=1` or an
   * administrator switched it on in settings; either way it puts a voter's code
   * on the wire to whoever asks, so system health reports it as degraded.
   */
  revealDemoCodes: boolean
  /** User agent, recorded against a voter session for later review. */
  userAgent?: string | null
  /**
   * Set by the transport. Mints or clears the voter session cookie.
   *
   * A session token must never appear in a command result, because a result is
   * serialised into the response body. Handing the token to the transport through
   * a side channel makes that structurally impossible rather than a rule to
   * remember: there is no path from a handler to the response that carries it.
   */
  setVoterSession?: (token: string | null) => void
  /**
   * The voting credential presented with this request, from its `HttpOnly` cookie.
   *
   * Read only by the ballot subsystem. It is a bearer right to cast one ballot, so
   * it is deliberately separate from the session: an authenticated voter with no
   * live credential may read their ballot but may not cast one.
   */
  voterCredential?: string | null
  /** Mints or clears the voting credential cookie. */
  setVoterCredential?: (token: string | null) => void
  /**
   * The receipt code this browser was issued, from its own `HttpOnly` cookie.
   *
   * Lets a voter see their receipt again after a reload. It is not a route to
   * anybody else's, because receipts are stored as a digest and this is the
   * browser's own.
   */
  voterReceipt?: string | null
  /** Mints or clears the receipt cookie. */
  setVoterReceipt?: (code: string | null) => void
  /** Location of the database file, needed to resolve the ballot integrity key. */
  databasePath: string
  /**
   * The session the dispatcher already resolved and authorised.
   *
   * Handlers must not re-resolve it: authorisation, elevation and the audit
   * record for a denial all happen once, centrally, before a handler runs.
   */
  session?: AdminSession | null
  /** Correlates this request with the audit trail and server logs. */
  requestId?: string
  ip?: string | null
}

const ok = <T>(value: T): ActionResult<T> => ({ ok: true, value })
const fail = <T = undefined>(code: string, error: string): ActionResult<T> => ({ ok: false, code, error })

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError('Expected an object payload.')
  }
  return value as Record<string, unknown>
}

/**
 * The administrator behind the current request.
 *
 * The dispatcher has already verified the session, the role permission and any
 * required elevation, so this only reads the resolved session rather than
 * repeating those checks.
 */
function requireAdmin(context: CommandContext): AdminAccount {
  if (!context.session) throw new CommandError('unauthorized', 'Sign in to continue.')
  return context.session.admin
}

export class CommandError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'CommandError'
  }
}

function guard<T>(work: () => T): T {
  try {
    return work()
  } catch (error) {
    if (error instanceof CommandError) throw error
    if (error instanceof ValidationError) throw new CommandError('invalid', error.message)
    throw error
  }
}

function loadElection(context: CommandContext, electionId: unknown): Election {
  const id = parseElectionId(electionId)
  const election = findElection(context.database, id)
  if (!election) throw new CommandError('not_found', 'That election does not exist.')
  return election
}

/**
 * Persist any drift between the stored status and the schedule.
 *
 * A scheduled poll opens itself when its start time passes and closes itself
 * when its end time passes. Materialising the change keeps the stored column
 * honest so administrators see the same state everyone else does.
 */
function reconcileElection(context: CommandContext, election: Election): Election {
  if (!hasScheduleDrift(election, context.now)) return election
  const effective = effectiveStatus(election, context.now)
  const now = new Date(context.now).toISOString()

  if (effective === 'open' && election.status === 'scheduled') {
    execute(
      context.database,
      "UPDATE elections SET status = 'open', ever_opened = 1, updated_at = ? WHERE id = ? AND status = 'scheduled'",
      [now, election.id],
    )
    recordAudit(context.database, {
      electionId: election.id,
      actorType: 'system',
      actorLabel: 'Schedule',
      action: 'auto_open',
      fromStatus: 'scheduled',
      toStatus: 'open',
      summary: 'Voting opened automatically at the scheduled start time.',
    })
  } else if (effective === 'closed' && (election.status === 'open' || election.status === 'paused' || election.status === 'scheduled')) {
    execute(
      context.database,
      "UPDATE elections SET status = 'closed', closed_at = ?, updated_at = ? WHERE id = ? AND status IN ('open','paused','scheduled')",
      [now, now, election.id],
    )
    recordAudit(context.database, {
      electionId: election.id,
      actorType: 'system',
      actorLabel: 'Schedule',
      action: 'auto_close',
      fromStatus: election.status,
      toStatus: 'closed',
      summary:
        election.status === 'scheduled'
          ? 'The scheduled window elapsed without the poll being opened, so it was closed.'
          : 'Voting closed automatically at the scheduled end time.',
    })
  }

  const refreshed = findElection(context.database, election.id)
  return refreshed ?? { ...election, status: effective }
}

export type ElectionCounts = {
  candidate_count: number
  approved_candidate_count: number
  eligible_count: number
  /**
   * People who have voted, from the participation table.
   *
   * This is the numerator of turnout, and it is kept apart from `ballot_count` on
   * purpose. Reading turnout off the ballots would mean reaching into the table
   * that holds selections to answer a question about how many *people* voted.
   */
  participant_count: number
  /** Anonymous ballots recorded. Not a count of votes: a ballot may carry several. */
  ballot_count: number
}

export function electionCounts(database: SqlDatabase, electionId: string): ElectionCounts {
  return {
    candidate_count: countCandidates(database, electionId, false),
    approved_candidate_count: countCandidates(database, electionId, true),
    eligible_count: countEligibleVoters(database, electionId),
    participant_count: countParticipants(database, electionId),
    ballot_count: countBallotRows(database, electionId),
  }
}

export function toElectionSummary(database: SqlDatabase, election: Election, now: number): ElectionSummary {
  const counts = electionCounts(database, election.id)
  const effective = effectiveStatus(election, now)
  return {
    id: election.id,
    title: election.title,
    description: election.description,
    election_type: election.election_type,
    timezone: election.timezone,
    starts_at: election.starts_at,
    ends_at: election.ends_at,
    status: election.status,
    effective_status: effective,
    schedule_drifted: election.status !== effective,
    rules: election.rules,
    eligibility: election.eligibility,
    created_at: election.created_at,
    updated_at: election.updated_at,
    published_at: election.published_at,
    closed_at: election.closed_at,
    certified_at: election.certified_at,
    archived_at: election.archived_at,
    ...counts,
    locked: !allowsStructuralEdits(election.status),
    edits_allowed: allowsStructuralEdits(election.status),
    status_changes_allowed: allowsControlledChanges(election.status) || allowsStructuralEdits(election.status),
    actions: describeActions(election, now),
  }
}

function nextElectionId(database: SqlDatabase, now: number): string {
  const year = new Date(now).getUTCFullYear()
  const prefix = `ELEC-${year}-`
  const existing = queryAll(
    database,
    'SELECT id FROM elections WHERE id LIKE ? ORDER BY id DESC LIMIT 1',
    [`${prefix}%`],
  )
  let sequence = 1
  if (existing.length > 0) {
    const suffix = Number(text(existing[0].id).slice(prefix.length))
    if (Number.isFinite(suffix)) sequence = suffix + 1
  }
  let candidate = `${prefix}${String(sequence).padStart(4, '0')}`
  let guard = 0
  while (findElectionRow(database, candidate) && guard < 10_000) {
    sequence += 1
    candidate = `${prefix}${String(sequence).padStart(4, '0')}`
    guard += 1
  }
  return candidate
}

export function buildPreview(database: SqlDatabase, election: Election, now: number): BallotPreview {
  const candidates = listCandidates(database, election.id)
  const counts = electionCounts(database, election.id)
  const summary = toElectionSummary(database, election, now)

  const options: BallotOption[] = candidates
    .filter((candidate) => candidate.status === 'approved')
    .map((candidate) => ({
      key: `candidate-${candidate.id}`,
      kind: 'candidate' as const,
      name: candidate.name,
      organization: candidate.organization,
      abbreviation: candidate.abbreviation,
      description: candidate.description,
      image_url: candidate.image_url,
      symbol: candidate.symbol,
      position: candidate.position,
      status: candidate.status,
    }))

  if (election.rules.allowNotA) {
    options.push({
      key: 'nota',
      kind: 'nota',
      name: 'None of the Above',
      organization: '',
      abbreviation: 'NOTA',
      description: 'I do not wish to vote for any of the candidates listed above.',
      image_url: '',
      symbol: '',
      position: options.length + 1,
      status: null,
    })
  }
  if (election.rules.allowAbstain) {
    options.push({
      key: 'abstain',
      kind: 'abstain',
      name: 'Abstain',
      organization: '',
      abbreviation: 'ABSTAIN',
      description: 'I wish to participate in this election but not express a preference.',
      image_url: '',
      symbol: '',
      position: options.length + 1,
      status: null,
    })
  }

  const check = checkPublishable({
    status: election.status,
    title: election.title,
    description: election.description,
    startsAt: election.starts_at,
    endsAt: election.ends_at,
    approvedCandidates: counts.approved_candidate_count,
    eligibleVoters: counts.eligible_count,
    requireOtp: election.rules.requireOtp,
    requirePhone: election.rules.requirePhone,
    requireEmail: election.rules.requireEmail,
    requireCompleteRoll: election.eligibility.mode === 'roll',
    now,
  })

  const blockers = [...check.blockers]
  if (election.rules.votesPerVoter > 1) {
    const selected = new Set(options.map((option) => option.key)).size
    if (selected < election.rules.votesPerVoter) {
      blockers.push(`Voters may choose ${election.rules.votesPerVoter} options but only ${selected} are available.`)
    }
  }
  if (election.status === 'draft') {
    // A draft is expected to be incomplete; do not present publish blockers as
    // errors until the administrator actually tries to publish.
    return {
      election: summary,
      options,
      rules: election.rules,
      warnings: check.warnings,
      blockers: [],
      ready_to_publish: blockers.length === 0,
    }
  }

  return {
    election: summary,
    options,
    rules: election.rules,
    warnings: check.warnings,
    blockers,
    ready_to_publish: blockers.length === 0,
  }
}

function buildTally(database: SqlDatabase, election: Election): { rows: TallyRow[]; total: number } {
  const candidates = listCandidates(database, election.id)
  // The one place selections are read out of storage, and it returns counts. A
  // tally is safe to publish because a total cannot be inverted back to a ballot.
  const { counts, total } = tallyBallots(database, election.id)

  const rows: TallyRow[] = candidates.map((candidate) => {
    const votes = counts.get(candidate.id) ?? 0
    return {
      key: `candidate-${candidate.id}`,
      kind: 'candidate' as const,
      name: candidate.name,
      organization: candidate.organization,
      position: candidate.position,
      votes,
      percentage: total ? (votes / total) * 100 : 0,
    }
  })

  for (const [id, kind] of [
    [SPECIAL_OPTION_IDS.nota, 'nota'],
    [SPECIAL_OPTION_IDS.abstain, 'abstain'],
  ] as const) {
    const votes = counts.get(id) ?? 0
    if (votes === 0) continue
    rows.push({
      key: kind,
      kind,
      name: kind === 'nota' ? 'None of the Above' : 'Abstain',
      organization: '',
      position: 900 + Math.abs(id),
      votes,
      percentage: total ? (votes / total) * 100 : 0,
    })
  }

  rows.sort((a, b) => a.position - b.position)
  return { rows, total }
}

function resultsVisibilityReason(election: Election, effective: Election['status']): string | null {
  switch (election.rules.resultsVisibility) {
    case 'live':
      return null
    case 'after_close':
      if (effective === 'closed' || effective === 'certified' || effective === 'archived') return null
      return 'Results are published once voting closes.'
    case 'after_certify':
      if (effective === 'certified' || effective === 'archived') return null
      return 'Results are published once the outcome has been certified.'
    case 'never':
      return 'Results for this election are not published.'
    default:
      return 'Results are not available.'
  }
}

export function buildResults(database: SqlDatabase, election: Election, now: number): ElectionResults {
  const effective = effectiveStatus(election, now)
  const { rows, total } = buildTally(database, election)
  const eligible = countEligibleVoterTotal(database, election.id)
  const hiddenReason = resultsVisibilityReason(election, effective)

  const sorted = [...rows].sort((a, b) => b.votes - a.votes || a.position - b.position)
  const top = sorted[0]
  const tied = top && top.votes > 0 && sorted.filter((row) => row.votes === top.votes).length > 1

  return {
    election_id: election.id,
    status: election.status,
    effective_status: effective,
    server_now: new Date(now).toISOString(),
    visible: hiddenReason === null,
    hidden_reason: hiddenReason ?? '',
    total_votes: total,
    eligible_count: eligible,
    turnout: eligible ? (countParticipantsTotal(database, election.id) / eligible) * 100 : 0,
    rows: hiddenReason === null ? rows : [],
    winner: hiddenReason === null && top && top.votes > 0 && !tied ? top : null,
    certified_at: election.certified_at,
  }
}

function countEligibleVoterTotal(database: SqlDatabase, electionId: string): number {
  return countEligibleVoters(database, electionId)
}

/**
 * Turnout, counted from participation rather than from ballots.
 *
 * These two numbers are not the same, and the difference is the point: ballots
 * counts ballots cast, participation counts people who have voted. Reading
 * turnout from ballots would have meant reaching for a table that holds
 * selections whenever somebody wanted to know how many people had voted.
 */
function countParticipantsTotal(database: SqlDatabase, electionId: string): number {
  return countParticipants(database, electionId)
}

type VoterIdentity = {
  election: Election
  voter: RollVoterWithStatus
}

/**
 * Resolve the caller's voter identity for one election.
 *
 * The token is compared against a stored hash, and the session is only honoured
 * while it is neither expired, nor idle, nor revoked. A token belonging to a
 * different poll never matches, so a session cannot be carried across elections.
 */
function resolveVoterSession(context: CommandContext, electionId: string): VoterIdentity | null {
  const resolved = resolveVoterSessionToken(context.database, {
    token: context.voterToken,
    electionId,
    now: context.now,
  })
  if (!resolved.ok) {
    if (resolved.state === 'revoked') {
      // A revoked token being presented is either a stale tab or a replay. It is
      // worth recording, because it is not something a legitimate client does.
      recordSecurityEvent(context.database, {
        kind: 'voter_session_replayed',
        severity: 'warning',
        summary: 'A revoked voter session was presented and refused.',
        adminId: null,
        adminLabel: 'unknown',
        ip: context.ip ?? null,
        detail: { election_id: electionId },
      })
    }
    return null
  }
  const voters = listRollVoters(context.database, electionId)
  const voter = voters.find((item) => item.id === resolved.session.voterRecordId)
  if (!voter) return null
  const election = findElection(context.database, electionId)
  if (!election) return null
  return { election, voter }
}

function maskPhone(phone: string): string {
  if (phone.length <= 4) return '•'.repeat(phone.length)
  return `${phone.slice(0, 2)}${'•'.repeat(Math.max(3, phone.length - 4))}${phone.slice(-2)}`
}

function maskEmail(email: string): string {
  const at = email.indexOf('@')
  if (at <= 0) return '•'.repeat(Math.min(6, email.length))
  const domain = email.slice(at)
  const visible = domain.slice(0, 1)
  return `${email.slice(0, 1)}${'•'.repeat(Math.max(2, at - 1))}@${visible}${domain.slice(1)}`
}

/**
 * Decide what a roll record is allowed to contain on its way out of the server.
 *
 * This is the single choke point for voter personal data, so the rule is stated
 * once and applied everywhere rather than repeated per call site. The record is
 * built field by field rather than spread, so a column added to `roll_voters`
 * later cannot leak by default — it has to be added here deliberately.
 *
 * - There is no code on a roll record to leak. One-time codes are generated per
 *   attempt in `voter_challenges`, stored only as a salted hash, and consumed on
 *   first use; the roll holds contacts and nothing replayable. What the roll can
 *   report is whether a code *could* be delivered on each channel, which is what
 *   an operator needs in order to spot a voter who will fail verification.
 * - Names, phone numbers, email addresses and the external grouping reference are
 *   withheld unless the caller holds `voter.view_pii`.
 * - The identifier, eligibility and participation are always returned, because
 *   they are what an election officer actually administers with.
 */
/*
 * Voter verification.
 *
 * The functions below build the response shapes for `voter.begin`. They are kept
 * in one place, and side by side, because the property that matters is that the
 * "not on the roll" answer and the real answer are the *same* answer — drift
 * between them is exactly how a roll gets enumerated.
 */

/**
 * The channels this voter must answer for, given the election's rules and what
 * the roll actually holds.
 *
 * A channel the rules require but that has no contact on file cannot be answered,
 * so it is not counted: a voter with no email on an election that nominally
 * requires one is not permanently locked out by a channel that could never have
 * been issued. `voter.begin` refuses such a voter up front instead, so this list
 * is never silently narrower than what the voter was told to expect.
 */
function requiredChannels(election: Election, voter: RollVoterWithStatus): ChallengeChannel[] {
  const channels: ChallengeChannel[] = []
  if (election.rules.requirePhone && voter.phone.trim() !== '') channels.push('phone')
  if (election.rules.requireEmail && voter.email.trim() !== '') channels.push('email')
  return channels
}

/** A code entry slot. Carries no hint about whether the voter is registered. */
type BeginChallenge = {
  channel: ChallengeChannel
  challenge_id: string
  expires_in: number
  /**
   * How many digits this code has, so the field can be sized to fit it.
   *
   * This is a property of the election's settings, identical for every voter, so
   * disclosing it says nothing about who is registered. It has to be sent because
   * guessing it wrong makes the field silently refuse the code it was given.
   */
  digits: number
}

/**
 * The channels this election asks for, taken from its rules alone.
 *
 * Deliberately independent of any individual voter: the number of slots in the
 * response must be the same for everyone, or the count itself discloses which
 * contacts a particular voter has on file.
 */
function electionChannels(election: Election): ChallengeChannel[] {
  const channels: ChallengeChannel[] = []
  if (election.rules.requirePhone) channels.push('phone')
  if (election.rules.requireEmail) channels.push('email')
  return channels
}

/** A handle that looks real and resolves to nothing. */
function decoyChallengeId(): string {
  return randomBytes(16).toString('base64url')
}

/** An election that asks for a code, answered for a real voter and for nobody. */
function beginWithChallenges(
  context: CommandContext,
  election: Election,
  found: RollVoterWithStatus | null,
  now: number,
) {
  const channels = electionChannels(election)

  /*
   * Fail closed on a misconfigured election.
   *
   * "Requires a code" with no channel to send one on would leave a voter with
   * nothing to prove and nothing to answer, and a verification that requires
   * nothing would pass for anybody. Refusing beats a poll that any identifier
   * can walk into.
   */
  if (!channels.length) {
    return {
      failure: 'This election is set to require a verification code but has no channel configured to send one.',
      failureCode: 'invalid' as const,
    }
  }

  const policy = challengePolicy(context)
  const eligible = found && found.is_eligible === 1 ? found : null
  const challenges: BeginChallenge[] = []
  const demoCodes: Partial<Record<ChallengeChannel, string>> = {}

  for (const channel of channels) {
    const destination = eligible ? (channel === 'phone' ? eligible.phone : eligible.email) : ''
    if (destination) {
      /*
       * In development the code is shown on screen, so the resend cooldown is
       * bypassed — otherwise a voter who mistypes an identifier cannot get a
       * working code without waiting. This is safe to do only because the
       * development build already hands out codes, so it discloses nothing that
       * the demonstration does not already disclose.
       */
      const issued = issueChallenge(context.database, {
        electionId: election.id,
        voterRecordId: eligible!.id,
        channel,
        destination,
        policy: context.revealDemoCodes ? { ...policy, resendCooldownSeconds: 0 } : policy,
        now,
      })
      if (issued.ok) {
        challenges.push({ channel, challenge_id: issued.challenge.id, expires_in: policy.ttlSeconds, digits: policy.digits })
        if (context.revealDemoCodes) demoCodes[channel] = issued.code
        continue
      }
      /*
       * Within the resend cooldown, or no contact on file for a channel the rules
       * require. Neither may change the shape of the reply: a cooldown error is
       * only ever returned to a real voter, so surfacing it would disclose roll
       * membership. A slot with a handle that resolves to nothing is returned
       * instead, and the attempt simply fails to verify.
       */
    }
    challenges.push({ channel, challenge_id: decoyChallengeId(), expires_in: policy.ttlSeconds, digits: policy.digits })
    if (context.revealDemoCodes) demoCodes[channel] = generateCode(policy.digits)
  }

  if (eligible) {
    noteSuspiciousVerification(context.database, {
      electionId: election.id,
      voterRecordId: eligible.id,
      voterLabel: eligible.voter_id,
      ip: context.ip ?? null,
      now,
    })
  }

  return {
    election: toElectionSummary(context.database, election, now),
    // Deliberately null even for a real voter. The identity is confirmed at
    // `voter.verify`, once the server has proof, rather than here, where all the
    // caller has done is type a string.
    voter: null,
    requires_code: true,
    challenges,
    demo_codes: context.revealDemoCodes ? demoCodes : null,
  }
}

/** An election that asks for no code, where the roll cannot be concealed. */
function beginWithoutCode(context: CommandContext, election: Election, found: RollVoterWithStatus, now: number) {
  return {
    election: toElectionSummary(context.database, election, now),
    voter: {
      voter_id: found.voter_id,
      full_name: found.full_name,
      masked_phone: maskPhone(found.phone),
      masked_email: maskEmail(found.email),
      group: found.external_ref,
    },
    requires_code: false,
    challenges: [] as BeginChallenge[],
    demo_codes: null,
  }
}

/**
 * How long a voting credential stays usable.
 *
 * Kept separate from the session lifetime on purpose. A session says who somebody
 * is and may reasonably last hours; a credential is a right to cast one ballot, and
 * the shorter it lives the less a stolen cookie is worth.
 */
function credentialTtl(context: CommandContext): number {
  return readSettings(context.database).credentialTtlSeconds
}

/** The OTP policy, read from platform settings on every call. */
function challengePolicy(context: CommandContext) {  const settings = readSettings(context.database)
  return {
    ttlSeconds: settings.otpTtlSeconds,
    maxAttempts: settings.otpMaxAttempts,
    lockoutSeconds: settings.otpLockoutSeconds,
    resendCooldownSeconds: settings.otpResendCooldownSeconds,
    digits: settings.otpDigits,
  }
}

function redactRollVoter(voter: RollVoterWithStatus, maySeePersonalData: boolean): RedactedRollVoter {
  return {
    id: voter.id,
    election_id: voter.election_id,
    voter_id: voter.voter_id,
    full_name: maySeePersonalData ? voter.full_name : '',
    phone: maySeePersonalData ? voter.phone : '',
    email: maySeePersonalData ? voter.email : '',
    external_ref: maySeePersonalData ? voter.external_ref : '',
    is_eligible: voter.is_eligible,
    has_voted: voter.has_voted,
    // Whether a code *could* be delivered here. There is no stored code to
    // report, and no code to leak.
    can_verify_by_phone: voter.phone.trim().length > 0,
    can_verify_by_email: voter.email.trim().length > 0,
    created_at: voter.created_at,
  }
}

export type CommandName =
  | 'state.get'
  | 'admin.bootstrap'
  | 'admin.login'
  | 'admin.logout'
  | 'admin.list'
  | 'admin.create'
  | 'election.list'
  | 'election.get'
  | 'election.roll'
  | 'election.participation'
  | 'election.participation.clear'
  | 'election.create'
  | 'election.update'
  | 'election.setRules'
  | 'election.setEligibility'
  | 'election.delete'
  | 'election.candidate.add'
  | 'election.candidate.update'
  | 'election.candidate.setStatus'
  | 'election.candidate.remove'
  | 'election.candidate.reorder'
  | 'election.voters.add'
  | 'election.voters.remove'
  | 'election.voters.setEligibility'
  | 'election.preview'
  | 'election.transition'
  | 'election.results'
  | 'election.audit'
  | 'voter.begin'
  | 'voter.verify'
  | 'voter.logout'
  | 'voter.ballot'
  | 'voter.vote'
  | 'voter.receipt'
  | 'voter.credential'

export async function dispatch(
  context: CommandContext,
  command: CommandName,
  payload: unknown,
): Promise<ActionResult<unknown>> {
  try {
    return await guard(() => run(context, command, payload))
  } catch (error) {
    if (error instanceof CommandError) return fail(error.code, error.message)
    if (error instanceof ValidationError) return fail('invalid', error.message)
    return fail('internal', (error as Error)?.message ?? 'Unexpected server error.')
  }
}

function run(context: CommandContext, command: CommandName, payload: unknown): ActionResult<unknown> {
  const database = context.database
  const now = context.now

  switch (command) {
    case 'state.get': {
      const session = context.session ?? null
      const rows = listElectionRows(database, true)
      const elections = rows.map((row) => {
        const election = toElection(row)
        return toElectionSummary(database, election, now)
      })
      return ok({
        server_now: new Date(now).toISOString(),
        elections,
        admins_exist: countAdmins(database) > 0,
        session,
      } satisfies BootstrapState)
    }

    case 'election.list': {
      const body = (payload ?? {}) as Record<string, unknown>
      const includeArchived = body.includeArchived === true
      const rows = listElectionRows(database, includeArchived)
      return ok({
        elections: rows.map((row) => toElectionSummary(database, toElection(row), now)),
      })
    }

    case 'election.get': {
      // Public, because the voter portal needs it before anyone authenticates.
      //
      // It therefore returns *only* what a voter is entitled to see: the
      // election's public description and schedule, the ballot options, and the
      // publish-readiness preview. The voter roll is deliberately absent — it holds
      // names and the contact details a verification code is delivered to, and is
      // served by `election.roll`, which requires an administrator session.
      // Keeping the two reads apart is what stops a public endpoint from becoming a
      // way to download the roll and receive somebody else's code.
      const body = record(payload)
      const election = reconcileElection(context, loadElection(context, body.electionId))
      return ok({
        election: toElectionSummary(database, election, now),
        candidates: listCandidates(database, election.id),
        preview: buildPreview(database, election, now),
      })
    }

    case 'election.roll': {
      // The voter roll, for administrators only.
      //
      // Two permissions are checked here rather than one, because the record has
      // two levels of sensitivity: an operator needs to see that a voter is on the
      // roll and whether they have voted, but the name and the phone and email a
      // code is sent to are personal data. Holding `voter.view` is not enough to
      // receive them.
      const body = record(payload)
      const election = loadElection(context, body.electionId)
      const roll = listRollVoters(database, election.id)
      // The dispatcher has already enforced `voter.view` for this command. This
      // is the second, stricter check, and it reuses the same gate rather than
      // reading the role directly, so there is one implementation of "does this
      // session hold this permission".
      const maySeePersonalData = checkPermissionOnly({
        database,
        session: context.session ?? null,
        permission: 'voter.view_pii',
        action: 'election.roll',
        resource: election.id,
        requestId: context.requestId ?? '',
        ip: context.ip ?? null,
        now: context.now,
      }).ok
      return ok({
        roll: roll.map((voter) => redactRollVoter(voter, maySeePersonalData)),
        can_view_personal_data: maySeePersonalData,
      })
    }

    case 'election.create': {
      const admin = requireAdmin(context)
      const draft = parseElectionDraft(payload)
      const id = nextElectionId(database, now)
      const iso = new Date(now).toISOString()
      transact(database, () => {
        execute(
          database,
          `INSERT INTO elections (id, title, description, election_type, timezone, starts_at, ends_at,
            status, rules, eligibility, ever_opened, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, 0, ?, ?, ?)`,
          [
            id,
            draft.title,
            draft.description,
            draft.election_type,
            draft.timezone,
            draft.starts_at,
            draft.ends_at,
            JSON.stringify(draft.rules),
            JSON.stringify(draft.eligibility),
            admin.id,
            iso,
            iso,
          ],
        )
      })
      const election = findElection(database, id)!
      recordAudit(database, {
        electionId: id,
        actorType: 'admin',
        actorId: admin.id,
        actorLabel: admin.display_name,
        action: 'election_created',
        toStatus: 'draft',
        summary: `Election "${draft.title}" was created as a draft.`,
        detail: { election_type: draft.election_type, timezone: draft.timezone },
      })
      return ok({ election: toElectionSummary(database, election, now) })
    }

    case 'election.update': {
      const admin = requireAdmin(context)
      const body = record(payload)
      const election = loadElection(context, body.electionId)
      const guardMessage = structuralEditGuard(election.status)
      if (guardMessage) return fail('election_locked', guardMessage)

      const patch = parseElectionPatch(body.patch ?? body.changes)
      const sets: string[] = []
      const params: unknown[] = []
      const assign = (column: string, value: unknown) => {
        sets.push(`${column} = ?`)
        params.push(value)
      }

      if (patch.title !== undefined) assign('title', patch.title)
      if (patch.description !== undefined) assign('description', patch.description)
      if (patch.election_type !== undefined) assign('election_type', patch.election_type)
      if (patch.timezone !== undefined) assign('timezone', patch.timezone)
      if (patch.starts_at !== undefined) assign('starts_at', patch.starts_at)
      if (patch.ends_at !== undefined) assign('ends_at', patch.ends_at)
      if (patch.rules !== undefined) assign('rules', JSON.stringify(patch.rules))
      if (patch.eligibility !== undefined) assign('eligibility', JSON.stringify(patch.eligibility))

      const startsAt = patch.starts_at ?? election.starts_at
      const endsAt = patch.ends_at ?? election.ends_at
      if (Date.parse(endsAt) <= Date.parse(startsAt)) {
        return fail('invalid', 'The scheduled end time must be after the start time.')
      }

      sets.push('updated_at = ?')
      params.push(new Date(now).toISOString(), election.id)
      execute(database, `UPDATE elections SET ${sets.join(', ')} WHERE id = ?`, params)

      const updated = findElection(database, election.id)!
      recordAudit(database, {
        electionId: election.id,
        actorType: 'admin',
        actorId: admin.id,
        actorLabel: admin.display_name,
        action: 'election_updated',
        fromStatus: election.status,
        toStatus: updated.status,
        summary: `Election settings were updated (${Object.keys(patch).join(', ')}).`,
        detail: patch as unknown as Record<string, unknown>,
      })
      return ok({ election: toElectionSummary(database, updated, now) })
    }

    case 'election.setRules': {
      const admin = requireAdmin(context)
      const body = record(payload)
      const election = loadElection(context, body.electionId)
      const guardMessage = structuralEditGuard(election.status)
      if (guardMessage) return fail('election_locked', guardMessage)
      const rules = parseRules(body.rules)
      const previous = election.rules
      execute(database, 'UPDATE elections SET rules = ?, updated_at = ? WHERE id = ?', [
        JSON.stringify(rules),
        new Date(now).toISOString(),
        election.id,
      ])
      recordAudit(database, {
        electionId: election.id,
        actorType: 'admin',
        actorId: admin.id,
        actorLabel: admin.display_name,
        action: 'rules_updated',
        summary: 'Voting rules were changed.',
        detail: { before: previous, after: rules },
      })
      const updated = findElection(database, election.id)!
      return ok({ election: toElectionSummary(database, updated, now) })
    }

    case 'election.setEligibility': {
      const admin = requireAdmin(context)
      const body = record(payload)
      const election = loadElection(context, body.electionId)
      const guardMessage = structuralEditGuard(election.status)
      if (guardMessage) return fail('election_locked', guardMessage)
      const eligibility = parseEligibility(body.eligibility)
      execute(database, 'UPDATE elections SET eligibility = ?, updated_at = ? WHERE id = ?', [
        JSON.stringify(eligibility),
        new Date(now).toISOString(),
        election.id,
      ])
      recordAudit(database, {
        electionId: election.id,
        actorType: 'admin',
        actorId: admin.id,
        actorLabel: admin.display_name,
        action: 'eligibility_updated',
        summary: `Eligibility requirements were changed (mode: ${eligibility.mode}).`,
        detail: { before: election.eligibility, after: eligibility },
      })
      const updated = findElection(database, election.id)!
      return ok({ election: toElectionSummary(database, updated, now) })
    }

    case 'election.delete': {
      const admin = requireAdmin(context)
      const body = record(payload)
      const election = loadElection(context, body.electionId)
      if (election.status !== 'draft') {
        return fail('forbidden', 'Only a draft election can be deleted. Archive it instead to keep the record.')
      }
      if (countBallotRows(database, election.id) > 0) {
        return fail('forbidden', 'This election already has votes recorded against it.')
      }
      transact(database, () => {
        // Ballots and participation first: they reference the roll by id, and a
        // draft election should hold neither, but the order keeps that explicit.
        execute(database, 'DELETE FROM receipts WHERE election_id = ?', [election.id])
        execute(database, 'DELETE FROM ballots WHERE election_id = ?', [election.id])
        execute(database, 'DELETE FROM participation WHERE election_id = ?', [election.id])
        execute(database, 'DELETE FROM voting_credentials WHERE election_id = ?', [election.id])
        execute(database, 'DELETE FROM eligibility WHERE election_id = ?', [election.id])
        execute(database, 'DELETE FROM voter_sessions WHERE election_id = ?', [election.id])
        execute(database, 'DELETE FROM roll_voters WHERE election_id = ?', [election.id])
        execute(database, 'DELETE FROM candidates WHERE election_id = ?', [election.id])
        execute(database, 'DELETE FROM elections WHERE id = ?', [election.id])
      })
      recordAudit(database, {
        electionId: null,
        actorType: 'admin',
        actorId: admin.id,
        actorLabel: admin.display_name,
        action: 'election_deleted',
        summary: `Draft election "${election.title}" (${election.id}) was deleted.`,
        detail: { election_id: election.id, title: election.title },
      })
      return ok({ deleted: election.id })
    }

    case 'election.candidate.add': {
      const admin = requireAdmin(context)
      const body = record(payload)
      const election = loadElection(context, body.electionId)
      const guardMessage = structuralEditGuard(election.status)
      if (guardMessage) return fail('election_locked', guardMessage)
      const existing = countCandidates(database, election.id, false)
      if (existing >= 200) return fail('invalid', 'An election may have at most 200 ballot options.')
      const input: CandidateInput = parseCandidateInput(body.candidate ?? payload, existing)
      const iso = new Date(now).toISOString()
      const id = transact(database, () => {
        execute(
          database,
          `INSERT INTO candidates (election_id, name, organization, abbreviation, description,
            image_url, symbol, position, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            election.id,
            input.name,
            input.organization,
            input.abbreviation,
            input.description,
            input.image_url,
            input.symbol,
            input.position,
            input.status,
            iso,
            iso,
          ],
        )
        return lastInsertId(database)
      })
      recordAudit(database, {
        electionId: election.id,
        actorType: 'admin',
        actorId: admin.id,
        actorLabel: admin.display_name,
        action: 'candidate_added',
        summary: `Candidate "${input.name}" was added at position ${input.position}.`,
        detail: input as unknown as Record<string, unknown>,
      })
      return ok({ candidate: toCandidate(findCandidateRow(database, election.id, id)!) })
    }

    case 'election.candidate.update': {
      const admin = requireAdmin(context)
      const body = record(payload)
      const election = loadElection(context, body.electionId)
      const candidateId = Number(body.candidateId)
      if (!Number.isSafeInteger(candidateId) || candidateId <= 0) return fail('invalid', 'Invalid candidate.')
      const row = findCandidateRow(database, election.id, candidateId)
      if (!row) return fail('not_found', 'That candidate is not part of this election.')

      const patch = parseCandidatePatch(body.patch ?? body.changes)
      const guardMessage =
        'status' in patch && Object.keys(patch).length === 1
          ? controlledChangeGuard(election.status)
          : structuralEditGuard(election.status)
      if (guardMessage) return fail('election_locked', guardMessage)

      const sets: string[] = []
      const params: unknown[] = []
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) continue
        sets.push(`${key} = ?`)
        params.push(value)
      }
      sets.push('updated_at = ?')
      params.push(new Date(now).toISOString(), election.id, candidateId)
      execute(database, `UPDATE candidates SET ${sets.join(', ')} WHERE election_id = ? AND id = ?`, params)

      const before = toCandidate(row)
      const after = toCandidate(findCandidateRow(database, election.id, candidateId)!)
      recordAudit(database, {
        electionId: election.id,
        actorType: 'admin',
        actorId: admin.id,
        actorLabel: admin.display_name,
        action: 'candidate_updated',
        summary: `Candidate "${after.name}" was updated.`,
        detail: { before, after, changed: Object.keys(patch) },
      })
      return ok({ candidate: after })
    }

    case 'election.candidate.setStatus': {
      const admin = requireAdmin(context)
      const body = record(payload)
      const election = loadElection(context, body.electionId)
      const guardMessage = controlledChangeGuard(election.status)
      if (guardMessage) return fail('election_locked', guardMessage)
      const candidateId = Number(body.candidateId)
      if (!Number.isSafeInteger(candidateId) || candidateId <= 0) return fail('invalid', 'Invalid candidate.')
      const status = String(body.status ?? '')
      if (!['approved', 'withdrawn', 'disqualified', 'draft'].includes(status)) {
        return fail('invalid', 'Unknown candidate status.')
      }
      const row = findCandidateRow(database, election.id, candidateId)
      if (!row) return fail('not_found', 'That candidate is not part of this election.')
      execute(
        database,
        'UPDATE candidates SET status = ?, updated_at = ? WHERE election_id = ? AND id = ?',
        [status, new Date(now).toISOString(), election.id, candidateId],
      )
      const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 300) : ''
      recordAudit(database, {
        electionId: election.id,
        actorType: 'admin',
        actorId: admin.id,
        actorLabel: admin.display_name,
        action: 'candidate_status_changed',
        summary: `Candidate "${toCandidate(row).name}" was marked ${status}${reason ? `: ${reason}` : '.'}`,
        detail: { candidate_id: candidateId, from: text(row.status), to: status, reason },
      })
      return ok({ candidate: toCandidate(findCandidateRow(database, election.id, candidateId)!) })
    }

    case 'election.candidate.remove': {
      const admin = requireAdmin(context)
      const body = record(payload)
      const election = loadElection(context, body.electionId)
      const guardMessage = structuralEditGuard(election.status)
      if (guardMessage) return fail('election_locked', guardMessage)
      const candidateId = Number(body.candidateId)
      if (!Number.isSafeInteger(candidateId) || candidateId <= 0) return fail('invalid', 'Invalid candidate.')
      const row = findCandidateRow(database, election.id, candidateId)
      if (!row) return fail('not_found', 'That candidate is not part of this election.')
      // Whether this option has been voted for is a question for the tally, which
      // counts ballots. There is no per-option row to count any more.
      const votesFor = tallyBallots(database, election.id).counts.get(candidateId) ?? 0
      if (votesFor > 0) {
        return fail('forbidden', 'Votes have already been recorded for this candidate, so they cannot be removed. Mark them withdrawn or disqualified instead.')
      }
      execute(database, 'DELETE FROM candidates WHERE election_id = ? AND id = ?', [election.id, candidateId])
      recordAudit(database, {
        electionId: election.id,
        actorType: 'admin',
        actorId: admin.id,
        actorLabel: admin.display_name,
        action: 'candidate_removed',
        summary: `Candidate "${toCandidate(row).name}" was removed from the ballot.`,
        detail: { candidate_id: candidateId, name: toCandidate(row).name },
      })
      return ok({ removed: candidateId })
    }

    case 'election.candidate.reorder': {
      const admin = requireAdmin(context)
      const body = record(payload)
      const election = loadElection(context, body.electionId)
      const guardMessage = structuralEditGuard(election.status)
      if (guardMessage) return fail('election_locked', guardMessage)
      const order = parseIdList(body.order, 'Ballot order', 200)
      const existing = listCandidates(database, election.id).map((candidate) => candidate.id)
      if (order.length !== existing.length) {
        return fail('invalid', 'The new order must list every candidate exactly once.')
      }
      if (new Set(order).size !== order.length || order.some((id) => !existing.includes(id))) {
        return fail('invalid', 'The new order must list every candidate exactly once.')
      }
      transact(database, () => {
        order.forEach((candidateId, index) => {
          execute(
            database,
            'UPDATE candidates SET position = ?, updated_at = ? WHERE election_id = ? AND id = ?',
            [index + 1, new Date(now).toISOString(), election.id, candidateId],
          )
        })
      })
      recordAudit(database, {
        electionId: election.id,
        actorType: 'admin',
        actorId: admin.id,
        actorLabel: admin.display_name,
        action: 'ballot_reordered',
        summary: `Ballot order was changed for ${order.length} options.`,
        detail: { order },
      })
      return ok({ candidates: listCandidates(database, election.id) })
    }

    case 'election.voters.add': {
      const admin = requireAdmin(context)
      const body = record(payload)
      const election = loadElection(context, body.electionId)
      const guardMessage = structuralEditGuard(election.status)
      if (guardMessage) return fail('election_locked', guardMessage)
      const voters: RollVoterInput[] = parseRollVoterBatch(body.voters)
      const total = countEligibleVoters(database, election.id) + voters.length
      if (total > 20_000) return fail('invalid', 'An election may have at most 20,000 eligible voters.')

      const iso = new Date(now).toISOString()
      const duplicates: string[] = []
      transact(database, () => {
        for (const voter of voters) {
          const existing = findRollVoterRow(database, election.id, voter.voter_id)
          if (existing) {
            duplicates.push(voter.voter_id)
            continue
          }
          execute(
            database,
            `INSERT INTO roll_voters (election_id, voter_id, full_name, phone, email, external_ref, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [election.id, voter.voter_id, voter.full_name, voter.phone, voter.email, voter.external_ref, iso],
          )
          const recordId = lastInsertId(database)
          // Eligibility is a separate decision, written next to the identity rather
          // than inside it, and attributable.
          setEligibility(database, {
            electionId: election.id,
            voterRecordId: recordId,
            eligible: voter.is_eligible === 1,
            reason: 'imported with the roll',
            decidedBy: admin.display_name,
            now,
          })
        }
      })
      recordAudit(database, {
        electionId: election.id,
        actorType: 'admin',
        actorId: admin.id,
        actorLabel: admin.display_name,
        action: 'voters_added',
        summary: `${voters.length - duplicates.length} voter(s) were added to the roll.`,
        detail: { added: voters.length - duplicates.length, skipped: duplicates },
      })
      return ok({ added: voters.length - duplicates.length, skipped: duplicates, roll: listRollVoters(database, election.id) })
    }

    case 'election.voters.remove': {
      const admin = requireAdmin(context)
      const body = record(payload)
      const election = loadElection(context, body.electionId)
      const guardMessage = structuralEditGuard(election.status)
      if (guardMessage) return fail('election_locked', guardMessage)
      const ids = parseIdList(body.voterRecordIds, 'Voter records', 500)
      const removed: string[] = []
      transact(database, () => {
        for (const id of ids) {
          const row = queryOne(database, 'SELECT * FROM roll_voters WHERE election_id = ? AND id = ?', [election.id, id])
          if (!row) continue
          const participated = queryScalar(
            database,
            'SELECT COUNT(*) AS total FROM participation WHERE election_id = ? AND voter_record_id = ?',
            [election.id, id],
          )
          if (participated > 0) {
            // They have already voted, so the ballot has to stay and the person has to
            // stay too — there is nothing to detach a ballot from, which is the point.
            // Withdrawing their eligibility is the honest response: it changes who may
            // still vote, and leaves the recorded participation intact.
            setEligibility(database, {
              electionId: election.id,
              voterRecordId: id,
              eligible: false,
              reason: 'Removed from the roll after voting',
              decidedBy: admin.display_name,
              now,
            })
            continue
          }
          execute(database, 'DELETE FROM voter_sessions WHERE election_id = ? AND voter_record_id = ?', [election.id, id])
          execute(database, 'DELETE FROM roll_voters WHERE election_id = ? AND id = ?', [election.id, id])
          removed.push(text(row.voter_id))
        }
      })
      recordAudit(database, {
        electionId: election.id,
        actorType: 'admin',
        actorId: admin.id,
        actorLabel: admin.display_name,
        action: 'voters_removed',
        summary: `${removed.length} voter(s) were removed from the roll.`,
        detail: { removed },
      })
      return ok({ removed: removed.length, roll: listRollVoters(database, election.id) })
    }

    case 'election.voters.setEligibility': {
      const admin = requireAdmin(context)
      const body = record(payload)
      const election = loadElection(context, body.electionId)
      const guardMessage = structuralEditGuard(election.status)
      if (guardMessage) return fail('election_locked', guardMessage)
      const ids = parseIdList(body.voterRecordIds, 'Voter records', 500)
      const eligible = body.eligible === true
      const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 200) : ''
      transact(database, () => {
        for (const id of ids) {
          // Changing eligibility never touches a ballot. Somebody who has already
          // voted keeps the record of having voted; what changes is whether they
          // could vote, which is a separate fact about a separate table.
          setEligibility(database, {
            electionId: election.id,
            voterRecordId: id,
            eligible,
            reason,
            decidedBy: admin.display_name,
            now,
          })
        }
      })
      recordAudit(database, {
        electionId: election.id,
        actorType: 'admin',
        actorId: admin.id,
        actorLabel: admin.display_name,
        action: 'voter_eligibility_changed',
        summary: `${ids.length} voter(s) were marked ${eligible ? 'eligible' : 'ineligible'}.`,
        detail: { count: ids.length, eligible: Boolean(eligible) },
      })
      return ok({ updated: ids.length, roll: listRollVoters(database, election.id) })
    }

    case 'election.preview': {
      const body = record(payload)
      const election = reconcileElection(context, loadElection(context, body.electionId))
      return ok({ preview: buildPreview(database, election, now) })
    }

    case 'election.transition': {
      const admin = requireAdmin(context)
      const body = record(payload)
      const election = reconcileElection(context, loadElection(context, body.electionId))
      const action = String(body.action ?? '') as never
      const target = transitionTarget(election.status, action)
      if (!target) {
        return fail(
          'invalid_transition',
          `Cannot ${String(body.action ?? 'perform that action')} on an election that is ${STATUS_LABELS[election.status]}.`,
        )
      }
      const guardMessage = transitionGuard(election, action, now)
      if (guardMessage) return fail('invalid_transition', guardMessage)

      if (action === 'publish') {
        const check = checkPublishable({
          status: election.status,
          title: election.title,
          description: election.description,
          startsAt: election.starts_at,
          endsAt: election.ends_at,
          approvedCandidates: countCandidates(database, election.id, true),
          eligibleVoters: countEligibleVoters(database, election.id),
          requireOtp: election.rules.requireOtp,
          requirePhone: election.rules.requirePhone,
          requireEmail: election.rules.requireEmail,
          requireCompleteRoll: election.eligibility.mode === 'roll',
          now,
        })
        if (check.blockers.length > 0) {
          return fail('incomplete', check.blockers.join(' '))
        }
      }

      const iso = new Date(now).toISOString()
      const note = typeof body.note === 'string' ? body.note.trim().slice(0, 300) : ''
      transact(database, () => {
        const sets = ['status = ?', 'updated_at = ?']
        const params: unknown[] = [target, iso]
        if (target === 'scheduled') {
          sets.push('published_at = ?', 'published_by = ?')
          params.push(iso, admin.id)
        }
        if (action === 'open') {
          sets.push('ever_opened = 1')
        }
        if (target === 'closed' && !election.closed_at) {
          sets.push('closed_at = ?', 'closed_by = ?')
          params.push(iso, admin.id)
        }
        if (target === 'certified') {
          sets.push('certified_at = ?', 'certified_by = ?')
          params.push(iso, admin.id)
        }
        if (target === 'archived') {
          sets.push('archived_at = ?', 'archived_by = ?')
          params.push(iso, admin.id)
        }
        params.push(election.id)
        execute(database, `UPDATE elections SET ${sets.join(', ')} WHERE id = ?`, params)
      })

      pruneVoterSessions(database, election.id)
      recordAudit(database, {
        electionId: election.id,
        actorType: 'admin',
        actorId: admin.id,
        actorLabel: admin.display_name,
        action: `election_${action}`,
        fromStatus: election.status,
        toStatus: target,
        summary: `${admin.display_name} moved the election from ${STATUS_LABELS[election.status]} to ${STATUS_LABELS[target]}.${note ? ` Note: ${note}` : ''}`,
        detail: { action, note, ballots_at_transition: countBallotRows(database, election.id) },
      })

      const updated = findElection(database, election.id)!
      return ok({ election: toElectionSummary(database, updated, now) })
    }

    case 'election.participation': {
      /*
       * Voter participation, with no selections anywhere in the response.
       *
       * This is the report an election officer actually needs — who turned out, who
       * has not, who was excluded — and it is built from `roll_voters`, `eligibility`
       * and `participation` only. It never touches `ballots`, because the moment a
       * participation report could be lined up against ballots it would stop being a
       * participation report. There is no parameter that widens it, and no role that
       * unlocks more of it: the absence of a selection is a property of the data, not
       * of the caller's permissions.
       */
      const body = record(payload)
      const election = reconcileElection(context, loadElection(context, body.electionId))
      const rows = listRollVoters(database, election.id).map((voter) => {
        const decision = findEligibility(database, election.id, voter.id)
        const record = findParticipation(database, election.id, voter.id)
        return {
          voter_record_id: voter.id,
          voter_id: voter.voter_id,
          eligibility: decision?.status ?? 'ineligible',
          eligibility_reason: decision?.reason ?? '',
          eligibility_decided_at: decision?.decided_at ?? null,
          has_voted: voter.has_voted,
          participated_at: record ? text(record.participated_at) : null,
          can_verify_by_phone: voter.phone.trim().length > 0,
          can_verify_by_email: voter.email.trim().length > 0,
        }
      })
      return ok({
        election_id: election.id,
        rows,
        summary: {
          on_roll: rows.length,
          eligible: rows.filter((row) => row.eligibility === 'eligible').length,
          participated: rows.filter((row) => row.has_voted === 1).length,
          ballots: countBallotRows(database, election.id),
        },
        // Said plainly, so nobody reading the response mistakes its silence for an
        // oversight and adds a join to "fix" it.
        note: 'This report records who voted, not what they chose. Ballot selections are stored separately and are not linked to any voter.',
      })
    }

    case 'election.participation.clear': {
      // Not a command. Guarded explicitly so the intent is unmistakable: there is no
      // way to read a voter's choice by their identity, so there is no such command
      // to disable either. Kept as a named failure to make a probe of it obvious.
      return fail('unavailable', 'Voter ballot selections cannot be retrieved by voter identity.')
    }

    case 'election.results': {
      const body = record(payload)
      const election = reconcileElection(context, loadElection(context, body.electionId))
      return ok({ results: buildResults(database, election, now) })
    }

    case 'election.audit': {
      const body = (payload ?? {}) as Record<string, unknown>
      const electionId = body.electionId ? parseElectionId(body.electionId) : null
      const limit = Math.min(500, Math.max(1, Number(body.limit) || 100))
      return ok({ events: listAuditEvents(database, electionId, limit) satisfies AuditEvent[] })
    }

    case 'voter.begin': {
      const body = record(payload)
      const election = reconcileElection(context, loadElection(context, body.electionId))
      const voterId = typeof body.voterId === 'string' ? body.voterId.trim().toUpperCase() : ''
      if (!voterId) return fail('invalid', 'Enter your identifier to continue.')

      const row = findRollVoterRow(database, election.id, voterId)
      const found = (row ? listRollVoters(database, election.id).find((item) => item.id === Number(row.id)) : null) ?? null

      /*
       * Non-enumerating response.
       *
       * When this election asks for a code, the reply is the same whether the
       * identifier is on the roll, is excluded, or was never registered. That
       * means this endpoint reveals nothing at all about who is registered — not
       * the name, not a masked contact, not whether a code was sent, not how many
       * were sent. Revealing any of it would let the form be used to build a roll
       * of every registered voter, and typing an identifier is not proof of
       * anything.
       *
       * The truth is given once, at `voter.verify`, and only to somebody who can
       * produce the code. From there the server knows who they are, so it can
       * safely show them their own name and eligibility.
       *
       * An election that asks for no code is the exception: with nothing to
       * prove, there is no later point at which to tell registered from
       * unregistered, and hiding it would only strand a legitimate voter. The
       * trade is deliberate — such an election has an open roll by construction.
       */
      if (election.rules.requireOtp) {
        const begun = beginWithChallenges(context, election, found, now)
        if (begun.failure) return fail(begun.failureCode ?? 'invalid', begun.failure)
        return ok(begun)
      }
      if (!found) return fail('not_found', 'That identifier is not on the roll for this election.')
      if (found.is_eligible !== 1) {
        return fail('forbidden', 'You are not eligible to vote in this election.')
      }
      if (isTerminalStatus(election.status) || election.status === 'draft') {
        return fail('election_state', 'This election is not accepting voters right now.')
      }
      return ok(beginWithoutCode(context, election, found, now))
    }

    case 'voter.verify': {
      const body = record(payload)
      const election = reconcileElection(context, loadElection(context, body.electionId))
      const voterId = typeof body.voterId === 'string' ? body.voterId.trim().toUpperCase() : ''
      if (!voterId) return fail('invalid', 'Enter your identifier to continue.')

      const row = findRollVoterRow(database, election.id, voterId)
      const candidate = row ? listRollVoters(database, election.id).find((item) => item.id === Number(row.id)) : null

      /*
       * One message for every failure mode.
       *
       * A wrong code, an expired code, an already-spent code, a locked code and
       * an identifier that was never on the roll all produce the same response.
       * Distinguishing them would either confirm which identifiers exist or give
       * an attacker a way to probe a challenge's state. The real reason is
       * written to the security log, where an operator can see it and a caller
       * cannot.
       */
      const refuse = (reason: string) => {
        recordSecurityEvent(database, {
          kind: 'voter_verification_failed',
          severity: 'notice',
          summary: `A voter verification attempt for ${election.title} did not succeed.`,
          adminId: null,
          adminLabel: voterId || 'unknown',
          ip: context.ip ?? null,
          detail: { reason, election_id: election.id },
        })
        return fail('invalid', 'That verification did not succeed. Start again to request a new code.')
      }

      if (!candidate) return refuse('unknown_identifier')
      if (election.rules.requireOtp) {
        const supplied = new Map<string, string>()
        for (const answer of Array.isArray(body.answers) ? body.answers : []) {
          if (!answer || typeof answer !== 'object') continue
          const entry = answer as Record<string, unknown>
          if (typeof entry.challenge_id !== 'string' || typeof entry.code !== 'string') continue
          supplied.set(entry.challenge_id, entry.code)
        }
        if (!supplied.size) return refuse('no_answer_supplied')

        /*
         * Drive verification from the channels this election demands, never from
         * the challenges that happen to be outstanding.
         *
         * The outstanding set is not a list of obligations — it is what is left
         * after obligations are met. Iterating over it would mean that once every
         * code is spent there is nothing left to check, and a caller replaying a
         * captured request would sail through with an empty loop. Asking instead
         * "which channel still owes an answer, does a live challenge exist for
         * it, and does the submitted code open it" makes a spent code a refusal
         * rather than a pass.
         */
        const policy = challengePolicy(context)
        const satisfied: string[] = []
        for (const channel of requiredChannels(election, candidate)) {
          const challenge = findLiveChallenge(database, {
            electionId: election.id,
            voterRecordId: candidate.id,
            channel,
            now,
          })
          // No live challenge for a channel the election requires means the caller
          // never went through `voter.begin` for this voter, or their code has
          // already been spent. Either way the channel is unproven.
          if (!challenge) return refuse(`no_live_challenge_${channel}`)
          const code = supplied.get(challenge.id)
          if (code === undefined) return refuse(`missing_answer_${channel}`)
          const outcome = verifyChallenge(database, {
            challengeId: challenge.id,
            code,
            policy,
            now,
          })
          if (!outcome.ok) return refuse(`${channel}_${outcome.reason}`)
          satisfied.push(challenge.id)
        }

        /*
         * Spend every channel only now that all of them are proven.
         *
         * Consuming as each channel passes would mean a voter who got the phone
         * code right and the email code wrong has to start the whole thing over
         * and wait out the resend cooldown — a self-inflicted lockout with no
         * security benefit, since the codes are short lived and attempt capped
         * either way.
         */
        for (const challengeId of satisfied) consumeChallenge(database, challengeId, now)
      }

      if (candidate.is_eligible !== 1) {
        // Safe to be specific now: the caller has just proved possession of the
        // identifier and, where the election requires it, of the code.
        return fail('forbidden', 'You are not eligible to vote in this election.')
      }
      if (isTerminalStatus(election.status) || election.status === 'draft' || election.status === 'paused') {
        return fail('election_closed', 'Voting is not open for this election.')
      }

      /*
       * Mint the session here, on the server, from a fresh CSPRNG token.
       *
       * Nothing the client sent is adopted, which is what closes session
       * fixation: a caller cannot pre-set a cookie and have it become the
       * verified identity. Any session the voter already held for this election
       * is revoked as part of creating the new one.
       */
      const created = createVoterSession(database, {
        electionId: election.id,
        voterRecordId: candidate.id,
        now,
        ip: context.ip ?? null,
        userAgent: context.userAgent ?? null,
      })
      // Handed straight to the transport, which sets it as an HttpOnly cookie.
      // The token deliberately does not appear in the response below.
      context.setVoterSession?.(created.token)

      const alreadyParticipated = hasParticipated(database, election.id, candidate.id)

      /*
       * Issue the voting credential.
       *
       * Authentication and authorisation to vote are separate acts, and this is
       * where one becomes the other. The session says "this is who you are"; the
       * credential says "you may cast one ballot in this election, until this
       * moment, once". Handing the ballot subsystem a credential rather than a
       * session is what keeps the voter's identity out of the ballot record: the
       * credential resolves to a person, and the ballot is written without one.
       *
       * A voter who has already voted gets no credential. Issuing one would mean
       * issuing a right to a second ballot.
       */
      let credentialExpiresAt: string | null = null
      if (!alreadyParticipated) {
        const issued = issueCredential(database, {
          electionId: election.id,
          voterRecordId: candidate.id,
          now,
          ttlSeconds: credentialTtl(context),
          reason: 'issued after verification',
        })
        context.setVoterCredential?.(issued.token)
        credentialExpiresAt = issued.credential.expiresAt
      }

      recordAudit(database, {
        electionId: election.id,
        actorType: 'voter',
        actorId: candidate.id,
        actorLabel: candidate.voter_id,
        action: 'voter_verified',
        summary: `${candidate.full_name} completed identity verification.`,
      })
      recordSecurityEvent(database, {
        kind: 'voter_verified',
        summary: `${candidate.voter_id} completed identity verification for ${election.title}.`,
        adminId: null,
        adminLabel: candidate.voter_id,
        ip: context.ip ?? null,
      })

      /*
       * No token in the body. The session and the credential are both set as
       * `HttpOnly` cookies by the transport, so the page script never sees either
       * — which means an injected script cannot exfiltrate them, and there is
       * nothing in the response for a caller to replay from a log.
       */
      return ok({
        verified: true,
        voter: { voter_id: candidate.voter_id, full_name: candidate.full_name, has_voted: candidate.has_voted },
        has_voted: alreadyParticipated,
        credential: credentialExpiresAt ? { expires_at: credentialExpiresAt, election_id: election.id } : null,
        election: toElectionSummary(database, election, now),
      })
    }

    case 'voter.logout': {
      const body = record(payload)
      const election = loadElection(context, body.electionId)
      const identity = resolveVoterSession(context, election.id)
      if (!identity) return ok({ signedOut: true })
      if (context.voterToken) {
        revokeVoterToken(context.database, context.voterToken, now, 'signed out')
      }
      context.setVoterSession?.(null)
      recordSecurityEvent(database, {
        kind: 'voter_signed_out',
        summary: `${identity.voter.voter_id} signed out of ${election.title}.`,
        adminId: null,
        adminLabel: identity.voter.voter_id,
        ip: context.ip ?? null,
      })
      return ok({ signedOut: true })
    }

    case 'voter.ballot': {
      const body = record(payload)
      const election = reconcileElection(context, loadElection(context, body.electionId))
      const identity = resolveVoterSession(context, election.id)
      if (!identity) return fail('unauthorized', 'You are not verified for this election. Verify again to continue.')
      const preview = buildPreview(database, election, now)
      // Whether this voter has voted comes from participation, which is the whole
      // point of that table: it answers the question without touching a ballot.
      const hasVoted = hasParticipated(database, election.id, identity.voter.id)
      // Whether they still hold a usable credential, so the interface can offer a
      // fresh one rather than letting the voter submit into a refusal.
      const credential = resolveCredential(database, {
        token: context.voterCredential ?? null,
        electionId: election.id,
        now,
      })
      return ok({
        election: preview.election,
        options: preview.options,
        rules: election.rules,
        eligibility: election.eligibility,
        has_voted: hasVoted,
        // The voter is told only what they need to proceed: that they have voted, and
        // whether they can still cast. Not what they cast — they know, and the server
        // has no way to look it up that would not defeat the separation.
        can_vote: !hasVoted && election.status === 'open' && credential.ok,
        credential: credential.ok ? { expires_at: credential.credential.expiresAt } : null,
        results: buildResults(database, election, now),
      })
    }

    case 'voter.vote': {
      const body = record(payload)
      const election = reconcileElection(context, loadElection(context, body.electionId))
      const electionId = election.id

      /*
       * The ballot subsystem authorises on a *credential*, not on a session.
       *
       * A credential is minted after authentication, bound to this one election,
       * short lived, and good for exactly one ballot. Consuming it is what proves
       * the caller is entitled to vote, and it proves that without carrying the
       * voter's identity into the ballot record. A session would have been the
       * obvious alternative and the wrong one: it is long lived, and reusing it
       * here would tie the ballot to whoever happens to be signed in.
       */
      const resolved = resolveCredential(context.database, {
        token: context.voterCredential ?? null,
        electionId,
        now,
      })
      if (!resolved.ok) {
        recordSecurityEvent(context.database, {
          kind: 'ballot_credential_rejected',
          severity: 'notice',
          summary: `A ballot submission for ${election.title} was refused: ${resolved.state.replace(/_/g, ' ')}.`,
          adminId: null,
          adminLabel: 'unknown',
          ip: context.ip ?? null,
          detail: { election_id: electionId, state: resolved.state },
        })
        // One message for every reason. Naming the state would tell a caller
        // whether their credential existed, was spent, or was for another poll.
        return fail('unauthorized', 'Your voting credential is not valid. Verify again to get a new one.')
      }
      const credential = resolved.credential

      const voterRow = queryOne(context.database, 'SELECT * FROM roll_voters WHERE id = ? AND election_id = ?', [
        credential.voterRecordId,
        electionId,
      ])
      if (!voterRow) {
        return fail('unauthorized', 'Your voting credential is not valid. Verify again to get a new one.')
      }
      const voter = listRollVoters(context.database, electionId).find((item) => item.id === credential.voterRecordId)
      if (!voter) {
        return fail('unauthorized', 'Your voting credential is not valid. Verify again to get a new one.')
      }

      // ---- Server-side election boundary enforcement -------------------------
      // Everything below runs against the server clock and the persisted state.
      // The client cannot influence any of it.
      if (isTerminalStatus(election.status)) {
        return fail('election_closed', `This election is ${STATUS_LABELS[election.status].toLowerCase()} and no longer accepts votes.`)
      }
      if (election.status === 'draft') {
        return fail('election_closed', 'This election has not been published yet.')
      }
      if (election.status === 'paused') {
        return fail('election_paused', 'Voting is paused. Please try again once an administrator resumes the poll.')
      }
      if (election.status === 'closed') {
        return fail('election_closed', 'Voting has closed for this election.')
      }
      if (election.status !== 'open') {
        return fail('election_closed', 'Voting is not open for this election.')
      }
      const startsAt = Date.parse(election.starts_at)
      const endsAt = Date.parse(election.ends_at)
      if (now < startsAt) {
        return fail('before_window', `Voting does not open until ${new Date(startsAt).toISOString()}.`)
      }
      if (now >= endsAt) {
        return fail('after_window', 'The scheduled end time has passed, so votes are no longer accepted.')
      }
      if (voter.is_eligible !== 1) {
        return fail('forbidden', 'You are not eligible to vote in this election.')
      }
      // ------------------------------------------------------------------------

      const rawSelections = Array.isArray(body.candidateIds) ? body.candidateIds : []
      const candidateIds: number[] = []
      for (const value of rawSelections) {
        if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
          return fail('invalid', 'The ballot selection was not understood.')
        }
        candidateIds.push(value)
      }
      const required = election.rules.votesPerVoter
      if (candidateIds.length !== required) {
        return fail('invalid', `Select exactly ${required} option${required === 1 ? '' : 's'} on this ballot.`)
      }
      if (new Set(candidateIds).size !== candidateIds.length) {
        return fail('invalid', 'The same option cannot be selected twice.')
      }

      const approved = listCandidates(database, election.id).filter((candidate) => candidate.status === 'approved')
      const approvedIds = new Set(approved.map((candidate) => candidate.id))
      for (const candidateId of candidateIds) {
        if (isSpecialOptionId(candidateId)) {
          const special = candidateId === SPECIAL_OPTION_IDS.nota ? 'nota' : 'abstain'
          const allowed = special === 'nota' ? election.rules.allowNotA : election.rules.allowAbstain
          if (!allowed) {
            return fail('invalid', `This ballot does not offer a ${special === 'nota' ? '"None of the Above"' : '"Abstain"'} option.`)
          }
          continue
        }
        if (!approvedIds.has(candidateId)) {
          return fail('invalid', 'One of the selected options is not available on this ballot.')
        }
      }

      /*
       * One vote per eligible voter, enforced by the participation table's unique
       * constraint rather than by this read. A read-then-write would let two
       * concurrent submissions both see "not voted yet"; the constraint cannot be
       * raced. The check here exists only to produce a clear message.
       */
      if (hasParticipated(database, electionId, voter.id)) {
        return fail('already_voted', 'You have already cast your vote for this election.')
      }

      const iso = new Date(now).toISOString()
      const receipts: string[] = []
      let integrityDigest = ''
      let credentialUnavailable = false
      /*
       * Two records, written together, sharing nothing.
       *
       * `participation` names the voter and the credential they spent.
       * `ballots` names the options and nothing else. There is no column in either
       * that appears in the other, so this transaction can relate them — the
       * server knows both, in memory, right now — while the stored data cannot.
       * That asymmetry is the entire design: the check happens, the record of the
       * check does not imply the choice.
       */
      transact(database, () => {
        if (!spendCredential(database, credential.id, now)) {
          credentialUnavailable = true
          return
        }
        recordParticipation(database, {
          electionId,
          voterRecordId: voter.id,
          credentialId: credential.id,
          now,
        })
        const ballot = recordBallot(database, {
          electionId,
          selections: candidateIds,
          now,
          databasePath: context.databasePath,
        })
        if (election.rules.issueReceipts) {
          const receipt = issueReceipt(database, { electionId, ballotId: ballot.id, now })
          receipts.push(receipt.code)
          // Held in an HttpOnly cookie so a reload can show the voter their own
          // receipt again. The page cannot read it, and no administrator can reach
          // it, because receipts are stored as a digest and looked up by code.
          context.setVoterReceipt?.(receipt.code)
        }
        integrityDigest = ballot.integrityDigest
      })

      if (credentialUnavailable) {
        return fail('unauthorized', 'Your voting credential has already been used. Verify again to get a new one.')
      }

      /*
       * The audit trail records that this person voted. It must not record what
       * they chose: an audit row carries the actor, and a row carrying both the
       * actor and the options would rebuild the exact mapping this schema exists
       * to prevent. Selection count only.
       */
      recordAudit(database, {
        electionId,
        actorType: 'voter',
        actorId: voter.id,
        actorLabel: voter.voter_id,
        action: 'vote_cast',
        summary: `${voter.full_name} cast a ballot with ${candidateIds.length} selection(s).`,
        detail: { selection_count: candidateIds.length, credential_id: credential.id },
      })
      recordSecurityEvent(database, {
        kind: 'ballot_cast',
        summary: `A ballot was recorded for ${election.title} using a single-use credential.`,
        adminId: null,
        adminLabel: voter.voter_id,
        ip: context.ip ?? null,
        detail: { election_id: electionId, selection_count: candidateIds.length },
      })

      /*
       * The response deliberately does not echo the selections back against the
       * voter's identity. The voter knows what they picked; what they get is the
       * receipt that lets them prove it was counted, and the aggregate results.
       */
      return ok({
        recorded: true,
        receipts: election.rules.issueReceipts ? receipts : [],
        submitted_at: iso,
        integrity_digest: integrityDigest,
        election: toElectionSummary(database, election, now),
        results: buildResults(database, election, now),
      })
    }

    case 'voter.receipt': {
      const body = record(payload)
      const election = loadElection(context, body.electionId)
      /*
       * Found by receipt, never by identity.
       *
       * This is the only route from a ballot back to its contents, and it is keyed
       * on a secret the voter holds. There is deliberately no `receiptsForVoter`
       * counterpart anywhere in the codebase: if knowing who somebody were were
       * enough to learn their ballot, the separation in the schema would be
       * decorative and this whole arrangement pointless.
       */
      const supplied = typeof body.receipt === 'string' && body.receipt.trim() !== ''
        ? body.receipt
        : (context.voterReceipt ?? null)
      if (!supplied) {
        return fail('not_found', 'No receipt is available for this browser. Vote first, or enter your receipt code.')
      }
      const found = findReceipt(database, supplied)
      if (!found || found.electionId !== election.id) {
        return fail('not_found', 'That receipt code was not recognised for this election.')
      }
      return ok({
        receipt: {
          receipt: found.code,
          election_id: found.electionId,
          submitted_at: found.ballot.submittedAt,
          selection_count: found.ballot.selectionCount,
          integrity_digest: found.ballot.integrityDigest,
          // Tamper-evidence, not attribution: this says the stored ballot still
          // matches the digest taken when it was written. It says nothing about
          // who cast it, and it cannot, because the two are not linked.
          integrity_ok: verifyBallotIntegrity(found.ballot, context.databasePath),
        },
      })
    }

    case 'voter.credential': {
      /*
       * Re-issue a voting credential to somebody who has already authenticated.
       *
       * Needed because a credential is short lived: a voter who took longer to
       * decide than the credential lasted should be able to get another without
       * re-entering their verification code. It is not a loophole — it still
       * requires a live session, it revokes the previous credential, and it
       * refuses once the voter has already participated, because at that point a
       * credential would be a right to a second ballot rather than a first.
       */
      const body = record(payload)
      const election = loadElection(context, body.electionId)
      const identity = resolveVoterSession(context, election.id)
      if (!identity) return fail('unauthorized', 'You are not verified for this election. Verify again to continue.')
      if (hasParticipated(database, election.id, identity.voter.id)) {
        return fail('already_voted', 'You have already cast your vote for this election.')
      }
      const issued = issueCredential(database, {
        electionId: election.id,
        voterRecordId: identity.voter.id,
        now,
        ttlSeconds: credentialTtl(context),
        reason: 're-issued on request',
      })
      context.setVoterCredential?.(issued.token)
      return ok({
        credential: {
          // The credential itself is never serialised. The page holds an HttpOnly
          // cookie and nothing else, so there is nothing for a script to steal and
          // nothing for a response log to capture.
          expires_at: issued.credential.expiresAt,
          election_id: issued.credential.electionId,
        },
      })
    }

    default:
      return fail('unknown_command', `Unknown command: ${String(command)}`)
  }
}

export { defaultRules, defaultEligibility, isValidTimeZone }
export type { CandidateWithTally, RollVoterWithStatus, BootstrapState, BallotPreview, ElectionResults }
