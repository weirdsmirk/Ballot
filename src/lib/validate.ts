/**
 * Payload parsing and validation shared by the server and the client.
 *
 * The server treats every value that arrives over HTTP as untrusted and runs it
 * through these parsers before it reaches the database. The client uses the same
 * parsers for pre-flight feedback, so a form that passes here will not be
 * rejected by the server for a shape reason.
 */

import {
  CANDIDATE_STATUSES,
  ELECTION_STATUSES,
  ELECTION_TYPES,
  ELIGIBILITY_MODES,
  RESULTS_VISIBILITIES,
  type Candidate,
  type CandidateStatus,
  type Election,
  type ElectionRules,
  type ElectionStatus,
  type ElectionType,
  type EligibilityRules,
  type RollVoter,
} from './types'
import { isValidTimeZone } from './time'

export class ValidationError extends Error {
  constructor(message: string, readonly field?: string) {
    super(message)
    this.name = 'ValidationError'
  }
}

export function defaultRules(): ElectionRules {
  return {
    votesPerVoter: 1,
    allowNotA: false,
    allowAbstain: false,
    requireOtp: true,
    requirePhone: true,
    requireEmail: true,
    resultsVisibility: 'after_close',
    allowVoteChange: false,
    issueReceipts: true,
    randomizeBallotOrder: false,
    showCandidateImages: true,
  }
}

export function defaultEligibility(): EligibilityRules {
  return {
    mode: 'roll',
    identifierLabel: 'Voter ID',
    groupLabel: 'Group',
    notes: '',
  }
}

function record(value: unknown, label = 'payload'): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError(`Invalid ${label}.`)
  }
  return value as Record<string, unknown>
}

function optionalString(value: unknown, max: number, field: string, fallback = ''): string {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'string') throw new ValidationError(`${field} must be text.`, field)
  const trimmed = value.trim()
  if (trimmed.length > max) throw new ValidationError(`${field} must be ${max} characters or fewer.`, field)
  return trimmed
}

function requiredString(value: unknown, max: number, field: string): string {
  const result = optionalString(value, max, field)
  if (!result) throw new ValidationError(`${field} is required.`, field)
  return result
}

function bool(value: unknown, field: string, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'boolean') throw new ValidationError(`${field} must be true or false.`, field)
  return value
}

function boundedInt(value: unknown, min: number, max: number, field: string, fallback: number): number {
  if (value === undefined || value === null) return fallback
  const numeric = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  if (typeof numeric !== 'number' || !Number.isFinite(numeric)) {
    throw new ValidationError(`${field} must be a number.`, field)
  }
  const rounded = Math.trunc(numeric)
  if (rounded < min || rounded > max) {
    throw new ValidationError(`${field} must be between ${min} and ${max}.`, field)
  }
  return rounded
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string, fallback?: T): T {
  if (value === undefined || value === null || value === '') {
    if (fallback !== undefined) return fallback
    throw new ValidationError(`${field} is required.`, field)
  }
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new ValidationError(`${field} must be one of: ${allowed.join(', ')}.`, field)
  }
  return value as T
}

function instant(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new ValidationError(`${field} is required.`, field)
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) throw new ValidationError(`${field} must be a valid date and time.`, field)
  return new Date(timestamp).toISOString()
}

export function parseElectionId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$/.test(value)) {
    throw new ValidationError('Invalid election ID.', 'electionId')
  }
  return value
}

export function parseRules(value: unknown, base: ElectionRules = defaultRules()): ElectionRules {
  if (value === undefined || value === null) return base
  const raw = record(value, 'voting rules')
  return {
    votesPerVoter: boundedInt(raw.votesPerVoter, 1, 20, 'Votes per voter', base.votesPerVoter),
    allowNotA: bool(raw.allowNotA, 'None of the Above option', base.allowNotA),
    allowAbstain: bool(raw.allowAbstain, 'Abstain option', base.allowAbstain),
    requireOtp: bool(raw.requireOtp, 'One-time codes', base.requireOtp),
    requirePhone: bool(raw.requirePhone, 'Phone verification', base.requirePhone),
    requireEmail: bool(raw.requireEmail, 'Email verification', base.requireEmail),
    resultsVisibility: oneOf(raw.resultsVisibility, RESULTS_VISIBILITIES, 'Results visibility', base.resultsVisibility),
    // Accepted and ignored. Changing a ballot requires being able to find it, which
    // requires linking it to a voter, which the ballot store deliberately cannot do.
    allowVoteChange: false,
    issueReceipts: bool(raw.issueReceipts, 'Issue receipts', base.issueReceipts),
    randomizeBallotOrder: bool(raw.randomizeBallotOrder, 'Randomise ballot order', base.randomizeBallotOrder),
    showCandidateImages: bool(raw.showCandidateImages, 'Show candidate images', base.showCandidateImages),
  }
}

export function parseEligibility(value: unknown, base: EligibilityRules = defaultEligibility()): EligibilityRules {
  if (value === undefined || value === null) return base
  const raw = record(value, 'eligibility rules')
  const mode = oneOf(raw.mode, ELIGIBILITY_MODES, 'Eligibility mode', base.mode)
  return {
    mode,
    identifierLabel: optionalString(raw.identifierLabel, 60, 'Identifier label', base.identifierLabel) || 'Voter ID',
    groupLabel: optionalString(raw.groupLabel, 60, 'Group label', base.groupLabel),
    notes: optionalString(raw.notes, 500, 'Eligibility notes', base.notes),
  }
}

export type ElectionDraftInput = {
  title: string
  description: string
  election_type: ElectionType
  timezone: string
  starts_at: string
  ends_at: string
  rules: ElectionRules
  eligibility: EligibilityRules
}

export function parseElectionDraft(value: unknown): ElectionDraftInput {
  const raw = record(value, 'election')
  const timezone = optionalString(raw.timezone, 64, 'Timezone', 'UTC') || 'UTC'
  if (!isValidTimeZone(timezone)) {
    throw new ValidationError(`"${timezone}" is not a recognised IANA timezone.`, 'timezone')
  }
  const rules = parseRules(raw.rules)
  const eligibility = parseEligibility(raw.eligibility)
  const startsAt = instant(raw.starts_at, 'Scheduled start')
  const endsAt = instant(raw.ends_at, 'Scheduled end')
  if (Date.parse(endsAt) <= Date.parse(startsAt)) {
    throw new ValidationError('The scheduled end time must be after the start time.', 'ends_at')
  }
  return {
    title: requiredString(raw.title, 160, 'Title'),
    description: optionalString(raw.description, 2000, 'Description'),
    election_type: oneOf(raw.election_type, ELECTION_TYPES, 'Election type', 'general'),
    timezone,
    starts_at: startsAt,
    ends_at: endsAt,
    rules,
    eligibility,
  }
}

export type ElectionPatchInput = Partial<ElectionDraftInput>

export function parseElectionPatch(value: unknown): ElectionPatchInput {
  const raw = record(value, 'election changes')
  const patch: ElectionPatchInput = {}
  if ('title' in raw) patch.title = optionalString(raw.title, 160, 'Title')
  if ('description' in raw) patch.description = optionalString(raw.description, 2000, 'Description')
  if ('election_type' in raw) patch.election_type = oneOf(raw.election_type, ELECTION_TYPES, 'Election type')
  if ('timezone' in raw) {
    const timezone = requiredString(raw.timezone, 64, 'Timezone')
    if (!isValidTimeZone(timezone)) {
      throw new ValidationError(`"${timezone}" is not a recognised IANA timezone.`, 'timezone')
    }
    patch.timezone = timezone
  }
  if ('starts_at' in raw) patch.starts_at = instant(raw.starts_at, 'Scheduled start')
  if ('ends_at' in raw) patch.ends_at = instant(raw.ends_at, 'Scheduled end')
  if ('rules' in raw) patch.rules = parseRules(raw.rules)
  if ('eligibility' in raw) patch.eligibility = parseEligibility(raw.eligibility)
  if (patch.starts_at && patch.ends_at && Date.parse(patch.ends_at) <= Date.parse(patch.starts_at)) {
    throw new ValidationError('The scheduled end time must be after the start time.', 'ends_at')
  }
  if (Object.keys(patch).length === 0) {
    throw new ValidationError('No changes were supplied.')
  }
  return patch
}

export type CandidateInput = {
  name: string
  organization: string
  abbreviation: string
  description: string
  image_url: string
  symbol: string
  position: number
  status: CandidateStatus
}

const MAX_IMAGE_URL = 500

function parseImageUrl(value: unknown, field: string): string {
  const url = optionalString(value, MAX_IMAGE_URL, field)
  if (!url) return ''
  if (!/^(https?:\/\/|\/)/i.test(url)) {
    throw new ValidationError(`${field} must be an http(s) URL or a root-relative path.`, field)
  }
  return url
}

export function parseCandidateInput(value: unknown, existingCount: number): CandidateInput {
  const raw = record(value, 'candidate')
  const abbreviation = optionalString(raw.abbreviation, 16, 'Abbreviation')
  const organization = optionalString(raw.organization, 120, 'Party or organisation')
  if (abbreviation && !/^[A-Za-z0-9.\- ]{1,16}$/.test(abbreviation)) {
    throw new ValidationError('Abbreviation may only contain letters, numbers, spaces, dots and hyphens.', 'abbreviation')
  }
  return {
    name: requiredString(raw.name, 120, 'Candidate name'),
    organization,
    abbreviation,
    description: optionalString(raw.description, 1000, 'Description'),
    image_url: parseImageUrl(raw.image_url, 'Image'),
    symbol: optionalString(raw.symbol, 8, 'Symbol'),
    position: boundedInt(raw.position, 1, 500, 'Ballot position', existingCount + 1),
    status: oneOf(raw.status, CANDIDATE_STATUSES, 'Candidate status', 'approved'),
  }
}

export function parseCandidatePatch(value: unknown): Partial<CandidateInput> {
  const raw = record(value, 'candidate changes')
  const patch: Partial<CandidateInput> = {}
  if ('name' in raw) patch.name = optionalString(raw.name, 120, 'Candidate name')
  if ('organization' in raw) patch.organization = optionalString(raw.organization, 120, 'Party or organisation')
  if ('abbreviation' in raw) {
    const abbreviation = optionalString(raw.abbreviation, 16, 'Abbreviation')
    if (abbreviation && !/^[A-Za-z0-9.\- ]{1,16}$/.test(abbreviation)) {
      throw new ValidationError('Abbreviation may only contain letters, numbers, spaces, dots and hyphens.', 'abbreviation')
    }
    patch.abbreviation = abbreviation
  }
  if ('description' in raw) patch.description = optionalString(raw.description, 1000, 'Description')
  if ('image_url' in raw) patch.image_url = parseImageUrl(raw.image_url, 'Image')
  if ('symbol' in raw) patch.symbol = optionalString(raw.symbol, 8, 'Symbol')
  if ('position' in raw) patch.position = boundedInt(raw.position, 1, 500, 'Ballot position', 1)
  if ('status' in raw) patch.status = oneOf(raw.status, CANDIDATE_STATUSES, 'Candidate status')
  if (Object.keys(patch).length === 0) throw new ValidationError('No changes were supplied.')
  return patch
}

export type RollVoterInput = {
  voter_id: string
  full_name: string
  phone: string
  email: string
  external_ref: string
  is_eligible: 0 | 1
}

export function parseRollVoterInput(value: unknown, index: number): RollVoterInput {
  const raw = record(value, 'voter')
  const label = `Voter ${index + 1}`
  const voterId = requiredString(raw.voter_id, 32, `${label} identifier`).toUpperCase()
  if (!/^[A-Z0-9][A-Z0-9_-]{2,31}$/.test(voterId)) {
    throw new ValidationError(
      `${label} identifier must be 3-32 characters using letters, numbers, hyphens or underscores.`,
      'voter_id',
    )
  }
  const phone = optionalString(raw.phone, 20, `${label} phone`)
  const email = optionalString(raw.email, 254, `${label} email`).toLowerCase()
  if (phone && !/^\+?[0-9 ()-]{6,20}$/.test(phone)) {
    throw new ValidationError(`${label} phone number contains unsupported characters.`, 'phone')
  }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ValidationError(`${label} email address is not valid.`, 'email')
  }
  /*
   * No passcode fields.
   *
   * Verification codes are generated by the server per attempt and never stored,
   * so a roll record holds contact details and nothing that can be replayed as a
   * ballot. A pasted list that still carries `phone_otp` columns is accepted and
   * the columns ignored, rather than failing an import somebody already has.
   */
  return {
    voter_id: voterId,
    full_name: requiredString(raw.full_name, 120, `${label} name`),
    phone,
    email,
    external_ref: optionalString(raw.external_ref, 80, `${label} group`),
    is_eligible: raw.is_eligible === false || raw.is_eligible === 0 ? 0 : 1,
  }
}

/** Accepts either a single voter object or an array of them. */
export function parseRollVoterBatch(value: unknown, maxBatch = 500): RollVoterInput[] {
  const list = Array.isArray(value) ? value : [value]
  if (list.length === 0) throw new ValidationError('No voters were supplied.')
  if (list.length > maxBatch) {
    throw new ValidationError(`At most ${maxBatch} voters can be added in one batch.`)
  }
  const parsed = list.map((item, index) => parseRollVoterInput(item, index))
  const seen = new Set<string>()
  for (const voter of parsed) {
    if (seen.has(voter.voter_id)) {
      throw new ValidationError(`Duplicate identifier ${voter.voter_id} in this batch.`, 'voter_id')
    }
    seen.add(voter.voter_id)
  }
  return parsed
}

export function parseUsername(value: unknown): string {
  const username = requiredString(value, 40, 'Username').toLowerCase()
  if (!/^[a-z0-9][a-z0-9._-]{2,39}$/.test(username)) {
    throw new ValidationError(
      'Username must be 3-40 characters using letters, numbers, dots, hyphens or underscores.',
      'username',
    )
  }
  return username
}

export function parsePassword(value: unknown): string {
  if (typeof value !== 'string') throw new ValidationError('Password is required.', 'password')
  if (value.length < 10) throw new ValidationError('Password must be at least 10 characters.', 'password')
  if (value.length > 200) throw new ValidationError('Password must be 200 characters or fewer.', 'password')
  return value
}

export function parseDisplayName(value: unknown): string {
  return optionalString(value, 80, 'Display name') || 'Administrator'
}

export function parseStatus(value: unknown): ElectionStatus {
  return oneOf(value, ELECTION_STATUSES, 'Election status')
}

export function parsePositiveInt(value: unknown, field: string, max = Number.MAX_SAFE_INTEGER): number {
  return boundedInt(value, 1, max, field, 1)
}

export function parseIdList(value: unknown, field: string, max = 200): number[] {
  if (!Array.isArray(value)) throw new ValidationError(`${field} must be a list.`, field)
  if (value.length > max) throw new ValidationError(`${field} may contain at most ${max} entries.`, field)
  return value.map((item, index) => {
    if (typeof item !== 'number' || !Number.isSafeInteger(item) || item <= 0) {
      throw new ValidationError(`${field} entry ${index + 1} is not a valid identifier.`, field)
    }
    return item
  })
}

export type { Candidate, Election, RollVoter }
