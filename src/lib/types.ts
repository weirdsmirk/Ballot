/**
 * Shared domain model for Ballot.
 *
 * Every type here is used by both the Vite middleware backend and the React
 * client, so this module must stay free of Node and browser specific APIs.
 */

export const ELECTION_TYPES = [
  'general',
  'university',
  'department',
  'club',
  'organization',
  'referendum',
  'primary',
  'board',
  'municipal',
] as const
export type ElectionType = (typeof ELECTION_TYPES)[number]

export const ELECTION_TYPE_LABELS: Record<ElectionType, string> = {
  general: 'General election',
  university: 'University election',
  department: 'Department election',
  club: 'Club election',
  organization: 'Organizational election',
  referendum: 'Referendum',
  primary: 'Primary / nomination',
  board: 'Board election',
  municipal: 'Municipal election',
}

export const ELECTION_STATUSES = [
  'draft',
  'scheduled',
  'open',
  'paused',
  'closed',
  'certified',
  'archived',
] as const
export type ElectionStatus = (typeof ELECTION_STATUSES)[number]

export const CANDIDATE_STATUSES = ['draft', 'approved', 'withdrawn', 'disqualified'] as const
export type CandidateStatus = (typeof CANDIDATE_STATUSES)[number]

export const RESULTS_VISIBILITIES = ['live', 'after_close', 'after_certify', 'never'] as const
export type ResultsVisibility = (typeof RESULTS_VISIBILITIES)[number]

export const ELIGIBILITY_MODES = ['roll', 'open_registration'] as const
export type EligibilityMode = (typeof ELIGIBILITY_MODES)[number]

/** Ballot options that are not real candidates. */
export const SPECIAL_OPTIONS = ['nota', 'abstain'] as const
export type SpecialOption = (typeof SPECIAL_OPTIONS)[number]

export type ElectionRules = {
  /** How many selections a single voter may submit. */
  votesPerVoter: number
  /** Offer a "None of the Above" ballot option. */
  allowNotA: boolean
  /** Offer an "Abstain" ballot option. */
  allowAbstain: boolean
  /** Require a one-time code before the ballot is shown. */
  requireOtp: boolean
  /** A phone number is mandatory on the roll. */
  requirePhone: boolean
  /** An email address is mandatory on the roll. */
  requireEmail: boolean
  /** When tally totals become visible to voters. */
  resultsVisibility: ResultsVisibility
  /** Allow a voter to replace their selection before the poll closes. */
  allowVoteChange: boolean
  /** Issue a receipt code after a successful vote. */
  issueReceipts: boolean
  /** Shuffle ballot option order per session. */
  randomizeBallotOrder: boolean
  /** Render candidate photos on the ballot. */
  showCandidateImages: boolean
}

export type EligibilityRules = {
  /** `roll` = closed list managed by administrators. */
  mode: EligibilityMode
  /** Label for the voter roll identifier, e.g. "Roll Number" or "Student ID". */
  identifierLabel: string
  /** Label for the free-text grouping field, e.g. "Department". */
  groupLabel: string
  /** Free-text guidance shown to voters. */
  notes: string
}

export type Election = {
  id: string
  title: string
  description: string
  election_type: ElectionType
  timezone: string
  /** ISO-8601 UTC instant. */
  starts_at: string
  /** ISO-8601 UTC instant. */
  ends_at: string
  status: ElectionStatus
  rules: ElectionRules
  eligibility: EligibilityRules
  created_by: number | null
  created_at: string
  updated_at: string
  published_at: string | null
  published_by: number | null
  closed_at: string | null
  closed_by: number | null
  certified_at: string | null
  certified_by: number | null
  archived_at: string | null
  archived_by: number | null
}

export type Candidate = {
  id: number
  election_id: string
  name: string
  organization: string
  abbreviation: string
  description: string
  image_url: string
  symbol: string
  position: number
  status: CandidateStatus
  created_at: string
  updated_at: string
}

export type CandidateWithTally = Candidate & { vote_count: number }

/**
 * A roll record as stored: identity, and nothing else.
 *
 * There is no eligibility flag here and no voting state. Eligibility lives in the
 * `eligibility` table and participation in the `participation` table, both
 * separate, so reading who somebody is never also reveals whether they were
 * allowed to vote or whether they did. There is no passcode field either — codes
 * are server-generated per verification attempt and never written to the roll, so
 * nothing in this record can be replayed to impersonate the voter.
 */
export type RollVoter = {
  id: number
  election_id: string
  voter_id: string
  full_name: string
  phone: string
  email: string
  external_ref: string
  created_at: string
}

/** An eligibility decision, kept apart from the identity it applies to. */
export type EligibilityRecord = {
  election_id: string
  voter_record_id: number
  status: 'eligible' | 'ineligible'
  reason: string
  decided_at: string
  decided_by: string | null
}

/**
 * A roll record plus the two facts that live in other tables.
 *
 * `is_eligible` is read from the eligibility table and `has_voted` from
 * participation; neither is a column of the roll. What is deliberately absent is
 * any selection — there is no field here that could hold one, and none may be
 * added, because this is the shape an administrator sees for every voter on a
 * roll and a shape that grew a `candidate_id` would undo the separation.
 */
export type RollVoterWithStatus = RollVoter & {
  is_eligible: 0 | 1
  has_voted: 0 | 1
}

/**
 * A roll record as it leaves the server.
 *
 * Names and contact details are omitted unless the caller holds
 * `voter.view_pii`. The `can_verify_*` flags report whether a code *could* be
 * delivered on each channel, which is what an operator needs in order to spot a
 * voter who will be unable to verify — the codes themselves are never sent.
 */
export type RedactedRollVoter = Omit<RollVoter, 'full_name' | 'phone' | 'email' | 'external_ref'> & {
  full_name: string
  phone: string
  email: string
  external_ref: string
  is_eligible: 0 | 1
  has_voted: 0 | 1
  can_verify_by_phone: boolean
  can_verify_by_email: boolean
}

/**
 * Proof that a ballot was recorded as cast.
 *
 * A receipt is found by its code, never by a voter's identity, and it reports
 * what was recorded plus the integrity digest over it. It carries no voter field
 * and none may be added: a receipt that named its voter would be a direct
 * answer to "what did they vote for".
 */
export type BallotReceipt = {
  receipt: string
  election_id: string
  submitted_at: string
  selection_count: number
  /** Keyed digest over the stored ballot. Verifiable, not reversible. */
  integrity_digest: string
  /** Whether the stored ballot still matches its digest. */
  integrity_ok: boolean
}

export type AuditActor = 'admin' | 'system' | 'voter'

export type AuditEvent = {
  id: number
  election_id: string | null
  actor_type: AuditActor
  actor_id: string | null
  actor_label: string
  action: string
  from_status: string | null
  to_status: string | null
  summary: string
  detail: string
  created_at: string
}

/**
 * Administrator and session records live in `./adminTypes`.
 *
 * They used to have a narrower duplicate here, which meant the bootstrap payload
 * was typed as a session with no MFA or re-authentication timestamps even though
 * the server always sends them. Re-exported rather than redeclared so there is
 * one definition of what an administrator session is.
 */
export type { AdminAccount, AdminSession } from './adminTypes'

import type { AdminSession } from './adminTypes'

/** Admin-initiated lifecycle actions. */
export const LIFECYCLE_ACTIONS = [
  'publish',
  'unpublish',
  'open',
  'pause',
  'resume',
  'close',
  'certify',
  'archive',
] as const
export type LifecycleAction = (typeof LIFECYCLE_ACTIONS)[number]

export type ActionAvailability = {
  action: LifecycleAction
  available: boolean
  /** Why the action is unavailable, shown as a tooltip in the admin UI. */
  reason: string
}

export type ElectionSummary = {
  id: string
  title: string
  description: string
  election_type: ElectionType
  timezone: string
  starts_at: string
  ends_at: string
  status: ElectionStatus
  /** Status after applying the schedule clock. */
  effective_status: ElectionStatus
  /** True when the persisted status has drifted from the clock. */
  schedule_drifted: boolean
  rules: ElectionRules
  eligibility: EligibilityRules
  created_at: string
  updated_at: string
  published_at: string | null
  closed_at: string | null
  certified_at: string | null
  archived_at: string | null
  candidate_count: number
  approved_candidate_count: number
  eligible_count: number
  /**
   * People who have voted.
   *
   * The numerator of turnout, counted from participation. Kept apart from
   * `ballot_count` so no figure about *how many people voted* has to be derived
   * from the table that holds what they chose.
   */
  participant_count: number
  /**
   * Anonymous ballots recorded.
   *
   * Named for what it counts. It is deliberately not "votes for this election",
   * because the number of ballots is not the number of votes when a ballot carries
   * several selections, and conflating the two is how a turnout figure quietly
   * starts implying something about individual choices.
   */
  ballot_count: number
  /** Critical settings are frozen and cannot be edited. */
  locked: boolean
  /** Structural editing (schedule, rules, candidates, roll) is permitted. */
  edits_allowed: boolean
  /** Paused polls allow candidate status changes, which are audited. */
  status_changes_allowed: boolean
  actions: ActionAvailability[]
}

export type BallotOption = {
  key: string
  kind: 'candidate' | 'nota' | 'abstain'
  name: string
  organization: string
  abbreviation: string
  description: string
  image_url: string
  symbol: string
  position: number
  status: CandidateStatus | null
}

export type BallotPreview = {
  election: ElectionSummary
  options: BallotOption[]
  rules: ElectionRules
  /** Non-blocking notes an administrator should resolve before publishing. */
  warnings: string[]
  /** Blocking problems that prevent the election from being published. */
  blockers: string[]
  ready_to_publish: boolean
}

export type TallyRow = {
  key: string
  kind: 'candidate' | 'nota' | 'abstain'
  name: string
  organization: string
  position: number
  votes: number
  percentage: number
}

export type ElectionResults = {
  election_id: string
  status: ElectionStatus
  effective_status: ElectionStatus
  server_now: string
  visible: boolean
  hidden_reason: string
  total_votes: number
  eligible_count: number
  turnout: number
  rows: TallyRow[]
  winner: TallyRow | null
  certified_at: string | null
}

export type BootstrapState = {
  server_now: string
  elections: ElectionSummary[]
  admins_exist: boolean
  session: AdminSession | null
}

/**
 * The result of any command.
 *
 * A failure can additionally name the elevation step the server demanded, which
 * is what lets the admin interface ask for a password, a second factor, or a
 * second administrator's approval rather than showing a bare error.
 */
export type ActionResult<T = undefined> =
  | { ok: true; value: T }
  | {
      ok: false
      error: string
      code: string
      elevation?: 'reauth' | 'mfa' | 'two_person'
      reason?: string
    }

export const SPECIAL_OPTION_IDS: Record<SpecialOption, number> = {
  nota: -1,
  abstain: -2,
}

export function isSpecialOptionId(candidateId: number): candidateId is -1 | -2 {
  return candidateId === SPECIAL_OPTION_IDS.nota || candidateId === SPECIAL_OPTION_IDS.abstain
}

export function specialOptionFor(candidateId: number): SpecialOption | null {
  if (candidateId === SPECIAL_OPTION_IDS.nota) return 'nota'
  if (candidateId === SPECIAL_OPTION_IDS.abstain) return 'abstain'
  return null
}
