/**
 * Administrative control plane commands.
 *
 * These cover the operations dashboard, security monitoring, backups, platform
 * settings, and the two-person approval workflow. Every handler receives an
 * already-authorised administrator: `enforce` has already checked the session,
 * the role permission, and any required elevation.
 */

import fs from 'node:fs'
import {
  createAdmin,
  createReceiptCode,
  findAdminRow,
  listAdmins,
  listSessions,
  passwordProblem,
  revokeAllSessions,
  revokeSession,
  setDisabled,
  setPassword,
  setRole,
  toAdmin,
  unlockAccount,
} from './auth'
import { recordAudit, queryAudit, auditActions } from './audit'
import { BackupService, formatBytes } from './backup'
import { checkPermissionOnly, enforce, type EnforceInput, type EnforcementResult } from './authorize'
import { execute, lastInsertId, queryAll, queryOne, queryScalar, text, type SqlDatabase } from './db'
import { countBallotRows, countCandidates, countEligibleVoters, listElections } from './repository'
import {
  acknowledgeSecurityEvent,
  querySecurityEvents,
  recordSecurityEvent,
  securitySummary,
} from './security'
import { readSettings, writeSettings } from './settings'
import { effectiveStatus } from '../lib/lifecycle'
import { elevationFor, isAdminRole, permissionsFor, type AdminRole, type Permission } from '../lib/rbac'
import { buildResults } from './commands'
import { parseDisplayName, parsePassword, parseUsername, ValidationError } from '../lib/validate'
import type {
  AdminSession,
  ApprovalRequest,
  AuditEvent,
  BackupList,
  BackupRecord,
  DashboardData,
  PagedResult,
  PlatformSettings,
  SystemHealth,
} from '../lib/adminTypes'

export class ControlError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'ControlError'
  }
}

function fail(code: string, error: string): { ok: false; error: string; code: string } {
  return { ok: false, code, error }
}

function ok<T>(value: T): { ok: true; value: T } {
  return { ok: true, value }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ControlError('invalid', 'Expected an object payload.')
  }
  return value as Record<string, unknown>
}

function intOf(value: unknown, field: string, fallback?: number): number {
  if (value === undefined || value === null || value === '') {
    if (fallback !== undefined) return fallback
    throw new ControlError('invalid', `${field} is required.`)
  }
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(numeric) || numeric <= 0) {
    throw new ControlError('invalid', `${field} must be a positive whole number.`)
  }
  return numeric
}

function optionalInt(value: unknown, field: string, fallback: number, min: number, max: number): number {
  if (value === undefined || value === null || value === '') return fallback
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) throw new ControlError('invalid', `${field} must be a number.`)
  return Math.min(max, Math.max(min, Math.trunc(numeric)))
}


export type ControlContext = {
  database: SqlDatabase
  session: AdminSession | null
  requestId: string
  ip: string | null
  now: number
  backups: BackupService
  databasePath: string
  startedAt: number
  /** Called after a restore so the process reloads the replaced database. */
  onDatabaseReplaced: () => void
  /**
   * Whether the deployment was started with code disclosure switched on.
   *
   * Reported in system health alongside the stored setting, because either one
   * can put voter codes on the wire and an operator looking at the dashboard
   * needs to see the real answer, not just the toggle they happen to control.
   */
  revealDemoCodes?: boolean
}


/**
 * Authorise, then run.
 *
 * The work function returns its own `{ ok, value }` result, which is passed
 * straight through so payloads are not double-wrapped. Denials carry the
 * elevation they need, so the UI can present the right dialog rather than a
 * generic failure.
 */
function authorised<T>(
  context: ControlContext,
  spec: { permission: Permission; action: string; resource: string; electionId?: string | null; approvalToken?: string | null },
  work: (session: AdminSession, admin: AdminSession['admin']) => { ok: true; value: T } | { ok: false; code: string; error: string },
): { ok: true; value: T } | { ok: false; code: string; error: string; elevation?: string; reason?: string } {
  const input: EnforceInput = {
    database: context.database,
    session: context.session,
    permission: spec.permission,
    action: spec.action,
    resource: spec.resource,
    requestId: context.requestId,
    ip: context.ip,
    electionId: spec.electionId ?? null,
    approvalToken: spec.approvalToken ?? null,
    now: context.now,
  }
  const result: EnforcementResult = enforce(input)
  if (!result.ok) {
    return {
      ok: false,
      code: result.code,
      error: result.message,
      elevation: result.elevation,
      reason: result.reason,
    }
  }
  return work(result.session, result.admin)
}

function toApproval(row: Record<string, unknown>, requestedLabel: string, decidedLabel: string | null): ApprovalRequest {
  return {
    id: Number(row.id ?? 0),
    token: text(row.token),
    request_id: text(row.request_id),
    permission: text(row.permission) as Permission,
    action: text(row.action),
    resource: text(row.resource),
    election_id: typeof row.election_id === 'string' && row.election_id ? row.election_id : null,
    payload_summary: text(row.payload_summary),
    justification: text(row.justification),
    status: text(row.status) as ApprovalRequest['status'],
    requested_by: Number(row.requested_by ?? 0),
    requested_by_label: requestedLabel,
    requested_at: text(row.requested_at),
    expires_at: text(row.expires_at),
    decided_by: typeof row.decided_by === 'number' ? row.decided_by : null,
    decided_by_label: decidedLabel,
    decided_at: typeof row.decided_at === 'string' && row.decided_at ? row.decided_at : null,
    decision_note: text(row.decision_note),
    executed_at: typeof row.executed_at === 'string' && row.executed_at ? row.executed_at : null,
  }
}

/* ------------------------------------------------------------- dashboard --- */

function buildHealth(context: ControlContext, settings: PlatformSettings): SystemHealth {
  const database = context.database
  let sizeBytes = 0
  try {
    sizeBytes = fs.existsSync(context.databasePath) ? fs.statSync(context.databasePath).size : 0
  } catch {
    sizeBytes = 0
  }
  const version = database.exec('PRAGMA user_version')[0]?.values[0]?.[0]
  const totalElections = queryScalar(database, 'SELECT COUNT(*) AS total FROM elections')
  // Ballots and participation, counted separately. Neither is a voter-to-choice
  // mapping, and nothing here needs one to be.
  const totalBallots = queryScalar(database, 'SELECT COUNT(*) AS total FROM ballots')
  const totalVoters = queryScalar(database, 'SELECT COUNT(*) AS total FROM roll_voters')
  const pendingApprovals = queryScalar(database, "SELECT COUNT(*) AS total FROM approvals WHERE status = 'pending'")
  const admins = listAdmins(database)
  const withoutMfa = admins.filter((admin) => !admin.mfa_enabled && !admin.disabled).length

  const issues: SystemHealth['issues'] = []
  let status: SystemHealth['status'] = 'ok'

  if (settings.maintenanceMode) {
    issues.push({ severity: 'info', message: 'Maintenance mode is on: voter access is restricted.' })
  }
  if (settings.revealDemoPasscodes || context.revealDemoCodes) {
    issues.push({
      severity: 'warning',
      message:
        'Voter verification codes are being shown on screen. This discloses each voter’s code to whoever asks, so it is ' +
        (context.revealDemoCodes
          ? 'forced on by the ELECTION_DEMO_OTP=1 startup flag.'
          : 'switched on in settings.') +
        ' Never run a real election this way.',
    })
    status = 'degraded'
  }
  if (settings.requireMfa && withoutMfa > 0) {
    issues.push({
      severity: 'warning',
      message: `${withoutMfa} active administrator(s) have no second factor while it is required.`,
    })
    status = 'degraded'
  }
  if (withoutMfa > 0 && !settings.requireMfa) {
    issues.push({ severity: 'info', message: `${withoutMfa} administrator(s) have no second factor enabled.` })
  }
  const locked = admins.filter((admin) => admin.locked_until && Date.parse(admin.locked_until) > context.now)
  if (locked.length > 0) {
    issues.push({ severity: 'info', message: `${locked.length} account(s) are currently locked out.` })
  }
  if (pendingApprovals > 0) {
    issues.push({ severity: 'info', message: `${pendingApprovals} approval request(s) awaiting a second administrator.` })
  }

  return {
    status,
    database_path: context.databasePath,
    database_size_bytes: sizeBytes,
    schema_version: typeof version === 'number' ? version : 0,
    uptime_seconds: Math.round((context.now - context.startedAt) / 1000),
    node_version: process.version,
    total_elections: totalElections,
    total_ballots: totalBallots,
    total_voters: totalVoters,
    pending_approvals: pendingApprovals,
    issues,
  }
}

export function dashboard(context: ControlContext) {
  return authorised(context, { permission: 'dashboard.view', action: 'dashboard.view', resource: 'platform' }, (session, admin) => {
    const database = context.database
    const settings = readSettings(database)
    const elections = listElections(database, true)

    const rows = elections.map((election) => {
      const effective = effectiveStatus(election, context.now)
      // Participation, not ballots: the dashboard asks how many people voted,
      // which is a question about the `participation` table and touches no selections.
      const ballots = countBallotRows(database, election.id)
      const rollCount = queryScalar(database, 'SELECT COUNT(*) AS total FROM roll_voters WHERE election_id = ?', [election.id])
      const eligible = countEligibleVoters(database, election.id)
      const verified = queryScalar(
        database,
        "SELECT COUNT(*) AS total FROM voter_sessions WHERE election_id = ? AND created_at <= ?",
        [election.id, new Date(context.now).toISOString()],
      )
      const distinctVoters = queryScalar(
        database,
        'SELECT COUNT(*) AS total FROM participation WHERE election_id = ?',
        [election.id],
      )
      return {
        id: election.id,
        title: election.title,
        election_type: election.election_type,
        status: election.status,
        effective_status: effective,
        timezone: election.timezone,
        starts_at: election.starts_at,
        ends_at: election.ends_at,
        candidate_count: countCandidates(database, election.id, true),
        locked: !['draft', 'scheduled'].includes(election.status),
        funnel: {
          registered: rollCount,
          eligible,
          verified: Math.max(verified, distinctVoters),
          voted: distinctVoters,
          turnout: eligible ? (distinctVoters / eligible) * 100 : 0,
        },
        ballots,
      }
    })

    const results = elections
      .filter((election) => election.status !== 'archived' && election.status !== 'draft')
      .slice(0, 6)
      .map((election) => {
        const built = buildResults(database, election, context.now)
        const leader = built.rows.reduce<typeof built.rows[number] | null>(
          (best, row) => (row.votes > 0 && (!best || row.votes > best.votes) ? row : best),
          null,
        )
        return {
          election_id: election.id,
          title: election.title,
          status: election.status,
          visible: built.visible,
          total_votes: built.total_votes,
          turnout: built.turnout,
          leader: leader?.name ?? null,
          certified_at: election.certified_at,
        }
      })

    const recent = queryAudit(database, { limit: 12 }).rows as AuditEvent[]
    const activeSessions = listSessions(database, session.token).filter(
      (item) => !item.revoked_at && Date.parse(item.expires_at) > context.now,
    ).length
    const sec = securitySummary(database, activeSessions)

    const backupList = context.backups.list(database)
    const latest = backupList.backups[0] ?? null
    const newestAge = latest ? Math.round((context.now - Date.parse(latest.created_at)) / 1000) : null
    const stale = newestAge === null ? true : newestAge > 86_400

    const approvals = pendingApprovals(context)

    const payload: DashboardData = {
      server_time: new Date(context.now).toISOString(),
      server_offset_ms: context.now - Date.now(),
      viewer: {
        admin_id: admin.id,
        username: admin.username,
        display_name: admin.display_name,
        role: admin.role,
        permissions: [] as Permission[],
        mfa_enabled: admin.mfa_enabled,
        session_expires_at: session.expires_at,
      },
      totals: {
        elections: elections.length,
        drafts: elections.filter((election) => election.status === 'draft').length,
        running: elections.filter((election) => effectiveStatus(election, context.now) === 'open').length,
        closed: elections.filter((election) => election.status === 'closed').length,
        certified: elections.filter((election) => election.status === 'certified').length,
        archived: elections.filter((election) => election.status === 'archived').length,
        ballots: queryScalar(database, 'SELECT COUNT(*) AS total FROM ballots'),
        registered_voters: queryScalar(database, 'SELECT COUNT(*) AS total FROM roll_voters'),
        admins: listAdmins(database).length,
      },
      elections: rows,
      results,
      recent_activity: recent,
      security: sec,
      health: buildHealth(context, settings),
      backup: {
        latest,
        count: backupList.backups.length,
        total_size_bytes: backupList.total_size_bytes,
        newest_age_seconds: newestAge,
        stale,
      },
      approvals,
    }

    // Fill the permission list from the shared matrix so the UI can hide what
    // this account cannot do. Authorisation itself already happened above.
    payload.viewer.permissions = permissionsFor(admin.role)

    return ok(payload)
  })
}

function pendingApprovals(context: ControlContext): ApprovalRequest[] {
  const rows = queryAll(
    context.database,
    "SELECT a.*, ru.display_name AS ru_label, du.display_name AS du_label FROM approvals a LEFT JOIN admins ru ON ru.id = a.requested_by LEFT JOIN admins du ON du.id = a.decided_by WHERE a.status = 'pending' ORDER BY a.id DESC LIMIT 20",
  )
  return rows.map((row) => toApproval(row, text(row.ru_label), typeof row.du_label === 'string' ? text(row.du_label) : null))
}

/* ---------------------------------------------------------------- audit --- */

export function auditQuery(context: ControlContext, payload: unknown) {
  return authorised(
    context,
    { permission: 'audit.read', action: 'audit.read', resource: 'audit' },
    () => {
      const body = record(payload ?? {})
      const result: PagedResult<AuditEvent> = queryAudit(context.database, {
        electionId: typeof body.electionId === 'string' && body.electionId ? body.electionId : undefined,
        actor: typeof body.actor === 'string' && body.actor ? body.actor : undefined,
        action: typeof body.action === 'string' && body.action ? body.action : undefined,
        result: (typeof body.result === 'string' ? body.result : undefined) as never,
        search: typeof body.search === 'string' && body.search ? body.search : undefined,
        since: typeof body.since === 'string' && body.since ? body.since : undefined,
        until: typeof body.until === 'string' && body.until ? body.until : undefined,
        limit: optionalInt(body.limit, 'limit', 50, 1, 1000),
        offset: optionalInt(body.offset, 'offset', 0, 0, 1_000_000),
      })
      return ok({ ...result, actions: auditActions(context.database) })
    },
  )
}

/* ------------------------------------------------------------- security --- */

export function securityQuery(context: ControlContext, payload: unknown) {
  return authorised(context, { permission: 'security.read', action: 'security.read', resource: 'security' }, () => {
    const body = record(payload ?? {})
    const result = querySecurityEvents(context.database, {
      kind: typeof body.kind === 'string' && body.kind ? body.kind : undefined,
      severity: typeof body.severity === 'string' && body.severity ? body.severity : undefined,
      search: typeof body.search === 'string' && body.search ? body.search : undefined,
      acknowledged: typeof body.acknowledged === 'boolean' ? body.acknowledged : undefined,
      since: typeof body.since === 'string' && body.since ? body.since : undefined,
      until: typeof body.until === 'string' && body.until ? body.until : undefined,
      limit: optionalInt(body.limit, 'limit', 50, 1, 500),
      offset: optionalInt(body.offset, 'offset', 0, 0, 1_000_000),
    })
    return ok({ ...result, summary: securitySummary(context.database, listSessions(context.database, null).length) })
  })
}

export function acknowledgeAlert(context: ControlContext, payload: unknown) {
  return authorised(
    context,
    { permission: 'security.manage', action: 'security.acknowledge', resource: 'security' },
    (_session, admin) => {
      const body = record(payload)
      const id = intOf(body.id, 'id')
      if (!acknowledgeSecurityEvent(context.database, id, admin.id)) {
        return fail('not_found', 'That security event no longer exists.')
      }
      recordAudit(context.database, {
        requestId: context.requestId,
        actorType: 'admin',
        actorId: admin.id,
        actorLabel: admin.display_name,
        actorRole: admin.role,
        action: 'security_alert_acknowledged',
        resource: `security_event:${id}`,
        summary: `${admin.display_name} acknowledged security event #${id}.`,
        ip: context.ip,
      })
      return ok({ id })
    },
  )
}

/* ------------------------------------------------------------- sessions --- */

export function sessionsList(context: ControlContext) {
  return authorised(context, { permission: 'admin.view', action: 'session.list', resource: 'sessions' }, (session) =>
    ok({ sessions: listSessions(context.database, session.token) }),
  )
}

export function sessionRevoke(context: ControlContext, payload: unknown) {
  return authorised(
    context,
    { permission: 'admin.manage', action: 'session.revoke', resource: 'sessions' },
    (_session, admin) => {
      const body = record(payload)
      const token = typeof body.token === 'string' ? body.token : ''
      if (!token) return fail('invalid', 'No session was specified.')
      const reason = typeof body.reason === 'string' ? body.reason.slice(0, 200) : 'Revoked by administrator'
      if (!revokeSession(context.database, token, reason)) {
        return fail('not_found', 'That session no longer exists.')
      }
      recordSecurityEvent(context.database, {
        kind: 'session_revoked',
        summary: `${admin.display_name} revoked an administrator session.`,
        requestId: context.requestId,
        adminId: admin.id,
        adminLabel: admin.display_name,
        ip: context.ip,
        detail: { reason },
      })
      recordAudit(context.database, {
        requestId: context.requestId,
        actorType: 'admin',
        actorId: admin.id,
        actorLabel: admin.display_name,
        actorRole: admin.role,
        action: 'session_revoked',
        resource: 'session',
        summary: `${admin.display_name} revoked an administrator session.`,
        detail: { reason },
        ip: context.ip,
      })
      return ok({ revoked: true })
    },
  )
}

export function sessionRevokeAll(context: ControlContext, payload: unknown) {
  return authorised(
    context,
    { permission: 'admin.manage', action: 'session.revoke_all', resource: 'sessions' },
    (session, admin) => {
      const body = record(payload ?? {})
      const adminId = intOf(body.adminId, 'adminId', admin.id)
      const count = revokeAllSessions(context.database, adminId, 'Revoked by administrator', session.token)
      recordSecurityEvent(context.database, {
        kind: 'session_revoked',
        summary: `${admin.display_name} revoked ${count} session(s).`,
        requestId: context.requestId,
        adminId: admin.id,
        adminLabel: admin.display_name,
        ip: context.ip,
        detail: { target_admin_id: adminId, count },
      })
      recordAudit(context.database, {
        requestId: context.requestId,
        actorType: 'admin',
        actorId: admin.id,
        actorLabel: admin.display_name,
        actorRole: admin.role,
        action: 'sessions_revoked_all',
        resource: `admin:${adminId}`,
        summary: `${admin.display_name} revoked ${count} session(s) for administrator #${adminId}.`,
        ip: context.ip,
      })
      return ok({ revoked: count })
    },
  )
}

/* -------------------------------------------------------------- backups --- */

export function backupsList(context: ControlContext) {
  return authorised(context, { permission: 'backup.view', action: 'backup.list', resource: 'backups' }, () =>
    ok(context.backups.list(context.database) satisfies BackupList),
  )
}

export function backupCreate(context: ControlContext, payload: unknown) {
  return authorised(
    context,
    { permission: 'backup.create', action: 'backup.create', resource: 'backups' },
    (_session, admin) => {
      const body = record(payload ?? {})
      const label = typeof body.label === 'string' && body.label.trim() ? body.label.trim().slice(0, 80) : 'manual'
      const note = typeof body.note === 'string' ? body.note.slice(0, 500) : ''
      let created: BackupRecord
      try {
        created = context.backups.create(context.database, {
          label,
          kind: 'manual',
          note,
          createdBy: admin.id,
          createdByLabel: admin.display_name,
        })
      } catch (error) {
        return fail('conflict', (error as Error).message)
      }
      const pruned = context.backups.prune(context.database, readSettings(context.database).backupRetention)
      recordSecurityEvent(context.database, {
        kind: 'backup_created',
        summary: `${admin.display_name} created backup "${created.label}".`,
        requestId: context.requestId,
        adminId: admin.id,
        adminLabel: admin.display_name,
        ip: context.ip,
        detail: { filename: created.filename, size_bytes: created.size_bytes },
      })
      recordAudit(context.database, {
        requestId: context.requestId,
        actorType: 'admin',
        actorId: admin.id,
        actorLabel: admin.display_name,
        actorRole: admin.role,
        action: 'backup_created',
        resource: `backup:${created.id}`,
        summary: `${admin.display_name} created backup "${created.label}" (${formatBytes(created.size_bytes)}).`,
        detail: { filename: created.filename, size_bytes: created.size_bytes, pruned },
        ip: context.ip,
      })
      return ok({ backup: created, pruned })
    },
  )
}

export function backupRestore(context: ControlContext, payload: unknown) {
  return authorised(
    context,
    {
      permission: 'backup.restore',
      action: 'backup.restore',
      resource: 'backups',
      approvalToken: (record(payload ?? {}).approvalToken as string) ?? null,
    },
    (_session, admin) => {
      const body = record(payload)
      const id = intOf(body.id, 'id')
      const resolved = context.backups.resolve(context.database, id)
      if (!resolved) return fail('not_found', 'That backup is missing or its file has been removed.')

      if (!context.backups.verify(resolved.file, resolved.record.checksum)) {
        recordAudit(context.database, {
          requestId: context.requestId,
          actorType: 'admin',
          actorId: admin.id,
          actorLabel: admin.display_name,
          actorRole: admin.role,
          action: 'backup_restore',
          resource: `backup:${id}`,
          result: 'failure',
          summary: `Restore of backup #${id} refused: checksum mismatch.`,
          ip: context.ip,
        })
        return fail('integrity', 'That backup failed its integrity check and was not restored.')
      }

      // Snapshot the live database before overwriting it.
      const safety = context.backups.create(context.database, {
        label: `pre-restore-${id}`,
        kind: 'pre_restore',
        note: `Automatic snapshot taken before restoring backup #${id}.`,
        createdBy: admin.id,
        createdByLabel: admin.display_name,
      })

      try {
        context.backups.restoreInto(context.databasePath, resolved.file)
      } catch (error) {
        return fail('internal', `Could not replace the database: ${(error as Error).message}`)
      }

      recordSecurityEvent(context.database, {
        kind: 'backup_restored',
        severity: 'critical',
        summary: `${admin.display_name} restored the database from backup "${resolved.record.label}".`,
        requestId: context.requestId,
        adminId: admin.id,
        adminLabel: admin.display_name,
        ip: context.ip,
        detail: { backup_id: id, safety_backup_id: safety.id },
      })
      recordAudit(context.database, {
        requestId: context.requestId,
        actorType: 'admin',
        actorId: admin.id,
        actorLabel: admin.display_name,
        actorRole: admin.role,
        action: 'backup_restored',
        resource: `backup:${id}`,
        summary: `${admin.display_name} restored the database from backup "${resolved.record.label}".`,
        detail: { backup_id: id, safety_backup_id: safety.id, safety_filename: safety.filename },
        ip: context.ip,
      })

      context.onDatabaseReplaced()
      return ok({ restored: resolved.record.id, safetyBackupId: safety.id })
    },
  )
}

/* ------------------------------------------------------------- settings --- */

export function settingsRead(context: ControlContext) {
  return authorised(context, { permission: 'settings.view', action: 'settings.read', resource: 'settings' }, () =>
    ok({ settings: readSettings(context.database) }),
  )
}

export function settingsWrite(context: ControlContext, payload: unknown) {
  return authorised(
    context,
    {
      permission: 'settings.manage',
      action: 'settings.write',
      resource: 'settings',
      approvalToken: typeof record(payload ?? {}).approvalToken === 'string' ? (record(payload).approvalToken as string) : null,
    },
    (_session, admin) => {
      const body = record(payload)
      const before = readSettings(context.database)
      const candidate = { ...before, ...(body.settings as Partial<PlatformSettings> | undefined) }
      if (typeof candidate !== 'object' || candidate === null) {
        return fail('invalid', 'No settings were supplied.')
      }
      const after = writeSettings(context.database, candidate)
      recordAudit(context.database, {
        requestId: context.requestId,
        actorType: 'admin',
        actorId: admin.id,
        actorLabel: admin.display_name,
        actorRole: admin.role,
        action: 'settings_updated',
        resource: 'settings',
        summary: `${admin.display_name} changed platform settings.`,
        detail: { before, after },
        ip: context.ip,
      })
      return ok({ settings: after })
    },
  )
}

/* ------------------------------------------------------------ approvals --- */

export function approvalRequestCreate(context: ControlContext, payload: unknown) {
  // The caller must already hold the permission being requested, and only the
  // role check applies here. Requiring approval in order to *ask* for approval
  // would make the workflow impossible to start.
  const raw = record(payload ?? {})
  const requestedPermission = String(raw.permission ?? '') as Permission
  const action = String(raw.action ?? '')

  return authorised(
    context,
    { permission: 'backup.view', action: 'approval.request', resource: 'approvals' },
    (session, admin) => {
      const justification = typeof raw.justification === 'string' ? raw.justification.trim().slice(0, 600) : ''
      if (!justification) return fail('invalid', 'A justification is required for an approval request.')
      if (!action) return fail('invalid', 'An action must be named.')
      if (elevationFor(requestedPermission).elevation !== 'two_person') {
        return fail('invalid', 'That operation does not require a second approver.')
      }

      const roleCheck = checkPermissionOnly({
        database: context.database,
        session,
        permission: requestedPermission,
        action: 'approval.request',
        resource: 'approvals',
        requestId: context.requestId,
        ip: context.ip,
        now: context.now,
      })
      if (!roleCheck.ok) return fail(roleCheck.code, roleCheck.message)

      const token = createReceiptCode().replace(/-/g, '')
      const expiresAt = new Date(context.now + 30 * 60_000).toISOString()
      execute(
        context.database,
        `INSERT INTO approvals (token, request_id, permission, action, resource, election_id, payload,
          payload_summary, justification, status, requested_by, requested_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
        [
          token,
          context.requestId,
          requestedPermission,
          action,
          typeof raw.resource === 'string' ? raw.resource : '',
          typeof raw.electionId === 'string' ? raw.electionId : null,
          JSON.stringify(raw.payload ?? {}),
          typeof raw.payloadSummary === 'string' ? raw.payloadSummary.slice(0, 300) : '',
          justification,
          admin.id,
          new Date(context.now).toISOString(),
          expiresAt,
        ],
      )
      const id = lastInsertId(context.database)
      recordAudit(context.database, {
        requestId: context.requestId,
        actorType: 'admin',
        actorId: admin.id,
        actorLabel: admin.display_name,
        actorRole: admin.role,
        action: 'approval_requested',
        resource: `approval:${id}`,
        summary: `${admin.display_name} requested approval for ${action}.`,
        detail: { permission: requestedPermission, justification },
        ip: context.ip,
      })
      const row = queryOne(context.database, 'SELECT * FROM approvals WHERE id = ?', [id])
      return ok({ approval: toApproval(row ?? {}, admin.display_name, null) })
    },
  )
}

export function approvalList(context: ControlContext, payload: unknown) {
  return authorised(context, { permission: 'backup.view', action: 'approval.list', resource: 'approvals' }, () => {
    const body = record(payload ?? {})
    const status = typeof body.status === 'string' && body.status ? body.status : 'pending'
    const rows = queryAll(
      context.database,
      `SELECT a.*, ru.display_name AS ru_label, du.display_name AS du_label
         FROM approvals a
         LEFT JOIN admins ru ON ru.id = a.requested_by
         LEFT JOIN admins du ON du.id = a.decided_by
        WHERE a.status = ? OR ? = 'all'
        ORDER BY a.id DESC LIMIT 100`,
      [status, status],
    )
    return ok({
      approvals: rows.map((row) => toApproval(row, text(row.ru_label), typeof row.du_label === 'string' ? text(row.du_label) : null)),
    })
  })
}

export function approvalDecide(context: ControlContext, payload: unknown) {
  return authorised(
    context,
    { permission: 'backup.view', action: 'approval.decide', resource: 'approvals' },
    (session, admin) => {
      const body = record(payload)
      const id = intOf(body.id, 'id')
      const decision = String(body.decision ?? '')
      const note = typeof body.note === 'string' ? body.note.slice(0, 400) : ''
      if (decision !== 'approved' && decision !== 'rejected') {
        return fail('invalid', 'A decision must be approve or reject.')
      }
      const row = queryOne(context.database, 'SELECT * FROM approvals WHERE id = ?', [id])
      if (!row) return fail('not_found', 'That approval request no longer exists.')
      if (text(row.status) !== 'pending') return fail('conflict', 'That request has already been decided.')
      if (Number(row.requested_by) === admin.id) {
        return fail('forbidden', 'You cannot approve your own request. A different administrator must review it.')
      }
      if (Date.parse(text(row.expires_at)) <= context.now) {
        execute(context.database, "UPDATE approvals SET status = 'expired' WHERE id = ?", [id])
        return fail('conflict', 'That request has expired and can no longer be approved.')
      }
      execute(
        context.database,
        'UPDATE approvals SET status = ?, decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ?',
        [decision, admin.id, new Date(context.now).toISOString(), note, id],
      )
      recordAudit(context.database, {
        requestId: context.requestId,
        actorType: 'admin',
        actorId: admin.id,
        actorLabel: admin.display_name,
        actorRole: admin.role,
        action: `approval_${decision}`,
        resource: `approval:${id}`,
        summary: `${admin.display_name} ${decision} approval request #${id} for ${text(row.action)}.`,
        detail: { note, requested_by: Number(row.requested_by) },
        ip: context.ip,
      })
      void session
      return ok({ id, status: decision })
    },
  )
}

function markApprovalExecuted(database: SqlDatabase, token: string): void {
  execute(database, "UPDATE approvals SET status = 'executed', executed_at = ? WHERE token = ?", [
    new Date().toISOString(),
    token,
  ])
}

export { markApprovalExecuted }

/* ------------------------------------------------------------- accounts --- */

export function accountsList(context: ControlContext) {
  return authorised(context, { permission: 'admin.view', action: 'admin.list', resource: 'admins' }, () =>
    ok({ admins: listAdmins(context.database) }),
  )
}

/**
 * Dual control has a bootstrap problem, and the shape of it is easy to get wrong.
 *
 * Creating an administrator needs `admin.manage`, which needs a second
 * administrator's approval. So the first administrator could never create the
 * second one, and the platform could never obtain an account able to approve
 * anything.
 *
 * The test is therefore not "how many accounts exist" but "does any *other*
 * enabled account hold `admin.manage`". Until one does, demanding approval makes
 * the workflow impossible to start, so the sole super administrator may continue.
 * Once a second account that can administer accounts exists, the exception stops
 * applying and every subsequent change is dual-controlled.
 *
 * The exception is written to the audit trail and the security log, so its use is
 * always visible rather than silent.
 */
function mayCreateAccountWithoutApproval(database: SqlDatabase, admin: { role: AdminRole }): boolean {
  if (admin.role !== 'super_admin') return false
  return countSuperAdmins(database) <= 1
}

export function accountCreate(context: ControlContext, payload: unknown) {
  const raw = record(payload ?? {})
  const approvalToken = typeof raw.approvalToken === 'string' ? raw.approvalToken : null
  const soleAdmin = context.session ? mayCreateAccountWithoutApproval(context.database, context.session.admin) : false

  // With no second approver available, fall back to the role check alone.
  // `checkPermissionOnly` is required here: the normal path would demand the very
  // approval that cannot exist yet.
  if (soleAdmin && !approvalToken) {
    const roleCheck = checkPermissionOnly({
      database: context.database,
      session: context.session,
      permission: 'admin.manage',
      action: 'admin.create',
      resource: 'admins',
      requestId: context.requestId,
      ip: context.ip,
      now: context.now,
    })
    if (!roleCheck.ok) return fail(roleCheck.code, roleCheck.message)
    return createAccountRecord(context, raw, roleCheck.admin, true)
  }
  return authorised(
    context,
    { permission: 'admin.manage', action: 'admin.create', resource: 'admins', approvalToken },
    (_session, admin) => createAccountRecord(context, raw, admin, false),
  )
}

function createAccountRecord(
  context: ControlContext,
  body: Record<string, unknown>,
  admin: { id: number; display_name: string; role: AdminRole },
  dualControlException: boolean,
) {
  let username: string
  let displayName: string
  let password: string
  try {
    username = parseUsername(body.username)
    displayName = parseDisplayName(body.display_name)
    password = parsePassword(body.password)
  } catch (error) {
    return fail('invalid', (error as ValidationError).message)
  }
  const problem = passwordProblem(password)
  if (problem) return fail('invalid', problem)
  const role = body.role
  if (!isAdminRole(role)) return fail('invalid', 'Unknown role.')

  if (queryOne(context.database, 'SELECT id FROM admins WHERE username = ?', [username])) {
    return fail('conflict', 'That username is already taken.')
  }
  if (!readSettings(context.database).allowAdminCreation) {
    return fail('forbidden', 'Administrator creation is currently disabled in settings.')
  }

  const created = createAdmin(context.database, {
    username,
    display_name: displayName,
    password,
    role,
    mustChangePassword: true,
  })
  const caveat = dualControlException
    ? ' Dual control was bypassed because no second administrator existed.'
    : ''
  recordSecurityEvent(context.database, {
    kind: 'admin_created',
    severity: dualControlException ? 'warning' : 'notice',
    summary: `${admin.display_name} created administrator "${username}" with role ${role}.${caveat}`,
    requestId: context.requestId,
    adminId: admin.id,
    adminLabel: admin.display_name,
    ip: context.ip,
    detail: { username, role, dualControlException },
  })
  recordAudit(context.database, {
    requestId: context.requestId,
    actorType: 'admin',
    actorId: admin.id,
    actorLabel: admin.display_name,
    actorRole: admin.role,
    action: 'admin_created',
    resource: `admin:${created.id}`,
    summary: `${admin.display_name} created administrator "${username}" (${role}).${caveat}`,
    detail: { username, role, dualControlException },
    ip: context.ip,
  })
  return ok({ admin: created })
}

export function accountUpdate(context: ControlContext, payload: unknown) {
  return authorised(
    context,
    {
      permission: 'admin.manage',
      action: 'admin.update',
      resource: 'admins',
      approvalToken: (() => {
        const body = payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {}
        return typeof body.approvalToken === 'string' ? body.approvalToken : null
      })(),
    },
    (session, admin) => {
      const body = record(payload)
      const adminId = intOf(body.adminId, 'adminId')
      const target = findAdminRow(context.database, adminId)
      if (!target) return fail('not_found', 'That administrator no longer exists.')
      const current = toAdmin(target)
      const changes: string[] = []

      if (typeof body.role === 'string' && body.role !== current.role) {
        const nextRole = body.role
        if (!isAdminRole(nextRole)) return fail('invalid', 'Unknown role.')
        if (current.id === admin.id) return fail('forbidden', 'You cannot change your own role.')
        if (current.role === 'super_admin' && countSuperAdmins(context.database) <= 1) {
          return fail('conflict', 'The last super administrator cannot have their role changed.')
        }
        setRole(context.database, adminId, nextRole)
        changes.push(`role ${current.role} -> ${nextRole}`)
        recordSecurityEvent(context.database, {
          kind: 'admin_role_changed',
          summary: `${admin.display_name} changed ${current.username}'s role to ${nextRole}.`,
          requestId: context.requestId,
          adminId: admin.id,
          adminLabel: admin.display_name,
          ip: context.ip,
          detail: { from: current.role, to: nextRole },
        })
      }

      if (typeof body.disabled === 'boolean' && body.disabled !== current.disabled) {
        if (current.id === admin.id) return fail('forbidden', 'You cannot disable your own account.')
        setDisabled(context.database, adminId, body.disabled)
        changes.push(body.disabled ? 'disabled' : 'enabled')
        if (body.disabled) revokeAllSessions(context.database, adminId, 'Account disabled')
        recordSecurityEvent(context.database, {
          kind: 'admin_disabled',
          severity: body.disabled ? 'warning' : 'notice',
          summary: `${admin.display_name} ${body.disabled ? 'disabled' : 'enabled'} ${current.username}.`,
          requestId: context.requestId,
          adminId: admin.id,
          adminLabel: admin.display_name,
          ip: context.ip,
        })
      }

      if (body.unlock === true && current.locked_until) {
        unlockAccount(context.database, adminId)
        changes.push('unlocked')
        recordSecurityEvent(context.database, {
          kind: 'account_unlocked',
          summary: `${admin.display_name} unlocked ${current.username}.`,
          requestId: context.requestId,
          adminId: admin.id,
          adminLabel: admin.display_name,
          ip: context.ip,
        })
      }

      if (changes.length === 0) return fail('invalid', 'No changes were supplied.')
      // Changing an account revokes its sessions so the new state takes effect
      // immediately rather than at the next sign-in.
      revokeAllSessions(context.database, adminId, 'Account updated', session.token)
      recordAudit(context.database, {
        requestId: context.requestId,
        actorType: 'admin',
        actorId: admin.id,
        actorLabel: admin.display_name,
        actorRole: admin.role,
        action: 'admin_updated',
        resource: `admin:${adminId}`,
        summary: `${admin.display_name} updated ${current.username}: ${changes.join(', ')}.`,
        detail: { changes },
        ip: context.ip,
      })
      return ok({ admin: toAdmin(findAdminRow(context.database, adminId) ?? {}) })
    },
  )
}

export function accountPasswordReset(context: ControlContext, payload: unknown) {
  return authorised(
    context,
    {
      permission: 'admin.manage',
      action: 'admin.password',
      resource: 'admins',
      approvalToken: (() => {
        const body = payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {}
        return typeof body.approvalToken === 'string' ? body.approvalToken : null
      })(),
    },
    (_session, admin) => {
      const body = record(payload)
      const adminId = intOf(body.adminId, 'adminId')
      const target = findAdminRow(context.database, adminId)
      if (!target) return fail('not_found', 'That administrator no longer exists.')
      const current = toAdmin(target)
      if (typeof body.newPassword !== 'string') return fail('invalid', 'A new password is required.')
      const problem = passwordProblem(body.newPassword)
      if (problem) return fail('invalid', problem)
      setPassword(context.database, adminId, body.newPassword, true)
      revokeAllSessions(context.database, adminId, 'Password reset by administrator')
      recordSecurityEvent(context.database, {
        kind: 'password_changed',
        summary: `${admin.display_name} reset the password for ${current.username}.`,
        requestId: context.requestId,
        adminId: admin.id,
        adminLabel: admin.display_name,
        ip: context.ip,
        detail: { target: current.username },
      })
      recordAudit(context.database, {
        requestId: context.requestId,
        actorType: 'admin',
        actorId: admin.id,
        actorLabel: admin.display_name,
        actorRole: admin.role,
        action: 'admin_password_reset',
        resource: `admin:${adminId}`,
        summary: `${admin.display_name} reset the password for ${current.username} and revoked its sessions.`,
        ip: context.ip,
      })
      return ok({ adminId })
    },
  )
}

function countSuperAdmins(database: SqlDatabase): number {
  return queryScalar(database, "SELECT COUNT(*) AS total FROM admins WHERE role = 'super_admin' AND disabled = 0")
}

/* ------------------------------------------------------------ system --- */

export function systemReset(context: ControlContext, payload: unknown) {
  return authorised(
    context,
    {
      permission: 'system.reset',
      action: 'system.reset',
      resource: 'platform',
      approvalToken: (() => {
        const body = payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {}
        return typeof body.approvalToken === 'string' ? body.approvalToken : null
      })(),
    },
    (_session, admin) => {
      const body = record(payload)
      const confirmation = String(body.confirm ?? '')
      if (confirmation !== 'RESET') {
        return fail('invalid', 'Type RESET to confirm. This cannot be undone.')
      }
      const keepAdmins = body.keepAdmins !== false

      const safety = context.backups.create(context.database, {
        label: 'pre-reset',
        kind: 'pre_reset',
        note: 'Automatic snapshot taken immediately before a system reset.',
        createdBy: admin.id,
        createdByLabel: admin.display_name,
      })

      if (keepAdmins) {
        for (const table of ['ballots', 'participation', 'voter_sessions', 'roll_voters', 'candidates', 'elections', 'audit_events']) {
          execute(context.database, `DELETE FROM ${table}`)
        }
      } else {
        for (const table of [
          'ballots',
          'voter_sessions',
          'roll_voters',
          'candidates',
          'elections',
          'audit_events',
          'approvals',
          'admin_sessions',
          'admins',
          'recovery_codes',
        ]) {
          try {
            execute(context.database, `DELETE FROM ${table}`)
          } catch {
            /* table may not exist */
          }
        }
      }

      recordSecurityEvent(context.database, {
        kind: 'system_reset',
        severity: 'critical',
        summary: `${admin.display_name} reset all platform data${keepAdmins ? ' (administrators kept)' : ' including accounts'}.`,
        requestId: context.requestId,
        adminId: admin.id,
        adminLabel: admin.display_name,
        ip: context.ip,
        detail: { keepAdmins, safety_backup_id: safety.id },
      })
      recordAudit(context.database, {
        requestId: context.requestId,
        actorType: 'admin',
        actorId: admin.id,
        actorLabel: admin.display_name,
        actorRole: admin.role,
        action: 'system_reset',
        resource: 'platform',
        summary: `${admin.display_name} reset all platform data. A safety backup was taken first.`,
        detail: { keepAdmins, safety_backup_id: safety.id },
        ip: context.ip,
      })
      return ok({ reset: true, safetyBackupId: safety.id, keepAdmins })
    },
  )
}

/* -------------------------------------------------------------- health --- */

export function systemHealth(context: ControlContext) {
  return authorised(context, { permission: 'dashboard.view', action: 'system.health', resource: 'platform' }, () =>
    ok({ health: buildHealth(context, readSettings(context.database)) }),
  )
}

export { buildHealth }
