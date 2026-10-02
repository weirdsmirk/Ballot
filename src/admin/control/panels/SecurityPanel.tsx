/**
 * Security.
 *
 * Sign-in activity, privilege decisions, active sessions, and the two-person
 * approval queue. These are the things an operator looks at when something looks
 * wrong, so the screen leads with the counters that indicate trouble and keeps
 * the raw log one filter away.
 *
 * Acknowledging an alert is deliberately separate from resolving it: it records
 * that a human saw the event, which is what stops the same line being the newest
 * thing on the dashboard forever. The event itself is never deleted.
 */

import { useCallback, useMemo, useState } from 'react'
import { controlApi, type SecurityQueryResult } from '../../../lib/api'
import { ROLE_LABELS, roleHas, type AdminRole } from '../../../lib/rbac'
import type { AdminAccount, AdminSessionSummary, ApprovalRequest, SecurityEvent } from '../../../lib/adminTypes'
import { Alert, EmptyState, Modal } from '../../../ui/primitives'
import { Icon } from '../../../ui/Icon'
import { ConfirmDialog, type ConfirmOptions } from '../ConfirmDialog'
import { DataTable, type Column } from '../DataTable'
import { useElevation } from '../elevation'
import { ControlCard, SectionHeader, formatAge, formatInstant, useControlData } from '../shared'

const SEVERITY_LABELS: Record<string, string> = {
  info: 'Info',
  notice: 'Notice',
  warning: 'Warning',
  critical: 'Critical',
}

const KIND_LABELS: Record<string, string> = {
  login_success: 'Sign-in succeeded',
  login_failure: 'Sign-in failed',
  account_locked: 'Account locked',
  account_unlocked: 'Account unlocked',
  logout: 'Sign-out',
  session_revoked: 'Session revoked',
  mfa_enabled: 'Second factor enabled',
  mfa_disabled: 'Second factor removed',
  mfa_failed: 'Second factor failed',
  mfa_recovery_used: 'Recovery code used',
  password_changed: 'Password changed',
  rate_limited: 'Rate limited',
  permission_denied: 'Permission denied',
  elevation_required: 'Extra verification demanded',
  backup_created: 'Backup created',
  backup_restored: 'Database restored',
  system_reset: 'System reset',
  admin_created: 'Administrator created',
  admin_role_changed: 'Role changed',
  admin_disabled: 'Account disabled',
  origin_rejected: 'Foreign request rejected',
  // Voter-side events. Recorded here rather than only in the audit trail because a
  // failed verification or a replayed credential is an operator's business.
  voter_verified: 'Voter verified',
  voter_verification_failed: 'Voter verification failed',
  voter_verification_new_address: 'Voter used a new contact address',
  voter_session_replayed: 'Voter session replayed',
  ballot_credential_rejected: 'Voting credential rejected',
  ballot_cast: 'Ballot recorded',
  voter_signed_out: 'Voter signed out',
}

export function SecurityPanel({ role, adminId }: { role: AdminRole; adminId: number }) {
  const canRead = roleHas(role, 'security.read')
  const canManage = roleHas(role, 'security.manage')
  const { run } = useElevation()

  const [tab, setTab] = useState<'events' | 'sessions' | 'approvals' | 'accounts'>('events')
  const [notice, setNotice] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<ConfirmOptions | null>(null)
  const [revoking, setRevoking] = useState<AdminAccount | null>(null)

  /**
   * Each tab's data is fetched the first time that tab is opened, not up front.
   *
   * This screen has four independent reads, and the API budget is a shared,
   * deliberately finite resource. Eagerly loading tabs nobody opens would spend
   * that budget on data that is thrown away.
   */
  const [visited, setVisited] = useState<Record<string, boolean>>({ events: true })
  const events = useControlData<SecurityQueryResult>(() => controlApi.security({ limit: 50 }), [visited.events])
  const sessions = useControlData<{ sessions: AdminSessionSummary[] }>(() => controlApi.sessions(), [visited.sessions])
  const approvals = useControlData<{ approvals: ApprovalRequest[] }>(() => controlApi.approvals('pending'), [visited.approvals])
  const accounts = useControlData<{ admins: AdminAccount[] }>(() => controlApi.accounts(), [visited.accounts])

  const openTab = (next: typeof tab) => {
    setTab(next)
    if (!visited[next]) setVisited((current) => ({ ...current, [next]: true }))
  }

  const acknowledge = useCallback(
    async (event: SecurityEvent) => {
      setActionError(null)
      const result = await controlApi.acknowledgeSecurityEvent(event.id)
      if (!result.ok) {
        setActionError(result.error)
        return
      }
      setNotice(`Acknowledged: ${event.summary}`)
      events.reload()
    },
    [events],
  )

  const decide = useCallback(
    async (approval: ApprovalRequest, decision: 'approved' | 'rejected', note: string) => {
      setActionError(null)
      const result = await controlApi.decideApproval(approval.id, decision, note)
      if (!result.ok) {
        setActionError(result.error)
        return
      }
      setNotice(`Request #${approval.id} ${decision}.`)
      approvals.reload()
    },
    [approvals],
  )

  const revokeAll = useCallback(
    async (admin: AdminAccount) => {
      setActionError(null)
      setConfirm(null)
      setRevoking(null)
      const outcome = await run({ permission: 'admin.manage' }, () => controlApi.revokeAllSessions(admin.id))
      if (outcome.status === 'failed') {
        setActionError(outcome.error)
        return
      }
      if (outcome.status === 'cancelled') return
      setNotice(`Revoked ${outcome.value.revoked} session${outcome.value.revoked === 1 ? '' : 's'}.`)
      sessions.reload()
    },
    [run, sessions],
  )

  if (!canRead) {
    return (
      <div className="control-body">
        <SectionHeader eyebrow="Admin workspace" title="Security center" description="Sign-in activity, sessions and privilege decisions." />
        <Alert tone="warn">
          Your role does not grant access to security events. The server enforces this independently, so the request
          would be refused even if it were shown.
        </Alert>
      </div>
    )
  }

  const summary = events.data?.summary
  const pending = approvals.data?.approvals ?? []
  const unacknowledged = (events.data?.rows ?? []).filter((event) => !event.acknowledged)

  return (
    <div className="control-body">
      <SectionHeader
        eyebrow="Admin workspace"
        title="Security center"
        description="Monitor sessions, alerts, and local integrity checks."
        actions={
          <button
            type="button"
            className="btn-primary"
            onClick={() => {
              for (const key of ['events', 'sessions', 'approvals', 'accounts']) {
                if (visited[key]) {
                  if (key === 'events') events.reload()
                  if (key === 'sessions') sessions.reload()
                  if (key === 'approvals') approvals.reload()
                  if (key === 'accounts') accounts.reload()
                }
              }
            }}
          >
            <Icon name="refresh" />
            Refresh
          </button>
        }
      />

      {notice && <Alert tone="success">{notice}</Alert>}
      {actionError && <Alert tone="error">{actionError}</Alert>}

      <div className="kpi-row" style={{ marginBottom: 22 }}>
        <Kpi
          icon="alert"
          tone="red"
          label="Critical alerts"
          value={summary?.unacknowledged_critical ?? 0}
          sub="unacknowledged"
          alarm={summary ? summary.unacknowledged_critical > 0 : false}
        />
        <Kpi icon="warning" tone="amber" label="Warnings" value={summary?.unacknowledged_warning ?? 0} sub="unacknowledged" />
        <Kpi icon="key" tone="orange" label="Failed sign-ins" value={summary?.failed_logins_24h ?? 0} sub="in the last 24 hours" />
        <Kpi icon="users" tone="blue" label="Active sessions" value={summary?.active_sessions ?? 0} sub="able to act" />
        <Kpi
          icon="lock"
          tone="slate"
          label="Locked accounts"
          value={summary?.locked_accounts ?? 0}
          sub="after failed sign-ins"
          warn={summary ? summary.locked_accounts > 0 : false}
        />
        <Kpi
          icon="shield"
          tone="slate"
          label="Without a second factor"
          value={summary?.admins_without_mfa ?? 0}
          sub="active accounts"
          warn={summary ? summary.admins_without_mfa > 0 : false}
        />
      </div>

      <nav className="tabs" role="tablist">
        {(
          [
            ['events', 'Security events', unacknowledged.length || null],
            ['sessions', 'Sessions', sessions.data?.sessions.filter((item) => !item.revoked_at).length ?? null],
            ['approvals', 'Approvals', pending.length || null],
            ['accounts', 'Administrators', accounts.data?.admins.length ?? null],
          ] as const
        ).map(([id, label, count]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={`tab${tab === id ? ' active' : ''}`}
            onClick={() => openTab(id)}
          >
            {label}
            {count !== null && <span className="tab-count">{count}</span>}
          </button>
        ))}
      </nav>

      {tab === 'events' && (
        <ControlCard
          eyebrow="Events"
          title="Security events"
          description="Recorded separately from the audit trail: authentication outcomes, denials and privilege changes."
        >
          {events.error && <Alert tone="error">{events.error}</Alert>}
          <DataTable
            columns={eventColumns}
            rows={events.data?.rows ?? []}
            rowKey={(row) => row.id}
            searchPlaceholder="Search summaries, accounts or addresses…"
            pageSize={25}
            dense
            caption="Security events"
            emptyTitle="No security events recorded"
            emptyBody={<p>Sign-in activity and privilege decisions will appear here.</p>}
            rowActions={
              canManage
                ? (event: SecurityEvent) =>
                    event.acknowledged ? (
                      <span className="cell-secondary">acknowledged</span>
                    ) : (
                      <button
                        type="button"
                        className="link-button"
                        onClick={() => void acknowledge(event)}
                        title="Record that a human has seen this. The event itself is kept."
                      >
                        Acknowledge
                      </button>
                    )
                : undefined
            }
            filters={[
              {
                key: 'severity',
                label: 'Severity',
                match: (row: SecurityEvent, value: string) => row.severity === value,
                options: ['critical', 'warning', 'notice', 'info'].map((value) => ({
                  value,
                  label: SEVERITY_LABELS[value],
                })),
              },
              {
                key: 'acknowledged',
                label: 'Acknowledged',
                match: (row: SecurityEvent, value: string) =>
                  value === 'yes' ? row.acknowledged : !row.acknowledged,
                options: [
                  { value: 'no', label: 'Not yet acknowledged' },
                  { value: 'yes', label: 'Acknowledged' },
                ],
              },
              {
                key: 'kind',
                label: 'Kind',
                match: (row: SecurityEvent, value: string) => row.kind === value,
                options: Object.entries(KIND_LABELS).map(([value, label]) => ({ value, label })),
              },
            ]}
          />
        </ControlCard>
      )}

      {tab === 'sessions' && (
        <ControlCard
          eyebrow="Sessions"
          title="Administrator sessions"
          description="Every session that exists, whether active or revoked. Revocation takes effect on the next request."
        >
          {sessions.error && <Alert tone="error">{sessions.error}</Alert>}
          <p className="preview-footnote">
            Session tokens are never sent to the browser, so revocation is offered per account rather than per session.
            It signs that person out everywhere and takes effect immediately.
          </p>
          <DataTable
            columns={sessionColumns}
            rows={sessions.data?.sessions ?? []}
            rowKey={(row) => `${row.admin_id}:${row.created_at}:${row.ip ?? ''}`}
            searchPlaceholder="Search by account or address…"
            searchKeys={['display_name', 'username', 'ip']}
            pageSize={25}
            dense
            caption="Administrator sessions"
            emptyTitle="No sessions"
            rowActions={
              canManage
                ? (session: AdminSessionSummary) => {
                    if (session.revoked_at) return <span className="cell-secondary">—</span>
                    const admin = accounts.data?.admins.find((item) => item.id === session.admin_id)
                    return (
                      <button
                        type="button"
                        className="link-button link-danger"
                        onClick={() => {
                          if (!admin) return
                          setRevoking(admin)
                          setConfirm({
                            title: `Revoke all sessions for ${admin.display_name}?`,
                            confirmLabel: 'Revoke sessions',
                            tone: 'danger',
                            body: (
                              <p>
                                Every open session belonging to <strong>{admin.display_name}</strong> will be
                                terminated. They will be signed out and must authenticate again.
                              </p>
                            ),
                            footnote:
                              admin.id === adminId
                                ? 'Your current session stays signed in. This is how you sign out other devices you no longer have.'
                                : 'Recorded in the audit trail and the security log with your account, the request id and the result.',
                          })
                        }}
                      >
                        Revoke all
                      </button>
                    )
                  }
                : undefined
            }
          />
        </ControlCard>
      )}

      {tab === 'approvals' && <ApprovalsCard pending={pending} adminId={adminId} onDecide={decide} />}

      {tab === 'accounts' && (
        <AccountsCard
          adminId={adminId}
          role={role}
          data={accounts.data?.admins ?? []}
          onChanged={() => {
            accounts.reload()
            events.reload()
          }}
          onError={setActionError}
        />
      )}

      {confirm && (
        <ConfirmDialog
          options={confirm}
          onCancel={() => {
            setConfirm(null)
            setRevoking(null)
          }}
          onConfirm={() => {
            if (revoking) void revokeAll(revoking)
          }}
        />
      )}
    </div>
  )
}

/* ------------------------------------------------------------- columns --- */

const eventColumns: Column<SecurityEvent>[] = [
    {
      key: 'created_at',
      header: 'When',
      width: '170px',
      render: (event) => (
        <div className="cell-stack">
          <span className="mono">{formatInstant(event.created_at).slice(5)}</span>
          <span className="cell-secondary">{formatAge(event.created_at)}</span>
        </div>
      ),
    },
    {
      key: 'severity',
      header: 'Severity',
      width: '110px',
      render: (event) => (
        <span className="severity-badge">
          <span className={`severity-dot severity-${event.severity}`} aria-hidden="true" />
          {SEVERITY_LABELS[event.severity] ?? event.severity}
        </span>
      ),
    },
    {
      key: 'kind',
      header: 'Event',
      width: '210px',
      render: (event) => (
        <div className="cell-stack">
          <span>{KIND_LABELS[event.kind] ?? event.kind}</span>
          <code className="cell-secondary">{event.kind}</code>
        </div>
      ),
    },
    {
      key: 'summary',
      header: 'Detail',
      render: (event) => (
        <div className="cell-stack">
          <span>{event.summary}</span>
          <span className="cell-secondary">
            {event.admin_label || 'unidentified'}
            {event.ip ? ` · ${event.ip}` : ''}
          </span>
        </div>
      ),
    },
    {
      key: 'acknowledged',
      header: 'Acknowledged',
      secondary: true,
      render: (event) =>
        event.acknowledged ? (
          <span className="cell-secondary">{formatAge(event.acknowledged_at)}</span>
        ) : (
          <span className="pill pill-withdrawn">pending</span>
        ),
    },
]

const sessionColumns: Column<AdminSessionSummary>[] = [
    {
      key: 'display_name',
      header: 'Administrator',
      render: (session) => (
        <div className="cell-stack">
          <span className="cell-primary">
            {session.display_name}
            {session.current && <span className="pill pill-inline">this session</span>}
          </span>
          <span className="cell-secondary">{ROLE_LABELS[session.role]}</span>
        </div>
      ),
    },
    {
      key: 'created_at',
      header: 'Started',
      render: (session) => (
        <div className="cell-stack">
          <span className="mono">{formatInstant(session.created_at).slice(5)}</span>
          <span className="cell-secondary">{formatAge(session.created_at)}</span>
        </div>
      ),
    },
    {
      key: 'last_seen_at',
      header: 'Last seen',
      render: (session) => <span className="cell-secondary">{formatAge(session.last_seen_at)}</span>,
    },
    {
      key: 'mfa_verified_at',
      header: 'Second factor',
      secondary: true,
      render: (session) =>
        session.mfa_verified_at ? (
          <span className="pill pill-approved">verified</span>
        ) : (
          <span className="pill pill-draft">password only</span>
        ),
    },
    { key: 'ip', header: 'Source', secondary: true, render: (session) => <span className="mono cell-secondary">{session.ip ?? '—'}</span> },
    {
      key: 'state',
      header: 'State',
      render: (session) =>
        session.revoked_at ? (
          <div className="cell-stack">
            <span className="pill pill-disqualified">revoked</span>
            <span className="cell-secondary">{session.revoked_reason}</span>
          </div>
        ) : Date.parse(session.expires_at) <= Date.now() ? (
          <span className="pill pill-draft">expired</span>
        ) : (
          <span className="pill pill-approved">active</span>
        ),
    },
]

/* ------------------------------------------------------------ approvals --- */

function ApprovalsCard({
  pending,
  adminId,
  onDecide,
}: {
  pending: ApprovalRequest[]
  adminId: number
  onDecide: (approval: ApprovalRequest, decision: 'approved' | 'rejected', note: string) => Promise<void>
}) {
  const [active, setActive] = useState<{ approval: ApprovalRequest; decision: 'approved' | 'rejected' } | null>(null)

  if (pending.length === 0) {
    return (
      <ControlCard eyebrow="Two-person control" title="Approvals" description="Operations that need a second administrator are listed here.">
        <EmptyState title="Nothing waiting" icon="check-circle">
          <p>
            When an action needs two-person control, the requesting administrator raises it here and a{' '}
            <em>different</em> administrator decides. Nobody can approve their own request.
          </p>
        </EmptyState>
      </ControlCard>
    )
  }

  return (
    <ControlCard
      eyebrow="Two-person control"
      title="Approvals awaiting a second administrator"
      description="Each request names the operation, who asked, and why. Approving unlocks the operation for the requester."
    >
      <ul className="approval-queue">
        {pending.map((approval) => {
          const own = approval.requested_by === adminId
          return (
            <li key={approval.id} className="approval-queue-row">
              <div className="approval-queue-body">
                <div className="approval-queue-head">
                  <span className="cell-primary">{approval.action}</span>
                  <code className="cell-secondary">{approval.permission}</code>
                </div>
                <p className="cell-secondary">
                  Requested by {approval.requested_by_label} {formatAge(approval.requested_at)} &middot; expires{' '}
                  {formatAge(approval.expires_at)} &middot; request {approval.request_id}
                </p>
                {approval.payload_summary && <p className="approval-payload">{approval.payload_summary}</p>}
                {approval.justification && (
                  <blockquote className="approval-justification">&ldquo;{approval.justification}&rdquo;</blockquote>
                )}
              </div>
              <div className="approval-queue-actions">
                {own ? (
                  <span className="cell-secondary">You raised this. Another administrator must decide it.</span>
                ) : (
                  <>
                    <button
                      type="button"
                      className="btn-confirm btn-confirm-small"
                      onClick={() => setActive({ approval, decision: 'approved' })}
                    >
                      Approve
                    </button>
                    <button
                      type="button"
                      className="btn-cancel"
                      onClick={() => setActive({ approval, decision: 'rejected' })}
                    >
                      Reject
                    </button>
                  </>
                )}
              </div>
            </li>
          )
        })}
      </ul>

      {active && (
        <ApprovalDecisionDialog
          approval={active.approval}
          decision={active.decision}
          onCancel={() => setActive(null)}
          onConfirm={async (note) => {
            await onDecide(active.approval, active.decision, note ?? '')
            setActive(null)
          }}
        />
      )}
    </ControlCard>
  )
}

function ApprovalDecisionDialog({
  approval,
  decision,
  onCancel,
  onConfirm,
}: {
  approval: ApprovalRequest
  decision: 'approved' | 'rejected'
  onCancel: () => void
  onConfirm: (note?: string) => Promise<void>
}) {
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const approving = decision === 'approved'
  return (
    <Modal
      title={approving ? `Approve: ${approval.action}?` : `Reject: ${approval.action}?`}
      onClose={onCancel}
      footer={
        <>
          <button type="button" className="btn-cancel" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className={approving ? 'btn-confirm' : 'btn-confirm btn-confirm-danger'}
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              await onConfirm(note)
              setBusy(false)
            }}
          >
            {busy ? 'Recording…' : approving ? 'Approve' : 'Reject'}
          </button>
        </>
      }
    >
      {approving ? (
        <>
          <p>
            You are approving <strong>{approval.requested_by_label}</strong> to perform{' '}
            <strong>{approval.action}</strong>, which requires <code>{approval.permission}</code>.
          </p>
          {approval.payload_summary && <p className="approval-payload">{approval.payload_summary}</p>}
          <Alert tone="warn">
            Your decision unlocks that operation. It does not perform it &mdash; the requester still runs it, and both
            names appear in the audit trail.
          </Alert>
        </>
      ) : (
        <p>
          Rejecting means <strong>{approval.requested_by_label}</strong> cannot perform{' '}
          <strong>{approval.action}</strong>. Nothing is changed on the platform.
        </p>
      )}
      <label className="confirm-typed-label" htmlFor="approval-note">
        Note for the audit trail
      </label>
      <textarea
        id="approval-note"
        rows={2}
        value={note}
        maxLength={400}
        onChange={(event) => setNote(event.target.value)}
        placeholder="Why you are making this decision."
      />
    </Modal>
  )
}

/* ------------------------------------------------------------- accounts --- */

function AccountsCard({
  adminId,
  role,
  data,
  onChanged,
  onError,
}: {
  adminId: number
  role: AdminRole
  data: AdminAccount[]
  onChanged: () => void
  onError: (message: string) => void
}) {
  const { run } = useElevation()
  const canManage = roleHas(role, 'admin.manage')
  const [busy, setBusy] = useState(false)

  const update = useCallback(
    async (admin: AdminAccount, patch: { role?: string; disabled?: boolean; unlock?: boolean }) => {
      onError('')
      setBusy(true)
      const outcome = await run(
        {
          permission: 'admin.manage',
          twoPerson: {
            permission: 'admin.manage',
            action: `admin.${patch.role ? 'role' : patch.disabled !== undefined ? 'status' : 'unlock'}`,
            resource: `admin:${admin.username}`,
            payloadSummary: `Change ${admin.display_name} (${admin.username})`,
            justification: '',
          },
        },
        (approvalToken) => controlApi.updateAccount(admin.id, patch, approvalToken),
      )
      setBusy(false)
      if (outcome.status === 'failed') {
        onError(outcome.error)
        return
      }
      if (outcome.status === 'cancelled') return
      onChanged()
    },
    [run, onError, onChanged],
  )

  const columns: Column<AdminAccount>[] = useMemo(
    () => [
      {
        key: 'display_name',
        header: 'Administrator',
        render: (admin) => (
          <div className="cell-stack">
            <span className="cell-primary">
              {admin.display_name}
              {admin.id === adminId && <span className="pill pill-inline">you</span>}
            </span>
            <span className="cell-secondary mono">{admin.username}</span>
          </div>
        ),
      },
      { key: 'role', header: 'Role', render: (admin) => <span className="pill">{ROLE_LABELS[admin.role]}</span> },
      {
        key: 'mfa_enabled',
        header: 'Second factor',
        render: (admin) =>
          admin.mfa_enabled ? (
            <span className="pill pill-approved">enabled</span>
          ) : (
            <span className="pill pill-draft">none</span>
          ),
      },
      {
        key: 'last_login_at',
        header: 'Last sign-in',
        render: (admin) => <span className="cell-secondary">{formatAge(admin.last_login_at)}</span>,
      },
      {
        key: 'state',
        header: 'State',
        render: (admin) => {
          const locked = admin.locked_until !== null && Date.parse(admin.locked_until) > Date.now()
          if (admin.disabled) return <span className="pill pill-disqualified">disabled</span>
          if (locked) return <span className="pill pill-withdrawn">locked</span>
          if (admin.must_change_password) return <span className="pill pill-withdrawn">must reset</span>
          return <span className="pill pill-approved">active</span>
        },
      },
    ],
    [adminId],
  )

  return (
    <ControlCard
      eyebrow="Accounts"
      title="Administrator accounts"
      description="Role changes, disabling and password resets all require a second administrator's approval and revoke the account's sessions immediately."
    >
      <DataTable
        columns={columns}
        rows={data}
        rowKey={(row) => row.id}
        searchPlaceholder="Search by name or username…"
        pageSize={25}
        dense
        caption="Administrator accounts"
        rowActions={(admin) => {
          if (!canManage || admin.id === adminId) {
            return <span className="cell-secondary">{admin.id === adminId ? 'your own account' : 'view only'}</span>
          }
          const locked = admin.locked_until !== null && Date.parse(admin.locked_until) > Date.now()
          return (
            <>
              <select
                className="inline-select"
                aria-label={`Role for ${admin.username}`}
                value={admin.role}
                disabled={busy}
                onChange={(event) => void update(admin, { role: event.target.value })}
              >
                {Object.entries(ROLE_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
              {locked && (
                <button type="button" className="link-button" disabled={busy} onClick={() => void update(admin, { unlock: true })}>
                  Unlock
                </button>
              )}
              <button
                type="button"
                className={`link-button${admin.disabled ? '' : ' link-danger'}`}
                disabled={busy}
                onClick={() => void update(admin, { disabled: !admin.disabled })}
              >
                {admin.disabled ? 'Enable' : 'Disable'}
              </button>
            </>
          )
        }}
      />
      {role === 'observer' && <p className="preview-footnote">Read-only accounts see only what their role permits.</p>}
    </ControlCard>
  )
}

/**
 * A figure tile.
 *
 * Same anatomy as the dashboard's, so the two screens read as one system: tinted
 * icon, label, figure, qualifier. `alarm` and `warn` tint the figure itself,
 * which is the only place colour is allowed to carry meaning on a KPI.
 */
function Kpi({
  icon,
  tone,
  label,
  value,
  sub,
  alarm,
  warn,
}: {
  icon: 'alert' | 'warning' | 'key' | 'users' | 'lock' | 'shield' | 'ballot' | 'check-circle' | 'trend'
  tone: 'blue' | 'green' | 'amber' | 'orange' | 'red' | 'slate'
  label: string
  value: React.ReactNode
  sub: string
  alarm?: boolean
  warn?: boolean
}) {
  return (
    <div className={`kpi${alarm ? ' kpi-alarm' : ''}${warn ? ' kpi-warn' : ''}`}>
      <div className="stat-card-top">
        <span className={`icon-tile icon-tile-sm tile-${tone}`}>
          <Icon name={icon} />
        </span>
        <span className="kpi-label">{label}</span>
      </div>
      <span className="kpi-value">{value}</span>
      <span className="kpi-sub">{sub}</span>
    </div>
  )
}
