/**
 * Client transport for the election API.
 *
 * The client holds no authoritative state. It sends commands and renders what
 * the server returns, which is why there is no browser-local voting path: every
 * rule that matters is decided on the server.
 *
 * Four endpoints, matching `src/server/http.ts`:
 *
 * - `GET  /__api/state`    bootstrap read, unwrapped payload
 * - `GET  /__api/session`  current administrator session, unwrapped payload
 * - `POST /__api/auth`     sign-in, second factor, step-up re-authentication
 * - `POST /__api/command`  everything else, through the authorisation table
 *
 * The POST envelope is `{ action, payload }`. `action` is the name the server
 * routes on and the name the audit trail records, so the two are the same string
 * and an administrator can trace a log line back to a click.
 */

import type {
  ActionResult,
  BallotOption,
  BootstrapState,
  CandidateWithTally,
  ElectionResults,
  ElectionRules,
  ElectionSummary,
  ElectionType,
  EligibilityRules,
  RollVoterWithStatus,
  BallotReceipt,
} from './types'
import type {
  AdminAccount,
  ClientSession,
  AdminSessionSummary,
  ApprovalRequest,
  AuditEvent,
  BackupList,
  BackupRecord,
  DashboardData,
  MfaSetup,
  PagedResult,
  PlatformSettings,
  SecurityEvent,
  SecuritySummary,
  SystemHealth,
} from './adminTypes'
import type { Permission } from './rbac'
import { ValidationError } from './validate'

const STATE_ENDPOINT = '/__api/state'
const SESSION_ENDPOINT = '/__api/session'
const AUTH_ENDPOINT = '/__api/auth'
const COMMAND_ENDPOINT = '/__api/command'
/*
 * Voter sessions are server-managed.
 *
 * There is deliberately no token in `localStorage`. The session lives in an
 * `HttpOnly` cookie the page cannot read, so an injected script has nothing to
 * exfiltrate and there is no client-side copy to tamper with. What the client
 * has is a boolean — "this browser has a verified voter session" — which is not a
 * credential and is not trusted for anything.
 *
 * `X-Voter-Token` is still honoured for scripted and test clients, but the
 * browser flow never uses it.
 */
let voterSessionPresent = false

export function hasVoterSession(): boolean {
  return voterSessionPresent
}

export function markVoterSession(present: boolean): void {
  voterSessionPresent = present
}
const REQUEST_TIMEOUT_MS = 12_000

export class ServerUnavailableError extends Error {
  constructor() {
    // Kept free of formatting and instructions: the UI supplies its own
    // presentation and the restart command, so neither can be duplicated here.
    super('The election server is not reachable.')
    this.name = 'ServerUnavailableError'
  }
}

/** Offset in ms to add to the local clock to approximate the server clock. */
let serverOffsetMs = 0

export function serverNow(): number {
  return Date.now() + serverOffsetMs
}

export function getServerOffset(): number {
  return serverOffsetMs
}

/**
 * Adopt the server's clock from any response that reports it.
 *
 * Countdowns and "is voting open" checks are only as trustworthy as the clock
 * they use, so every response that carries `server_now` updates the offset. A
 * voter with a wrong local clock still sees the truth.
 */
function absorbServerClock(serverNow: unknown): void {
  if (typeof serverNow !== 'string') return
  const parsed = Date.parse(serverNow)
  if (Number.isFinite(parsed)) serverOffsetMs = parsed - Date.now()
}

/**
 * Whether a voter session cookie is present.
 *
 * The cookie is `HttpOnly`, so this cannot read it — it only reports what the
 * server last told us. It exists to let the interface avoid showing a pointless
 * "enter your code" form, and it is never used to decide whether a request is
 * authorised. Only the server decides that.
 */
export function voterSessionKnown(): boolean {
  return voterSessionPresent
}

export function forgetVoterSession(): void {
  voterSessionPresent = false
}

async function request<T>(url: string, init: RequestInit): Promise<T> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(url, { ...init, signal: controller.signal, credentials: 'same-origin' })
    const payload: unknown = await response.json().catch(() => null)
    if (!payload || typeof payload !== 'object') {
      throw new ServerUnavailableError()
    }
    return payload as T
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new ServerUnavailableError()
    }
    if (error instanceof TypeError) throw new ServerUnavailableError()
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

async function command<T>(name: string, payload: unknown = {}): Promise<ActionResult<T>> {
  // The voter session rides on an HttpOnly cookie, so there is no token to
  // attach here. `same-origin` makes the browser send it, and only to this origin.
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  const response = await request<{
    ok: boolean
    value?: T
    error?: string
    code?: string
    elevation?: 'reauth' | 'mfa' | 'two_person'
    reason?: string
    server_now?: string
  }>(COMMAND_ENDPOINT, { method: 'POST', headers, body: JSON.stringify({ action: name, payload }) })
  absorbServerClock(response.server_now)
  if (response.ok) return { ok: true, value: response.value as T }
  return {
    ok: false,
    error: response.error ?? 'The request could not be completed.',
    code: response.code ?? 'error',
    elevation: response.elevation,
    reason: response.reason,
  }
}

/**
 * Administrator sign-in and step-up authentication.
 *
 * These go to the auth endpoint rather than the command endpoint because they run
 * before a session exists and cannot use the standard authorisation path. They
 * are protected instead by the tighter sign-in rate limit, the account lockout
 * policy, and the rule that a password alone never opens a session once a second
 * factor is configured.
 */
async function auth<T>(action: string, payload: Record<string, unknown> = {}): Promise<ActionResult<T>> {
  const response = await request<{
    ok: boolean
    value?: T
    error?: string
    code?: string
    server_now?: string
  }>(AUTH_ENDPOINT, { method: 'POST', body: JSON.stringify({ action, payload }) })
  absorbServerClock(response.server_now)
  if (response.ok) return { ok: true, value: response.value as T }
  return { ok: false, error: response.error ?? 'The request could not be completed.', code: response.code ?? 'error' }
}

export const authApi = {
  /** True when the server still has no administrator account at all. */
  status: (username?: string) =>
    auth<{ needsBootstrap: boolean; mfaEnabled: boolean }>('mfa.status', username ? { username } : {}),
  bootstrap: (input: { username: string; password: string; display_name?: string }) =>
    auth<{ session: ClientSession; admin: AdminAccount }>('bootstrap', input),
  /** A password-accepted-but-no-session result is `mfaRequired`, not an error. */
  login: (username: string, password: string) =>
    auth<{ session: ClientSession | null; mfaRequired: boolean }>('login', { username, password }),
  mfaVerify: (username: string, code: string) =>
    auth<{ session: ClientSession }>('mfa.verify', { username, code }),
  logout: () => auth<{ signedOut: boolean }>('logout'),
  /** Re-enter the password to satisfy step-up elevation for a critical action. */
  reauthenticate: (password: string) => auth<{ verified: boolean; expiresInSeconds: number }>('reauthenticate', { password }),
  /** Re-present a second factor against the *current* session, for step-up. */
  mfaStepUp: (code: string) => auth<{ verified: boolean }>('mfa.stepup', { code }),
  mfaStatus: () => auth<{ enabled: boolean }>('mfa.manage', { action: 'status' }),
  /** Returns the secret, otpauth URI and single-use recovery codes exactly once. */
  mfaBegin: () => auth<{ setup: MfaSetup }>('mfa.manage', { action: 'begin' }),
  mfaConfirm: (code: string) => auth<{ enabled: boolean }>('mfa.manage', { action: 'confirm', code }),
  /** Requires the password, and a working code where a factor exists. */
  mfaDisable: (password: string, code: string) =>
    auth<{ enabled: boolean }>('mfa.manage', { action: 'disable', password, code }),
  changePassword: (currentPassword: string, newPassword: string) =>
    auth<{ changed: boolean }>('password.change', { currentPassword, newPassword }),
}

export type Bootstrap = BootstrapState & { revision: number }

export async function fetchState(): Promise<Bootstrap> {
  const response = await request<Bootstrap & { ok: boolean }>(STATE_ENDPOINT, { method: 'GET' })
  absorbServerClock(response.server_now)
  return {
    server_now: response.server_now,
    elections: response.elections ?? [],
    admins_exist: response.admins_exist === true,
    session: response.session ?? null,
    revision: Number(response.revision) || 0,
  }
}

/**
 * Read the current administrator session.
 *
 * Used by the control centre to recover a session that outlived the bootstrap
 * poll, and to pick up the platform's MFA requirement without a full reload.
 */
export async function fetchSession(): Promise<{ session: ClientSession | null; requireMfa: boolean }> {
  const response = await request<{ ok: boolean; session: ClientSession | null; requireMfa?: boolean; serverNow?: string }>(
    SESSION_ENDPOINT,
    { method: 'GET' },
  )
  absorbServerClock(response.serverNow)
  return { session: response.session ?? null, requireMfa: response.requireMfa === true }
}

/* -------------------------------------------------------------- control --- */

export type AuditQueryResult = PagedResult<AuditEvent> & { actions: string[] }

export type SecurityQueryResult = {
  rows: SecurityEvent[]
  total: number
  summary: SecuritySummary
}

export type TwoPersonRequest = {
  permission: Permission
  action: string
  resource: string
  electionId?: string | null
  payloadSummary: string
  justification: string
  payload?: Record<string, unknown>
}

/**
 * Administrative control plane.
 *
 * Every call here is authorised server side by the table in
 * `src/server/authorize.ts`. The client sends intents and renders refusals; it
 * has no way to make a call succeed that the server would refuse, which is why
 * the interface can hide controls without that being the enforcement.
 */
export const controlApi = {
  /** Everything the dashboard renders, in one authorised read. */
  dashboard: () => command<DashboardData>('control.dashboard'),
  health: () => command<{ health: SystemHealth }>('control.system.health'),

  audit: (query: {
    electionId?: string
    actor?: string
    action?: string
    result?: 'success' | 'denied' | 'failure'
    search?: string
    since?: string
    until?: string
    limit?: number
    offset?: number
  } = {}) => command<AuditQueryResult>('control.audit.query', query),

  security: (query: {
    kind?: string
    severity?: string
    search?: string
    acknowledged?: boolean
    since?: string
    until?: string
    limit?: number
    offset?: number
  } = {}) => command<SecurityQueryResult>('control.security.query', query),
  acknowledgeSecurityEvent: (id: number) => command<{ id: number }>('control.security.acknowledge', { id }),

  sessions: () => command<{ sessions: AdminSessionSummary[] }>('control.sessions.list'),
  revokeSession: (token: string, reason: string) => command<{ revoked: boolean }>('control.session.revoke', { token, reason }),
  revokeAllSessions: (adminId: number) => command<{ revoked: number }>('control.session.revokeAll', { adminId }),

  backups: () => command<BackupList>('control.backups.list'),
  createBackup: (label: string, note: string) =>
    command<{ backup: BackupRecord; pruned: number }>('control.backup.create', { label, note }),
  /** Destructive and two-person: pass the token from an approved request. */
  restoreBackup: (id: number, approvalToken?: string) =>
    command<{ restored: number; safetyBackupId: number }>('control.backup.restore', { id, approvalToken }),

  settings: () => command<{ settings: PlatformSettings }>('control.settings.read'),
  writeSettings: (settings: Partial<PlatformSettings>, approvalToken?: string) =>
    command<{ settings: PlatformSettings }>('control.settings.write', { settings, approvalToken }),

  approvals: (status: 'pending' | 'approved' | 'rejected' | 'expired' | 'executed' | 'all' = 'pending') =>
    command<{ approvals: ApprovalRequest[] }>('control.approvals.list', { status }),
  /**
   * Open an approval request. The server checks the caller already holds the
   * permission being requested, so this cannot be used to escalate.
   */
  requestApproval: (input: TwoPersonRequest) =>
    command<{ approval: ApprovalRequest }>('control.approval.create', input),
  decideApproval: (id: number, decision: 'approved' | 'rejected', note: string) =>
    command<{ id: number; status: string }>('control.approval.decide', { id, decision, note }),

  accounts: () => command<{ admins: AdminAccount[] }>('control.accounts.list'),
  createAccount: (input: { username: string; password: string; display_name: string; role: string }, approvalToken?: string) =>
    command<{ admin: AdminAccount }>('control.account.create', { ...input, approvalToken }),
  updateAccount: (
    adminId: number,
    patch: { role?: string; disabled?: boolean; unlock?: boolean },
    approvalToken?: string,
  ) => command<{ admin: AdminAccount }>('control.account.update', { adminId, ...patch, approvalToken }),
  resetAccountPassword: (adminId: number, newPassword: string, approvalToken?: string) =>
    command<{ adminId: number }>('control.account.password', { adminId, newPassword, approvalToken }),

  /** Irreversible and two-person: pass the token from an approved request. */
  resetSystem: (keepAdmins: boolean, approvalToken?: string) =>
    command<{ reset: true; safetyBackupId: number; keepAdmins: boolean }>('control.system.reset', {
      confirm: 'RESET',
      keepAdmins,
      approvalToken,
    }),
}

/* ------------------------------------------------------------- election --- */

export type ElectionDetail = {
  election: ElectionSummary
  candidates: CandidateWithTally[]
  preview: import('./types').BallotPreview
  /**
   * The voter roll, present only after a separate permission-gated read. It is
   * never part of the public `election.get` response.
   */
  roll: import('./types').RedactedRollVoter[]
}

/**
 * The voter roll, as the server chose to release it.
 *
 * Personal data is masked unless the signed-in role holds `voter.view_pii`. There
 * are no codes to withhold, because none exist: the server issues a fresh one per
 * attempt and never stores it, so the roll carries contact details and nothing
 * replayable. The `can_verify_by_*` flags report whether a code could be delivered
 * on each channel. The server decides all of this; this type exists so the
 * interface cannot ask for something that is not there.
 */
export type RollResult = {
  roll: import('./types').RedactedRollVoter[]
  can_view_personal_data: boolean
}

/**
 * Voter participation, per voter.
 *
 * There is no selections field, and none may be added. Ballot choices are stored
 * in a table with no voter column, so this report cannot include them even if a
 * future change wanted it to — the shape here matches the data, rather than the
 * data being bent to fit a shape that would be useful to somebody.
 */
export type ParticipationRow = {
  voter_record_id: number
  voter_id: string
  eligibility: 'eligible' | 'ineligible'
  eligibility_reason: string
  eligibility_decided_at: string | null
  has_voted: 0 | 1
  participated_at: string | null
  can_verify_by_phone: boolean
  can_verify_by_email: boolean
}

export type ParticipationResult = {
  election_id: string
  rows: ParticipationRow[]
  summary: { on_roll: number; eligible: number; participated: number; ballots: number }
  note: string
}
export type CreateElectionInput = {
  title: string
  description: string
  election_type: ElectionType
  timezone: string
  starts_at: string
  ends_at: string
  rules?: Partial<ElectionRules>
  eligibility?: Partial<EligibilityRules>
}

export type CandidateInput = {
  name: string
  organization?: string
  abbreviation?: string
  description?: string
  image_url?: string
  symbol?: string
  position?: number
  status?: string
}

export type RollVoterInput = {
  voter_id: string
  full_name: string
  phone?: string
  email?: string
  phone_otp?: string
  email_otp?: string
  external_ref?: string
  is_eligible?: boolean
}

export const electionApi = {
  list: (includeArchived = false) =>
    command<{ elections: ElectionSummary[] }>('election.list', { includeArchived }),
  get: (electionId: string) => command<ElectionDetail>('election.get', { electionId }),
  /**
   * Read the voter roll. Requires an administrator session with `voter.view`;
   * contact details additionally need `voter.view_pii`, and there are no codes to
   * return because none are stored. Kept separate from `election.get` so the public
   * pre-auth read can never carry voter records.
   */
  roll: (electionId: string) => command<RollResult>('election.roll', { electionId }),
  /**
   * Who voted, and who did not. No selections, by construction.
   *
   * This is the report an officer uses for turnout. It is deliberately a different
   * command from `results`, so that neither can be extended into the other without
   * also merging identity and choice.
   */
  participation: (electionId: string) => command<ParticipationResult>('election.participation', { electionId }),
  create: (input: CreateElectionInput) => command<{ election: ElectionSummary }>('election.create', input),
  update: (electionId: string, patch: Record<string, unknown>) =>
    command<{ election: ElectionSummary }>('election.update', { electionId, patch }),
  setRules: (electionId: string, rules: ElectionRules) =>
    command<{ election: ElectionSummary }>('election.setRules', { electionId, rules }),
  setEligibility: (electionId: string, eligibility: EligibilityRules) =>
    command<{ election: ElectionSummary }>('election.setEligibility', { electionId, eligibility }),
  remove: (electionId: string) => command<{ deleted: string }>('election.delete', { electionId }),

  addCandidate: (electionId: string, candidate: CandidateInput) =>
    command<{ candidate: CandidateWithTally }>('election.candidate.add', { electionId, candidate }),
  updateCandidate: (electionId: string, candidateId: number, patch: Record<string, unknown>) =>
    command<{ candidate: CandidateWithTally }>('election.candidate.update', { electionId, candidateId, patch }),
  setCandidateStatus: (electionId: string, candidateId: number, status: string, reason?: string) =>
    command<{ candidate: CandidateWithTally }>('election.candidate.setStatus', { electionId, candidateId, status, reason }),
  removeCandidate: (electionId: string, candidateId: number) =>
    command<{ removed: number }>('election.candidate.remove', { electionId, candidateId }),
  reorderCandidates: (electionId: string, order: number[]) =>
    command<{ candidates: CandidateWithTally[] }>('election.candidate.reorder', { electionId, order }),

  addVoters: (electionId: string, voters: RollVoterInput[]) =>
    command<{ added: number; skipped: string[]; roll: RollVoterWithStatus[] }>('election.voters.add', { electionId, voters }),
  removeVoters: (electionId: string, voterRecordIds: number[]) =>
    command<{ removed: number; roll: RollVoterWithStatus[] }>('election.voters.remove', { electionId, voterRecordIds }),
  setVoterEligibility: (electionId: string, voterRecordIds: number[], eligible: boolean) =>
    command<{ updated: number; roll: RollVoterWithStatus[] }>('election.voters.setEligibility', {
      electionId,
      voterRecordIds,
      eligible,
    }),

  preview: (electionId: string) => command<{ preview: import('./types').BallotPreview }>('election.preview', { electionId }),
  /**
   * Drive a lifecycle transition. Opening, closing, certifying and reopening are
   * separately permissioned server side and may demand elevation, so a failure
   * here can come back asking for a password or a second approver.
   */
  transition: (electionId: string, action: string, note?: string, approvalToken?: string) =>
    command<{ election: ElectionSummary }>('election.transition', { electionId, action, note, approvalToken }),
  results: (electionId: string) => command<{ results: ElectionResults }>('election.results', { electionId }),
  /** Per-election slice of the audit trail. The full log is `controlApi.audit`. */
  audit: (electionId?: string, limit = 100) =>
    command<{ events: AuditEvent[] }>('election.audit', { electionId, limit }),
}

/* --------------------------------------------------------------- voter --- */

export type VoterBeginResult = {
  election: ElectionSummary
  /**
   * The voter, or null.
   *
   * Always null while the election requires a code: typing an identifier proves
   * nothing, so the server withholds the name, the masked contacts and the fact
   * of being on the roll until the code is produced. The identity arrives with the
   * `voter.verify` result instead.
   */
  voter: { voter_id: string; full_name: string; masked_phone: string; masked_email: string; group: string } | null
  requires_code: boolean
  /** One slot per channel the election requires, always the same count for everyone. */
  challenges: VoterChallenge[]
  /**
   * Shown only in development, where there is no SMS or mail gateway.
   *
   * Populated for unknown identifiers too, with a code that will not work, so that
   * switching the flag on does not quietly turn the form into an enumeration
   * oracle.
   */
  demo_codes: { phone?: string; email?: string } | null
}

export type VoterChallenge = {
  channel: 'phone' | 'email'
  /**
   * Opaque handle for this code. Says nothing about the code itself.
   *
   * A handle that resolves to no code is given to an identifier that is not on
   * the roll, so that the response is identical either way and the form cannot be
   * used to discover who is registered.
   */
  challenge_id: string
  expires_in: number
  /** Digit count of the code, so the input can be sized to accept it. */
  digits: number
}

export type VoterVerifyResult = {
  /** No token in the body: the session and credential are both set as HttpOnly cookies. */
  verified: true
  voter: { voter_id: string; full_name: string; has_voted: 0 | 1 }
  /** Whether this voter has already voted, from the participation record. */
  has_voted: boolean
  /**
   * When the voting credential expires, or null if the voter has already voted and
   * so was not issued one. The credential itself never crosses the wire.
   */
  credential: { expires_at: string; election_id: string } | null
  election: ElectionSummary
}

export type VoterBallotResult = {
  election: ElectionSummary
  options: BallotOption[]
  rules: ElectionRules
  eligibility: EligibilityRules
  /**
   * Whether this voter has voted.
   *
   * There is no `votes` field, and there must not be one: it used to be the voter's
   * own selections, looked up by their identity. Asking the server "what did I vote
   * for" by identity is exactly the question the ballot store is now unable to
   * answer, which is the intended outcome rather than a gap to fill.
   */
  has_voted: boolean
  /** Whether a live credential is held, so the interface can offer a fresh one. */
  can_vote: boolean
  credential: { expires_at: string } | null
  results: ElectionResults
}

/** What the server returns after a ballot is recorded. */
export type VoterVoteResult = {
  recorded: true
  /** Receipt codes, so the voter can prove their ballot was counted. */
  receipts: string[]
  submitted_at: string
  /** Keyed digest over the stored ballot. Verifiable, not reversible. */
  integrity_digest: string
  election: ElectionSummary
  results: ElectionResults
}

export const voterApi = {
  begin: (electionId: string, voterId: string) => command<VoterBeginResult>('voter.begin', { electionId, voterId }),
  verify: (electionId: string, voterId: string, answers: { challenge_id: string; code: string }[]) =>
    command<VoterVerifyResult>('voter.verify', { electionId, voterId, answers }),
  logout: (electionId: string) => command<{ signedOut: boolean }>('voter.logout', { electionId }),
  ballot: (electionId: string) => command<VoterBallotResult>('voter.ballot', { electionId }),
  /**
   * Cast a ballot.
   *
   * Authorised by the voting credential cookie, not by the session. The page sends
   * no credential and holds none: the server issued it at verification, set it as
   * an `HttpOnly` cookie, and now consumes it.
   */
  vote: (electionId: string, candidateIds: number[]) =>
    command<VoterVoteResult>('voter.vote', { electionId, candidateIds }),
  /** Ask for a fresh credential when the previous one has expired. */
  credential: (electionId: string) =>
    command<{ credential: { expires_at: string; election_id: string } }>('voter.credential', { electionId }),
  /**
   * Look up a ballot by receipt code.
   *
   * The only route from a ballot back to its contents, and it is keyed on a secret
   * the voter holds rather than on who they are.
   */
  receipt: (electionId: string, code?: string) =>
    command<{ receipt: BallotReceipt }>('voter.receipt', { electionId, ...(code ? { receipt: code } : {}) }),
}

export { ValidationError }
