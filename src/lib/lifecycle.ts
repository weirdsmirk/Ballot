/**
 * Election lifecycle state machine.
 *
 * This module is the single source of truth for what may happen in each
 * lifecycle state. The backend imports it to authorise every mutation, and the
 * admin UI imports it to render controls, so the two can never disagree.
 *
 * Policy summary
 * --------------
 * - `draft` / `scheduled`  full structural editing is allowed.
 * - The moment a poll opens, the ballot is *frozen*: candidates can no longer
 *   be added, removed, or reordered, because that would change what voters have
 *   already seen and voted on.
 * - `paused` is the controlled window for sensitive changes: an administrator
 *   may pause a running poll and change candidate *status* (withdraw,
 *   disqualify, reinstate) or the election description. Both are audited.
 * - `closed` / `certified` / `archived` are read-only.
 */

import {
  type ActionAvailability,
  type Election,
  type ElectionStatus,
  type LifecycleAction,
} from './types'

export const STATUS_LABELS: Record<ElectionStatus, string> = {
  draft: 'Draft',
  scheduled: 'Scheduled',
  open: 'Open',
  paused: 'Paused',
  closed: 'Closed',
  certified: 'Certified',
  archived: 'Archived',
}

export const STATUS_DESCRIPTIONS: Record<ElectionStatus, string> = {
  draft: 'Being configured. Not visible to voters and cannot accept votes.',
  scheduled: 'Published and waiting for its opening time. Ballot is finalised but locked for structural edits once voting begins.',
  open: 'Voting is in progress. Votes are being accepted and recorded.',
  paused: 'Temporarily suspended. No votes are accepted until the poll is resumed.',
  closed: 'Voting has ended. The tally is final and awaiting certification.',
  certified: 'Results have been certified and signed off as the official record.',
  archived: 'Retained for the record. Read-only and hidden from the active list.',
}

/** States from which no further transition is possible. */
export const TERMINAL_STATUSES: readonly ElectionStatus[] = ['certified', 'archived']

/** States in which the poll is not currently accepting votes. */
export const NON_VOTING_STATUSES: readonly ElectionStatus[] = ['draft', 'scheduled', 'paused', 'closed', 'certified', 'archived']

const TRANSITIONS: Record<LifecycleAction, { from: readonly ElectionStatus[]; to: ElectionStatus }> = {
  publish: { from: ['draft'], to: 'scheduled' },
  unpublish: { from: ['scheduled'], to: 'draft' },
  open: { from: ['scheduled'], to: 'open' },
  pause: { from: ['open'], to: 'paused' },
  resume: { from: ['paused'], to: 'open' },
  close: { from: ['open', 'paused'], to: 'closed' },
  certify: { from: ['closed'], to: 'certified' },
  // `closed` is deliberately absent: a finished poll must be certified before it
  // can be archived, otherwise the certified state could be bypassed entirely.
  archive: { from: ['draft', 'scheduled', 'certified'], to: 'archived' },
}

export const LIFECYCLE_ACTION_LABELS: Record<LifecycleAction, string> = {
  publish: 'Publish',
  unpublish: 'Return to draft',
  open: 'Open voting',
  pause: 'Pause voting',
  resume: 'Resume voting',
  close: 'Close voting',
  certify: 'Certify results',
  archive: 'Archive',
}

/**
 * The status an action would lead to, or null if it is not a legal move.
 *
 * Total by design: an unrecognised action yields null rather than throwing, so a
 * request carrying a made-up action is refused as an invalid transition instead
 * of crashing the handler. The action arrives straight from the wire, so it
 * cannot be assumed to be one of ours — and the lookup must be an own-property
 * check, because `TRANSITIONS['toString']` would otherwise return an inherited
 * function and then fail on `rule.from`.
 */
export function transitionTarget(from: ElectionStatus, action: LifecycleAction): ElectionStatus | null {
  if (!Object.prototype.hasOwnProperty.call(TRANSITIONS, action)) return null
  const rule = TRANSITIONS[action]
  return rule.from.includes(from) ? rule.to : null
}

export function isValidTransition(from: ElectionStatus, action: LifecycleAction): boolean {
  return transitionTarget(from, action) !== null
}

export function isTerminalStatus(status: ElectionStatus): boolean {
  return TERMINAL_STATUSES.includes(status)
}

export function isVotingOpen(status: ElectionStatus): boolean {
  return status === 'open'
}

/**
 * Resolve the status an election should be treated as, given the server clock.
 *
 * A scheduled poll opens itself once its start time passes and closes itself
 * once its end time passes, so the persisted `status` column can lag reality.
 * Every authorisation decision uses this function rather than the raw column.
 */
export function effectiveStatus(election: Pick<Election, 'status' | 'starts_at' | 'ends_at'>, now: number): ElectionStatus {
  const stored = election.status
  if (isTerminalStatus(stored) || stored === 'closed') return stored

  const start = Date.parse(election.starts_at)
  const end = Date.parse(election.ends_at)
  if (!Number.isFinite(start) || !Number.isFinite(end)) return stored

  if (now >= end) return 'closed'
  if (stored === 'scheduled' && now >= start) return 'open'
  return stored
}

/** True when the persisted status no longer matches the schedule. */
export function hasScheduleDrift(election: Pick<Election, 'status' | 'starts_at' | 'ends_at'>, now: number): boolean {
  return effectiveStatus(election, now) !== election.status
}

/** Structural edits (schedule, rules, candidates, roll) are allowed only before the poll opens. */
export function allowsStructuralEdits(status: ElectionStatus): boolean {
  return status === 'draft' || status === 'scheduled'
}

/** Candidate status changes and description edits are allowed while an administrator has paused the poll. */
export function allowsControlledChanges(status: ElectionStatus): boolean {
  return status === 'paused'
}

export function isLocked(status: ElectionStatus): boolean {
  return !allowsStructuralEdits(status)
}

/**
 * Guard for mutating election configuration.
 *
 * @returns an error message when the change is not permitted, otherwise null.
 */
export function structuralEditGuard(status: ElectionStatus): string | null {
  if (allowsStructuralEdits(status)) return null
  if (status === 'open') {
    return 'This election is open. Pause voting before changing the ballot, schedule, or eligibility rules.'
  }
  if (status === 'paused') {
    return 'Voting is paused, but the ballot is frozen because voting has already begun. Only candidate status and the description can change.'
  }
  return `${STATUS_LABELS[status]} elections are read-only.`
}

/** Guard for candidate status changes and description edits. */
export function controlledChangeGuard(status: ElectionStatus): string | null {
  if (allowsStructuralEdits(status) || allowsControlledChanges(status)) return null
  if (status === 'open') {
    return 'Pause voting before changing candidate status.'
  }
  return `${STATUS_LABELS[status]} elections are read-only.`
}

export type PublishCheckInput = {
  status: ElectionStatus
  title: string
  description: string
  startsAt: string
  endsAt: string
  approvedCandidates: number
  eligibleVoters: number
  requireOtp: boolean
  requirePhone: boolean
  requireEmail: boolean
  requireCompleteRoll: boolean
  now: number
}

export type PublishCheck = { blockers: string[]; warnings: string[] }

/**
 * Validate that an election is complete enough to publish.
 *
 * `blockers` prevent publishing outright. `warnings` are surfaced in the ballot
 * preview but do not stop an administrator with authority from proceeding.
 */
export function checkPublishable(input: PublishCheckInput): PublishCheck {
  const blockers: string[] = []
  const warnings: string[] = []

  if (!input.title.trim()) blockers.push('The election needs a title.')
  if (!input.description.trim()) blockers.push('The election needs a description so voters know what they are voting on.')
  if (input.approvedCandidates < 2) {
    blockers.push(`At least 2 approved candidates or ballot options are required (currently ${input.approvedCandidates}).`)
  }
  if (input.approvedCandidates > 60) {
    warnings.push(`${input.approvedCandidates} options is a large ballot; consider whether a shortlist is intended.`)
  }

  const start = Date.parse(input.startsAt)
  const end = Date.parse(input.endsAt)
  if (!Number.isFinite(start)) {
    blockers.push('The scheduled start time is not a valid date.')
  }
  if (!Number.isFinite(end)) {
    blockers.push('The scheduled end time is not a valid date.')
  }
  if (Number.isFinite(start) && Number.isFinite(end)) {
    if (end <= start) blockers.push('The end time must be after the start time.')
    const durationMinutes = (end - start) / 60_000
    if (durationMinutes < 5) warnings.push('The voting window is under 5 minutes.')
    if (input.now >= end) blockers.push('The end time is already in the past.')
  }

  if (input.requireCompleteRoll && input.eligibleVoters < 1) {
    blockers.push('The voter roll is empty. Add eligible voters or switch eligibility to open registration.')
  }
  if (input.requirePhone || input.requireEmail) {
    warnings.push(
      `Roll entries without a verified ${input.requirePhone && input.requireEmail ? 'phone number and email address' : input.requirePhone ? 'phone number' : 'email address'} cannot complete verification.`,
    )
  }
  if (input.requireOtp) {
    // No warning about the codes themselves: they are issued per attempt and never
    // held, so there is nothing on the roll to be missing. What matters is whether
    // a code can be delivered, which is what the check above covers.
    warnings.push(
      'A one-time code is required, so every voter needs a phone number and an email address on the roll to receive one.',
    )
  }
  if (input.approvedCandidates === 2 && !input.requireOtp) {
    warnings.push('A two-option ballot with no identity check is easy to guess; consider requiring a one-time code.')
  }

  return { blockers, warnings }
}

/**
 * Extra conditions for a specific transition beyond the state table.
 * Clock-dependent failures are returned here so the message can be precise.
 */
export function transitionGuard(
  election: Pick<Election, 'status' | 'starts_at' | 'ends_at'>,
  action: LifecycleAction,
  now: number,
): string | null {
  if (!isValidTransition(election.status, action)) {
    // `action` came off the wire, so a made-up one must not be used to look up a
    // label: an inherited `toString` would throw rather than produce a message.
    const label = Object.prototype.hasOwnProperty.call(LIFECYCLE_ACTION_LABELS, action)
      ? LIFECYCLE_ACTION_LABELS[action as LifecycleAction]
      : 'perform that action on'
    return `Cannot ${label.toLowerCase()} an election that is ${STATUS_LABELS[election.status].toLowerCase()}.`
  }

  const end = Date.parse(election.ends_at)
  const start = Date.parse(election.starts_at)

  if (action === 'open') {
    if (now < start) {
      return `Voting cannot open before ${new Date(start).toISOString()}.`
    }
    if (Number.isFinite(end) && now >= end) {
      return 'The scheduled end time has already passed. Adjust the schedule before opening.'
    }
  }

  if (action === 'resume') {
    if (Number.isFinite(end) && now >= end) {
      return 'The scheduled end time has passed, so this poll can no longer be resumed. Close it instead.'
    }
  }

  // Note: certifying has no extra clock condition. Reaching `closed` is already
  // proof that voting finished, whether the poll ran to its scheduled end or an
  // administrator closed it early.

  if (action === 'unpublish') {
    if (Number.isFinite(start) && now >= start && election.status === 'scheduled') {
      // The window has opened but nobody voted yet; reverting is still safe.
      return null
    }
  }

  return null
}

/** Describe every lifecycle action for an election, flagging which are currently available. */
export function describeActions(
  election: Pick<Election, 'status' | 'starts_at' | 'ends_at'>,
  now: number,
): ActionAvailability[] {
  const actions: LifecycleAction[] = [
    'publish',
    'open',
    'pause',
    'resume',
    'close',
    'certify',
    'unpublish',
    'archive',
  ]
  return actions.map((action) => {
    if (!isValidTransition(election.status, action)) {
      return { action, available: false, reason: `Not available from ${STATUS_LABELS[election.status]}.` }
    }
    const guard = transitionGuard(election, action, now)
    if (guard) return { action, available: false, reason: guard }
    if (action === 'publish') {
      return { action, available: true, reason: 'Publish this election so it can be scheduled.' }
    }
    return { action, available: true, reason: '' }
  })
}
