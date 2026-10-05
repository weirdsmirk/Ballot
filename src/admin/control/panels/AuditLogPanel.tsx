/**
 * Audit log.
 *
 * The record of who did what, when, to which resource, and with what outcome.
 * This is the screen an auditor works from, so it is built around finding things
 * rather than browsing them: server-side search and filtering across actor,
 * action, outcome, election and time range, with the request id visible on every
 * row so an entry can be tied back to a specific request.
 *
 * Denials are first-class rows. An account repeatedly attempting something it is
 * not permitted to do is recorded the same way a success is, which is what makes
 * the "who tried to do what" question answerable after the fact.
 */

import { useCallback, useEffect, useState } from 'react'
import { controlApi, type AuditQueryResult } from '../../../lib/api'
import { ROLE_LABELS, isAdminRole } from '../../../lib/rbac'
import type { AuditEvent, AuditResult } from '../../../lib/adminTypes'
import type { ElectionSummary } from '../../../lib/types'
import { Alert, EmptyState } from '../../../ui/primitives'
import { DataTable, type Column } from '../DataTable'
import { ControlCard, SectionHeader, formatInstant } from '../shared'

const RESULT_LABELS: Record<AuditResult, string> = {
  success: 'Succeeded',
  denied: 'Denied',
  failure: 'Failed',
}

/** Human labels for the actions the platform records. */
const ACTION_LABELS: Record<string, string> = {
  admin_login: 'Signed in',
  admin_logout: 'Signed out',
  admin_reauthenticated: 'Re-entered password to authorise an action',
  admin_mfa_stepup: 'Satisfied a second factor for an action',
  admin_mfa_stepup_failed: 'Failed second factor for an action',
  admin_bootstrap: 'Created the first administrator',
  admin_created: 'Created an administrator',
  admin_updated: 'Updated an administrator',
  admin_password_reset: 'Reset an administrator password',
  admin_password_changed: 'Changed their own password',
  mfa_enabled: 'Enabled a second factor',
  mfa_disabled: 'Removed a second factor',
  election_created: 'Created an election',
  election_updated: 'Updated election settings',
  election_deleted: 'Deleted an election',
  election_publish: 'Published an election',
  election_unpublish: 'Returned an election to draft',
  election_open: 'Opened voting',
  election_pause: 'Paused voting',
  election_resume: 'Resumed voting',
  election_close: 'Closed voting',
  election_certify: 'Certified results',
  election_archive: 'Archived an election',
  auto_open: 'Opened automatically on schedule',
  auto_close: 'Closed automatically on schedule',
  rules_updated: 'Changed voting rules',
  eligibility_updated: 'Changed eligibility rules',
  candidate_added: 'Added a candidate',
  candidate_updated: 'Updated a candidate',
  candidate_removed: 'Removed a candidate',
  candidate_status_changed: 'Changed candidate status',
  ballot_reordered: 'Reordered the ballot',
  voters_added: 'Added voters to a roll',
  voters_removed: 'Removed voters from a roll',
  voter_eligibility_changed: 'Changed voter eligibility',
  vote_cast: 'Ballot cast',
  vote_changed: 'Ballot replaced',
  voter_verified: 'Voter verified',
  settings_updated: 'Changed platform settings',
  backup_created: 'Created a backup',
  backup_restore: 'Restored from a backup',
  backup_restored: 'Restored from a backup',
  system_reset: 'Reset the platform',
  session_revoked: 'Revoked a session',
  sessions_revoked_all: 'Revoked all sessions for an account',
  approval_requested: 'Requested a second approver',
  approval_approved: 'Approved a request',
  approval_rejected: 'Rejected a request',
  security_alert_acknowledged: 'Acknowledged a security alert',
}

export function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action.replace(/_/g, ' ')
}

export function AuditLogPanel({ elections }: { elections: ElectionSummary[] }) {
  const [query, setQuery] = useState({
    search: '',
    electionId: '',
    actor: '',
    action: '',
    result: '',
  })
  const [page, setPage] = useState(0)
  const [data, setData] = useState<AuditQueryResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const pageSize = 50

  // Debounced so typing in the search box does not fire a request per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => {
      let cancelled = false
      setLoading(true)
      void controlApi
        .audit({
          search: query.search || undefined,
          electionId: query.electionId || undefined,
          actor: query.actor || undefined,
          action: query.action || undefined,
          result: (query.result || undefined) as AuditResult | undefined,
          limit: pageSize,
          offset: page * pageSize,
        })
        .then((result) => {
          if (cancelled) return
          setLoading(false)
          if (result.ok) {
            setData(result.value)
            setError(null)
          } else {
            setError(result.error)
          }
        })
      return () => {
        cancelled = true
      }
    }, 220)
    return () => clearTimeout(timer)
  }, [query, page])

  const onQueryChange = useCallback((next: { search: string; filters: Record<string, string> }) => {
    setPage(0)
    setQuery((current) => ({
      ...current,
      search: next.search,
      electionId: next.filters.election ?? current.electionId,
      actor: next.filters.actor ?? current.actor,
      action: next.filters.action ?? current.action,
      result: next.filters.result ?? current.result,
    }))
  }, [])

  const rows = data?.rows ?? []
  const actions = data?.actions ?? []

  const columns: Column<AuditEvent>[] = [
    {
      key: 'created_at',
      header: 'When',
      width: '170px',
      render: (event) => (
        <div className="cell-stack">
          <span className="data">{formatInstant(event.created_at).slice(5)}</span>
          <span className="cell-secondary">UTC</span>
        </div>
      ),
    },
    {
      key: 'actor_label',
      header: 'Who',
      width: '160px',
      render: (event) => (
        <div className="cell-stack">
          <span className="cell-primary">{event.actor_label || '—'}</span>
          <span className="cell-secondary">
            {event.actor_role && isAdminRole(event.actor_role)
              ? ROLE_LABELS[event.actor_role]
              : event.actor_type}
          </span>
        </div>
      ),
    },
    {
      key: 'action',
      header: 'Action',
      width: '230px',
      render: (event) => (
        <div className="cell-stack">
          <span>{actionLabel(event.action)}</span>
          <code className="cell-secondary">{event.action}</code>
        </div>
      ),
    },
    {
      key: 'summary',
      header: 'Detail',
      render: (event) => (
        <div className="cell-stack">
          <span>{event.summary}</span>
          <span className="cell-secondary data">{event.resource}</span>
        </div>
      ),
    },
    {
      key: 'election_id',
      header: 'Election',
      secondary: true,
      render: (event) =>
        event.election_id ? <span className="data">{event.election_id}</span> : <span className="cell-secondary">platform</span>,
    },
    {
      key: 'result',
      header: 'Outcome',
      render: (event) => (
        <span className={`pill pill-${event.result === 'success' ? 'approved' : event.result === 'denied' ? 'disqualified' : 'withdrawn'}`}>
          {RESULT_LABELS[event.result] ?? event.result}
        </span>
      ),
    },
    {
      key: 'request_id',
      header: 'Request',
      secondary: true,
      render: (event) => (
        <span className="data cell-secondary" title="Ties this record to the server log for the same request">
          {event.request_id || '—'}
        </span>
      ),
    },
    {
      key: 'ip',
      header: 'Source',
      secondary: true,
      sortable: false,
      value: () => '',
      render: (event) => <span className="data cell-secondary">{event.ip ?? '—'}</span>,
    },
  ]

  const filters = [
    {
      key: 'result',
      label: 'Outcome',
      match: (row: AuditEvent, value: string) => row.result === value,
      options: (['success', 'denied', 'failure'] as AuditResult[]).map((result) => ({
        value: result,
        label: RESULT_LABELS[result],
      })),
    },
    {
      key: 'election',
      label: 'Election',
      match: (row: AuditEvent, value: string) => row.election_id === value,
      options: elections.map((election) => ({ value: election.id, label: election.title })),
    },
    {
      key: 'actor',
      label: 'Actor type',
      match: (row: AuditEvent, value: string) => row.actor_type === value,
      options: [
        { value: 'admin', label: 'Administrator' },
        { value: 'system', label: 'System' },
        { value: 'voter', label: 'Voter' },
      ],
    },
    {
      key: 'action',
      label: 'Action',
      match: (row: AuditEvent, value: string) => row.action.startsWith(value),
      options: actions.map((action) => ({ value: action, label: actionLabel(action) })),
    },
  ]

  return (
    <div className="control-body">
      <SectionHeader
        eyebrow="Admin workspace"
        title="Audit log"
        description="An immutable record of every administrative action, whether it succeeded, was denied, or failed."
        actions={
          <button
            type="button"
            className="btn-outline"
            onClick={() => {
              setPage(0)
              setQuery({ search: '', electionId: '', actor: '', action: '', result: '' })
            }}
          >
            Reset filters
          </button>
        }
      />

      {error && <Alert tone="error">{error}</Alert>}

      <ControlCard
        eyebrow="Entries"
        title="Recorded events"
        description="Search covers the summary, detail, action, resource and request id."
      >
        {loading && !data ? (
          <p className="control-loading">Loading the audit log…</p>
        ) : rows.length === 0 && !query.search ? (
          <EmptyState title="Nothing recorded yet" icon="audit">
            <p>Administrative actions will appear here as they happen.</p>
          </EmptyState>
        ) : (
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(row) => row.id}
            searchPlaceholder="Search summaries, resources, request ids…"
            filters={filters}
            dense
            caption="Audit log"
            server={{
              total: data?.total ?? 0,
              page,
              pageSize,
              loading,
              onPageChange: setPage,
              onQueryChange,
            }}
          />
        )}
      </ControlCard>
    </div>
  )
}
