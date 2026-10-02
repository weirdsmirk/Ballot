/**
 * Backend authorization.
 *
 * This is the security boundary. Every command the API dispatches passes through
 * `enforce`, which answers three questions in order:
 *
 * 1. Is there a valid administrator session? (authentication)
 * 2. Does that administrator's role grant the required permission? (authorisation)
 * 3. Has the administrator satisfied the required elevation — a fresh password,
 *    a second factor, or a second administrator's approval? (step-up)
 *
 * A denial at any stage is recorded in both the audit trail and the security log.
 * The admin UI consults the same permission matrix, but hiding a control is only
 * a convenience: nothing here depends on the frontend having done its job.
 */

import { elevationFor, LIFECYCLE_PERMISSIONS, roleHas, type AdminRole, type Permission } from '../lib/rbac'
import type { AdminAccount, AdminSession } from '../lib/adminTypes'
import { recordAudit } from './audit'
import { hasFreshMfa, hasFreshReauth } from './auth'
import { queryOne, text, type SqlDatabase } from './db'
import { recordSecurityEvent } from './security'

export type EnforcementResult =
  | { ok: true; session: AdminSession; admin: AdminAccount }
  | { ok: false; code: string; message: string; elevation?: 'reauth' | 'mfa' | 'two_person'; reason?: string }

export type EnforceInput = {
  database: SqlDatabase
  session: AdminSession | null
  permission: Permission
  action: string
  resource: string
  requestId: string
  ip: string | null
  electionId?: string | null
  /** Supplied by commands that require two-person approval. */
  approvalToken?: string | null
  now?: number
}

function deny(
  input: EnforceInput,
  code: string,
  message: string,
  extra: { elevation?: 'reauth' | 'mfa' | 'two_person'; reason?: string } = {},
): EnforcementResult {
  if (input.session) {
    const admin = input.session.admin
    recordAudit(input.database, {
      requestId: input.requestId,
      electionId: input.electionId ?? null,
      actorType: 'admin',
      actorId: admin.id,
      actorLabel: admin.display_name,
      actorRole: admin.role,
      action: input.action,
      resource: input.resource,
      result: 'denied',
      summary: message,
      detail: { required: input.permission },
      ip: input.ip,
    })
    if (code === 'forbidden') {
      recordSecurityEvent(input.database, {
        kind: 'permission_denied',
        summary: `${admin.display_name} was denied ${input.permission} for ${input.action}.`,
        requestId: input.requestId,
        adminId: admin.id,
        adminLabel: admin.display_name,
        ip: input.ip,
        detail: { permission: input.permission, action: input.action, resource: input.resource },
      })
    }
  }
  return { ok: false, code, message, ...extra }
}

export function enforce(input: EnforceInput): EnforcementResult {
  const now = input.now ?? Date.now()
  const session = input.session

  if (!session) {
    return deny(input, 'unauthorized', 'Sign in to continue.')
  }
  const admin = session.admin

  if (admin.disabled) {
    return deny(input, 'unauthorized', 'This account has been disabled.')
  }

  if (!roleHas(admin.role, input.permission)) {
    return deny(
      input,
      'forbidden',
      `Your role (${admin.role.replace(/_/g, ' ')}) does not permit ${input.permission.replace(/\./g, ' ')}.`,
    )
  }

  const rule = elevationFor(input.permission)
  if (rule.elevation === 'none') {
    return { ok: true, session, admin }
  }

  if (rule.elevation === 'reauth') {
    if (hasFreshReauth(session, now)) return { ok: true, session, admin }
    return deny(input, 'elevation_required', 'Confirm your password to authorise this action.', {
      elevation: 'reauth',
      reason: rule.reason,
    })
  }

  if (rule.elevation === 'mfa') {
    if (hasFreshMfa(session, now)) return { ok: true, session, admin }
    return deny(input, 'elevation_required', 'A second factor is required to authorise this action.', {
      elevation: 'mfa',
      reason: rule.reason,
    })
  }

  // Two-person approval: a different administrator must have approved this
  // specific request, it must not have expired, and it must be for this action.
  if (!input.approvalToken) {
    return deny(
      input,
      'approval_required',
      'This action requires approval by a second administrator before it can run.',
      { elevation: 'two_person', reason: rule.reason },
    )
  }

  const approval = resolveApproval(input.database, input.approvalToken)
  if (!approval) {
    return deny(
      input,
      'approval_invalid',
      'That approval request is missing, expired, or was approved for a different action.',
      { elevation: 'two_person', reason: rule.reason },
    )
  }
  if (approval.permission !== input.permission || approval.action !== input.action) {
    return deny(input, 'approval_invalid', 'That approval was issued for a different operation.', {
      elevation: 'two_person',
      reason: rule.reason,
    })
  }

  return { ok: true, session, admin }
}

/**
 * Look up an approval that permits a two-person action to run.
 *
 * The requester executing their own request is the normal case: one
 * administrator asks, a *different* one approves, then the requester runs it.
 * Self-approval is prevented at decision time, so the only thing that must hold
 * here is that the approval exists, was granted, and has not expired.
 */
function resolveApproval(database: SqlDatabase, token: string): { permission: string; action: string } | null {
  const row = queryOne(database, 'SELECT permission, action, status, expires_at FROM approvals WHERE token = ?', [token])
  if (!row) return null
  if (text(row.status) !== 'approved') return null
  if (Date.parse(text(row.expires_at)) <= Date.now()) return null
  return { permission: text(row.permission), action: text(row.action) }
}

/** Record that an elevation step was demanded but not yet satisfied. */
export function recordElevationDemand(
  database: SqlDatabase,
  input: { adminId: number; adminLabel: string; permission: Permission; action: string; requestId: string; ip: string | null },
): void {
  recordSecurityEvent(database, {
    kind: 'elevation_required',
    summary: `${input.adminLabel} was asked to re-verify for ${input.action}.`,
    requestId: input.requestId,
    adminId: input.adminId,
    adminLabel: input.adminLabel,
    ip: input.ip,
    detail: { permission: input.permission },
  })
}

/**
 * Check the role permission only, skipping the elevation requirement.
 *
 * Needed for operations that exist *in order to satisfy* elevation. Creating an
 * approval request cannot itself demand approval, or the workflow could never
 * start. The caller must still hold the permission being requested, so this
 * cannot be used to escalate.
 */
export function checkPermissionOnly(
  input: Omit<EnforceInput, 'permission'> & { permission: Permission },
): EnforcementResult {
  const session = input.session
  if (!session) return deny(input, 'unauthorized', 'Sign in to continue.')
  if (session.admin.disabled) return deny(input, 'unauthorized', 'This account has been disabled.')
  if (!roleHas(session.admin.role, input.permission)) {
    return deny(
      input,
      'forbidden',
      `Your role (${session.admin.role.replace(/_/g, ' ')}) does not permit ${input.permission.replace(/\./g, ' ')}.`,
    )
  }
  return { ok: true, session, admin: session.admin }
}

export function canRole(role: AdminRole, permission: Permission): boolean {
  return roleHas(role, permission)
}

export class AuthorizationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'AuthorizationError'
  }
}

/**
 * The command to permission map.
 *
 * This is the enforcement table. A command mapped to `null` is public: either a
 * voter-facing command that must work without an administrator session, or a
 * sign-in command that establishes one. Everything else requires a session and
 * the listed permission, checked in `dispatch` before the handler runs.
 *
 * The default is deny. `resolveCommandPermission` throws for a command missing
 * from this table rather than allowing it, so forgetting to register a new
 * command cannot silently create a hole.
 */
export const COMMAND_PERMISSIONS: Record<string, Permission | null> = {
  // Public: voter portal and the bootstrap read.
  'state.get': null,
  'admin.bootstrap': null,
  'admin.login': null,
  'admin.mfa.verify': null,
  'admin.mfa.status': null,
  'election.list': null,
  'election.get': null,
  // Publish-readiness diagnostics are an administrative tool: they report
  // blockers and warnings about the configuration, which is not voter-facing
  // information. The preview panel is admin-only, so the read is too.
  'election.preview': 'election.view',
  // The voter roll holds names and contact details, and those contacts are what a
  // verification code is delivered to. It is never part of the public
  // `election.get` response; this command is the only way to read it, and it
  // requires an administrator session.
  'election.roll': 'voter.view',
  // Participation: who voted, per voter, with no selections. Separated from results
  // so an officer can see turnout without the report ever being able to express what
  // anybody chose.
  'election.participation': 'voter.view',
  // A named refusal rather than an absent command, so probing for a way to read a
  // voter's choice by identity gets a clear answer instead of a generic 404.
  'election.participation.clear': 'voter.view',
  'election.results': null,
  // Reading the audit trail is itself a privileged act: it exposes who did what.
  'election.audit': 'audit.read',
  'voter.begin': null,
  'voter.verify': null,
  'voter.logout': null,
  'voter.ballot': null,
  'voter.vote': null,
  'voter.receipt': null,
  'admin.session': 'dashboard.view',

  // Election lifecycle and configuration.
  'election.create': 'election.create',
  'election.update': 'election.edit',
  'election.setRules': 'election.setRules',
  'election.setEligibility': 'election.edit',
  'election.delete': 'election.delete',
  'election.transition': 'election.open',
  'election.candidate.add': 'candidate.manage',
  'election.candidate.update': 'candidate.manage',
  'election.candidate.setStatus': 'candidate.manage',
  'election.candidate.remove': 'candidate.manage',
  'election.candidate.reorder': 'candidate.manage',
  'election.voters.add': 'voter.import',
  'election.voters.remove': 'voter.manage',
  'election.voters.setEligibility': 'voter.manage',

  // Control plane.
  'control.dashboard': 'dashboard.view',
  'control.system.health': 'dashboard.view',
  'control.audit.query': 'audit.read',
  'control.security.query': 'security.read',
  'control.security.acknowledge': 'security.manage',
  'control.sessions.list': 'admin.view',
  'control.session.revoke': 'admin.manage',
  'control.session.revokeAll': 'admin.manage',
  'control.backups.list': 'backup.view',
  'control.backup.create': 'backup.create',
  'control.backup.restore': 'backup.restore',
  'control.settings.read': 'settings.view',
  'control.settings.write': 'settings.manage',
  'control.approvals.list': 'backup.view',
  'control.approval.create': 'backup.restore',
  'control.approval.decide': 'backup.view',
  'control.accounts.list': 'admin.view',
  'control.account.create': 'admin.manage',
  'control.account.update': 'admin.manage',
  'control.account.password': 'admin.manage',
  'control.system.reset': 'system.reset',
}

/**
 * Lifecycle actions map onto finer-grained permissions than the command does.
 *
 * `election.transition` is one command, but opening a poll and certifying a
 * result are different privileges, so the action selects the permission. The map
 * lives in the shared RBAC module so the admin UI asks for exactly the same
 * permission the server will check.
 */
const TRANSITION_PERMISSIONS = LIFECYCLE_PERMISSIONS

export function resolveCommandPermission(command: string, payload: unknown): Permission | null {
  if (command === 'election.transition' && payload && typeof payload === 'object') {
    const action = (payload as Record<string, unknown>).action
    // Own-property lookup: `TRANSITION_PERMISSIONS['toString']` would otherwise
    // resolve to an inherited function and be returned as if it were a
    // permission. The fallback below is the narrowest of the lifecycle grants,
    // and the transition handler validates the action before acting on it.
    if (typeof action === 'string' && Object.prototype.hasOwnProperty.call(TRANSITION_PERMISSIONS, action)) {
      return TRANSITION_PERMISSIONS[action]
    }
  }
  if (!Object.prototype.hasOwnProperty.call(COMMAND_PERMISSIONS, command)) {
    throw new AuthorizationError(
      'unmapped_command',
      `Command "${command}" is not in the authorisation table and was refused.`,
    )
  }
  return COMMAND_PERMISSIONS[command]
}
