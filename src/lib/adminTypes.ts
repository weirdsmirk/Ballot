/**
 * Administrative control plane types.
 *
 * Kept separate from the voter-facing domain types in `./types` so the shape of
 * the operations dashboard, RBAC records, and security records stays readable.
 */

import type { AdminRole, Permission } from './rbac'
import type { ElectionStatus, ElectionSummary } from './types'

/* ------------------------------------------------------- administrators --- */

export type AdminAccount = {
  id: number
  username: string
  display_name: string
  role: AdminRole
  created_at: string
  last_login_at: string | null
  mfa_enabled: boolean
  /** Timestamped when the account locks after repeated failures. */
  locked_until: string | null
  failed_attempts: number
  must_change_password: boolean
  disabled: boolean
}

export type AdminSession = {
  /**
   * The bearer token.
   *
   * Server-side only. It is minted at sign-in, handed to the transport, and set as
   * an `HttpOnly` cookie; it is never serialised into a response body, so the
   * browser never holds a copy and this field is absent from anything the client
   * receives. {@link ClientSession} is the shape that crosses the wire.
   */
  token: string
  admin: AdminAccount
  expires_at: string
  /** When the second factor was last satisfied for this session. */
  mfa_verified_at: string | null
  /** When the password was last re-entered, for step-up elevation. */
  reauth_verified_at: string | null
  created_at: string
  ip: string | null
}

/**
 * A session as the client sees it: the same facts, minus the credential.
 *
 * The interface uses this to decide what to show. It is never a basis for
 * authorisation — the server decides that on every request from the cookie — so
 * losing it on a reload is harmless, as the client simply asks again.
 */
export type ClientSession = Omit<AdminSession, 'token'>

export type AdminSessionSummary = {
  id: number
  admin_id: number
  username: string
  display_name: string
  role: AdminRole
  created_at: string
  expires_at: string
  last_seen_at: string | null
  ip: string | null
  revoked_at: string | null
  revoked_reason: string | null
  mfa_verified_at: string | null
  current: boolean
}

export type MfaSetup = {
  secret: string
  uri: string
  /** Shown once, never stored in plain text. */
  recovery_codes: string[]
}

/* ---------------------------------------------------------- audit trail --- */

export type AuditResult = 'success' | 'denied' | 'failure'

export type AuditEvent = {
  id: number
  request_id: string
  election_id: string | null
  actor_type: 'admin' | 'system' | 'voter'
  actor_id: string | null
  actor_label: string
  actor_role: AdminRole | null
  action: string
  resource: string
  result: AuditResult
  from_status: string | null
  to_status: string | null
  summary: string
  /** Safe metadata only: never passwords, tokens, or passcodes. */
  detail: string
  ip: string | null
  created_at: string
}

export type AuditQuery = {
  electionId?: string
  actor?: string
  action?: string
  result?: AuditResult
  search?: string
  since?: string
  until?: string
  limit?: number
  offset?: number
}

export type PagedResult<T> = {
  rows: T[]
  total: number
  limit: number
  offset: number
}

/* ------------------------------------------------------------- security --- */

export type SecurityEventSeverity = 'info' | 'notice' | 'warning' | 'critical'
export type SecurityEventKind =
  | 'login_success'
  | 'login_failure'
  | 'account_locked'
  | 'account_unlocked'
  | 'logout'
  | 'session_revoked'
  | 'mfa_enabled'
  | 'mfa_disabled'
  | 'mfa_failed'
  | 'mfa_recovery_used'
  | 'password_changed'
  | 'rate_limited'
  | 'permission_denied'
  | 'elevation_required'
  | 'voter_verified'
  | 'voter_verification_failed'
  | 'voter_verification_new_address'
  | 'voter_session_replayed'
  | 'ballot_credential_rejected'
  | 'ballot_cast'
  | 'voter_signed_out'
  | 'backup_created'
  | 'backup_restored'
  | 'system_reset'
  | 'admin_created'
  | 'admin_role_changed'
  | 'admin_disabled'
  | 'origin_rejected'

export type SecurityEvent = {
  id: number
  request_id: string
  kind: SecurityEventKind
  severity: SecurityEventSeverity
  admin_id: number | null
  admin_label: string
  summary: string
  detail: string
  ip: string | null
  /** True until an administrator acknowledges it. */
  acknowledged: boolean
  acknowledged_by: number | null
  acknowledged_at: string | null
  created_at: string
}

export type SecuritySummary = {
  unacknowledged_critical: number
  unacknowledged_warning: number
  failed_logins_24h: number
  rate_limited_24h: number
  locked_accounts: number
  active_sessions: number
  /** Accounts that still have no second factor. */
  admins_without_mfa: number
  recent: SecurityEvent[]
}

/* -------------------------------------------------------------- backups --- */

export type BackupRecord = {
  id: number
  label: string
  filename: string
  size_bytes: number
  created_at: string
  created_by: number | null
  created_by_label: string
  kind: 'manual' | 'scheduled' | 'pre_restore' | 'pre_reset'
  election_count: number
  vote_count: number
  admin_count: number
  checksum: string
  note: string
}

export type BackupList = {
  backups: BackupRecord[]
  directory: string
  /** Backups are stored outside Git; reported so operators can find them. */
  total_size_bytes: number
}

/* ------------------------------------------------------------- approvals --- */

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'executed'

export type ApprovalRequest = {
  id: number
  token: string
  request_id: string
  permission: Permission
  action: string
  resource: string
  election_id: string | null
  payload_summary: string
  justification: string
  status: ApprovalStatus
  requested_by: number
  requested_by_label: string
  requested_at: string
  expires_at: string
  decided_by: number | null
  decided_by_label: string | null
  decided_at: string | null
  decision_note: string
  executed_at: string | null
}

/* -------------------------------------------------------------- settings --- */

export type PlatformSettings = {
  /** Whether administrators may create more accounts. */
  allowAdminCreation: boolean
  /** How long a voter verification code stays usable. */
  otpTtlSeconds: number
  /** Wrong guesses allowed against a code before it locks. */
  otpMaxAttempts: number
  /** How long a code stays locked after its attempts are used up. */
  otpLockoutSeconds: number
  /** Minimum gap between issuing codes for the same voter. */
  otpResendCooldownSeconds: number
  /** Length of a generated code. Six is the default; raise it if your gateway allows. */
  otpDigits: number
  /**
   * How long a voting credential stays usable.
   *
   * A credential is the right to cast one ballot, issued after authentication.
   * Kept short on purpose: it is a bearer token, so its lifetime is the blast
   * radius if one is ever stolen.
   */
  credentialTtlSeconds: number
  /** Sessions idle out after this many minutes. */
  sessionIdleMinutes: number
  /** Sign-in attempts allowed per account before lockout. */
  maxLoginAttempts: number
  /** Minutes an account stays locked. */
  lockoutMinutes: number
  /**
   * Failed requests per window before rate limiting engages.
   *
   * Generous compared with the sign-in budget, because the control centre makes
   * several authorised reads per screen and the voter portal polls on a timer.
   * Sign-in, bootstrap and second-factor attempts have their own, much smaller
   * budget keyed on the account as well as the address — see `http.ts`.
   */
  rateLimitRequests: number
  rateLimitWindowSeconds: number
  /** Require a second factor for every administrator. */
  requireMfa: boolean
  /** Keep this many automatic backups. */
  backupRetention: number
  /** Show live tallies to voters before the poll closes. */
  defaultResultsVisibility: 'live' | 'after_close' | 'after_certify' | 'never'
  /** Display voter one-time codes in the voter flow. Never enable with real voters. */
  revealDemoPasscodes: boolean
  maintenanceMode: boolean
}

export const DEFAULT_SETTINGS: PlatformSettings = {
  allowAdminCreation: true,
  otpTtlSeconds: 300,
  otpMaxAttempts: 5,
  otpLockoutSeconds: 300,
  otpResendCooldownSeconds: 30,
  otpDigits: 6,
  credentialTtlSeconds: 900,
  sessionIdleMinutes: 240,
  maxLoginAttempts: 5,
  lockoutMinutes: 15,
  rateLimitRequests: 240,
  rateLimitWindowSeconds: 60,
  requireMfa: false,
  backupRetention: 10,
  defaultResultsVisibility: 'after_close',
  revealDemoPasscodes: false,
  maintenanceMode: false,
}

/* ------------------------------------------------------------- dashboard --- */

export type SystemHealth = {
  status: 'ok' | 'degraded' | 'critical'
  database_path: string
  database_size_bytes: number
  schema_version: number
  uptime_seconds: number
  node_version: string
  total_elections: number
  total_ballots: number
  total_voters: number
  pending_approvals: number
  issues: { severity: 'info' | 'warning' | 'critical'; message: string }[]
}

export type VoterFunnel = {
  registered: number
  eligible: number
  verified: number
  voted: number
  turnout: number
}

export type DashboardElectionRow = {
  id: string
  title: string
  election_type: string
  status: ElectionStatus
  effective_status: ElectionStatus
  timezone: string
  starts_at: string
  ends_at: string
  funnel: VoterFunnel
  candidate_count: number
  locked: boolean
}

export type DashboardData = {
  server_time: string
  server_offset_ms: number
  viewer: {
    admin_id: number
    username: string
    display_name: string
    role: AdminRole
    permissions: Permission[]
    mfa_enabled: boolean
    session_expires_at: string
  }
  totals: {
    elections: number
    drafts: number
    running: number
    closed: number
    certified: number
    archived: number
    ballots: number
    registered_voters: number
    admins: number
  }
  elections: DashboardElectionRow[]
  results: {
    election_id: string
    title: string
    status: ElectionStatus
    visible: boolean
    total_votes: number
    turnout: number
    leader: string | null
    certified_at: string | null
  }[]
  recent_activity: AuditEvent[]
  security: SecuritySummary
  health: SystemHealth
  backup: {
    latest: BackupRecord | null
    count: number
    total_size_bytes: number
    /** Age of the newest backup in seconds, or null when there are none. */
    newest_age_seconds: number | null
    stale: boolean
  }
  approvals: ApprovalRequest[]
}

export type { AdminRole, Permission }
export type { ElectionSummary }
