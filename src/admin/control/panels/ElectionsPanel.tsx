/**
 * Elections.
 *
 * The platform-level list: every election in any state, searchable and
 * filterable. Cards rather than a table because an election is a thing with a
 * state and a shape, not a row to be compared across — the comparison that
 * matters, who is running and when, reads off the card directly.
 *
 * Lifecycle actions run through the elevation provider, so closing, certifying
 * and other consequential transitions ask for a password or a second approver
 * when the server says they need one. The buttons here are a convenience: the
 * same permission is checked again in `src/server/authorize.ts` before the
 * command runs, whatever the interface shows.
 */

import { useCallback, useMemo, useState } from 'react'
import { electionApi } from '../../../lib/api'
import { LIFECYCLE_ACTION_LABELS, STATUS_LABELS } from '../../../lib/lifecycle'
import { elevationFor, permissionForLifecycleAction } from '../../../lib/rbac'
import { formatInZone } from '../../../lib/time'
import {
  ELECTION_STATUSES,
  ELECTION_TYPE_LABELS,
  type ElectionSummary,
  type LifecycleAction,
} from '../../../lib/types'
import { Alert, Countdown, Eyebrow, Modal, StatusBadge } from '../../../ui/primitives'
import { Icon } from '../../../ui/Icon'
import { ConfirmDialog, type ConfirmOptions } from '../ConfirmDialog'
import { useElevation } from '../elevation'
import { SectionHeader, useControlData } from '../shared'
import { CreateElection } from '../../election/CreateElection'

/** Actions offered from a card's overflow menu, in lifecycle order. */
const QUICK_ACTIONS: readonly LifecycleAction[] = [
  'publish',
  'open',
  'pause',
  'resume',
  'close',
  'certify',
  'archive',
]

/** Transitions that fix what has already happened and so warn before running. */
const IRREVERSIBLE: Partial<Record<LifecycleAction, (election: ElectionSummary) => ConfirmOptions>> = {
  close: (election) => ({
    title: 'Close voting for good?',
    confirmLabel: 'Close voting',
    tone: 'danger',
    body: (
      <>
        <p>
          <strong>{election.title}</strong> will move from {STATUS_LABELS[election.status].toLowerCase()} to closed.
        </p>
        <p>
          Voting stops immediately and the tally is fixed. A closed poll can never be reopened, so the audit trail
          will record that voting was ended by an administrator rather than by the schedule.
        </p>
      </>
    ),
    footnote: 'Recorded in the audit trail against your account, with the request id and result.',
  }),
  certify: (election) => ({
    title: 'Certify this result?',
    confirmLabel: 'Certify result',
    tone: 'danger',
    body: (
      <>
        <p>
          <strong>{election.title}</strong> will move from closed to certified.
        </p>
        <p>
          This signs the result off as the official record. It becomes the final tally for this election and cannot be
          changed afterwards.
        </p>
      </>
    ),
    footnote: 'Recorded in the audit trail against your account, with the request id and result.',
  }),
}

export function ElectionsPanel({
  serverOffsetMs,
  onOpenWorkspace,
  onChanged,
}: {
  serverOffsetMs: number
  onOpenWorkspace: (electionId: string) => void
  onChanged: () => void
}) {
  const { data, error, loading, reload } = useControlData<{ elections: ElectionSummary[] }>(() =>
    electionApi.list(true),
  )
  const { run } = useElevation()
  const [creating, setCreating] = useState(false)
  const [confirm, setConfirm] = useState<ConfirmOptions | null>(null)
  /** The transition waiting on that confirmation, so cancel is a real cancel. */
  const [awaiting, setAwaiting] = useState<{ election: ElectionSummary; action: LifecycleAction } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('all')

  const elections = useMemo(() => data?.elections ?? [], [data])

  const transition = useCallback(
    async (election: ElectionSummary, action: LifecycleAction) => {
      const permission = permissionForLifecycleAction(action)
      if (!permission) return
      setActionError(null)
      setNotice(null)
      const outcome = await run({ permission }, (approvalToken) =>
        electionApi.transition(election.id, action, undefined, approvalToken),
      )
      if (outcome.status === 'failed') {
        setActionError(outcome.error)
        return
      }
      if (outcome.status === 'cancelled') return
      setNotice(`${election.title} is now ${STATUS_LABELS[outcome.value.election.effective_status].toLowerCase()}.`)
      reload()
      onChanged()
    },
    [run, reload, onChanged],
  )

  const requestTransition = useCallback(
    (election: ElectionSummary, action: LifecycleAction) => {
      const warning = IRREVERSIBLE[action]?.(election)
      if (warning) {
        setAwaiting({ election, action })
        setConfirm(warning)
        return
      }
      void transition(election, action)
    },
    [transition],
  )

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return elections.filter((row) => {
      if (status !== 'all' && row.effective_status !== status) return false
      if (!needle) return true
      return (
        row.title.toLowerCase().includes(needle) ||
        row.id.toLowerCase().includes(needle) ||
        (ELECTION_TYPE_LABELS[row.election_type] ?? row.election_type).toLowerCase().includes(needle)
      )
    })
  }, [elections, query, status])

  return (
    <div className="control-body">
      <SectionHeader
        eyebrow="Election registry"
        title="All elections"
        description="One local workspace for every ballot you run."
        actions={
          <button type="button" className="btn-primary" onClick={() => setCreating(true)}>
            <Icon name="plus" />
            Create election
          </button>
        }
      />

      {notice && <Alert tone="success">{notice}</Alert>}
      {actionError && <Alert tone="error">{actionError}</Alert>}
      {error && <Alert tone="error">{error}</Alert>}

      <div className="table-toolbar" style={{ marginBottom: 20 }}>
        <div className="table-search">
          <Icon name="search" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search elections"
            aria-label="Search elections"
          />
        </div>
        <div className="table-filter">
          <select value={status} onChange={(event) => setStatus(event.target.value)} aria-label="Filter by status">
            <option value="all">All statuses</option>
            {ELECTION_STATUSES.map((entry) => (
              <option key={entry} value={entry}>
                {STATUS_LABELS[entry]}
              </option>
            ))}
          </select>
        </div>
        <span className="table-count" style={{ margin: 0, marginLeft: 'auto' }}>
          {visible.length} of {elections.length} shown
        </span>
      </div>

      {loading && !data ? (
        <p className="control-loading">Loading elections…</p>
      ) : visible.length === 0 ? (
        <div className="empty-state">
          <span className="icon-tile icon-tile-lg tile-blue">
            <Icon name="flag" />
          </span>
          <h3>{elections.length === 0 ? 'No elections yet' : 'Nothing matches those filters'}</h3>
          <p>
            {elections.length === 0
              ? 'Create the first election to get started. It will begin as a draft and stay private until you publish it.'
              : 'Clear the search or choose a different status to see more of the registry.'}
          </p>
          <div className="empty-state-actions">
            {elections.length === 0 ? (
              <button type="button" className="btn-primary" onClick={() => setCreating(true)}>
                <Icon name="plus" />
                Create election
              </button>
            ) : (
              <button
                type="button"
                className="btn-outline"
                onClick={() => {
                  setQuery('')
                  setStatus('all')
                }}
              >
                Clear filters
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="election-grid election-grid-wide">
          {visible.map((election) => (
            <ElectionCard
              key={election.id}
              election={election}
              serverOffsetMs={serverOffsetMs}
              onOpen={() => onOpenWorkspace(election.id)}
              onAction={(action) => requestTransition(election, action)}
            />
          ))}
        </div>
      )}

      {creating && (
        <Modal title="Create an election" onClose={() => setCreating(false)} wide>
          <CreateElection
            onCancel={() => setCreating(false)}
            onCreated={(election) => {
              setCreating(false)
              setNotice(`Created ${election.title} as a draft.`)
              reload()
              onChanged()
              onOpenWorkspace(election.id)
            }}
          />
        </Modal>
      )}

      {confirm && (
        <ConfirmDialog
          options={confirm}
          onCancel={() => {
            setConfirm(null)
            setAwaiting(null)
          }}
          onConfirm={() => {
            const target = awaiting
            setConfirm(null)
            setAwaiting(null)
            if (target) void transition(target.election, target.action)
          }}
        />
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ card --- */

/**
 * One election.
 *
 * A `<details>` disclosure holds the lifecycle actions rather than a popover: it
 * needs no positioning, works with the keyboard, and closes itself. The card
 * itself opens the election; the menu is the only thing inside it that does.
 */
function ElectionCard({
  election,
  serverOffsetMs,
  onOpen,
  onAction,
}: {
  election: ElectionSummary
  serverOffsetMs: number
  onOpen: () => void
  onAction: (action: LifecycleAction) => void
}) {
  const available = election.actions.filter((entry) => entry.available)
  const quick = QUICK_ACTIONS.map((action) => available.find((entry) => entry.action === action)).filter(
    (entry): entry is NonNullable<typeof entry> => Boolean(entry),
  )
  const turnout =
    election.eligible_count > 0 ? (election.participant_count / election.eligible_count) * 100 : null
  const nextAt =
    election.effective_status === 'open'
      ? Date.parse(election.ends_at)
      : election.effective_status === 'scheduled'
        ? Date.parse(election.starts_at)
        : null
  const scheduled = nextAt !== null && nextAt - (Date.now() + serverOffsetMs) > 0

  return (
    <div className="election-card" style={{ cursor: 'default' }}>
      <div className="election-card-top">
        <StatusBadge status={election.status} effective={election.effective_status} />
        <details className="menu">
          <summary className="btn-icon btn-icon-sm" aria-label={`Actions for ${election.title}`}>
            <Icon name="more" />
          </summary>
          <div className="menu-panel">
            {quick.length === 0 && <p className="menu-empty">No lifecycle actions available.</p>}
            {quick.map((entry) => {
              const permission = permissionForLifecycleAction(entry.action)
              const step = permission ? elevationFor(permission).elevation : 'none'
              return (
                <button
                  key={entry.action}
                  type="button"
                  className="menu-item"
                  title={
                    [
                      entry.reason,
                      step === 'reauth' ? 'You will be asked to confirm your password.' : null,
                      step === 'mfa' ? 'You will be asked for a second factor.' : null,
                      step === 'two_person' ? 'A second administrator must approve this.' : null,
                    ]
                      .filter(Boolean)
                      .join(' ')
                  }
                  onClick={(event) => {
                    const details = event.currentTarget.closest('details')
                    details?.removeAttribute('open')
                    onAction(entry.action)
                  }}
                >
                  <Icon name="arrow-right" />
                  {LIFECYCLE_ACTION_LABELS[entry.action]}
                </button>
              )
            })}
            <div className="menu-rule" />
            <button
              type="button"
              className="menu-item"
              onClick={(event) => {
                event.currentTarget.closest('details')?.removeAttribute('open')
                onOpen()
              }}
            >
              <Icon name="settings" />
              Open workspace
            </button>
          </div>
        </details>
      </div>

      <button type="button" className="election-card-open" onClick={onOpen}>
        <h2>{election.title}</h2>
        <p className="election-card-desc">
          {ELECTION_TYPE_LABELS[election.election_type]} · {formatInZone(election.starts_at, election.timezone)} →{' '}
          {formatInZone(election.ends_at, election.timezone)}
        </p>
      </button>

      <div className="election-tally">
        <div>
          <Eyebrow>Turnout</Eyebrow>
          <strong>{turnout === null ? '—' : `${turnout.toFixed(0)}%`}</strong>
        </div>
        <div>
          <Eyebrow>Votes cast</Eyebrow>
          <strong>{election.ballot_count.toLocaleString()}</strong>
        </div>
        <div>
          <Eyebrow>Eligible</Eyebrow>
          <strong>{election.eligible_count.toLocaleString()}</strong>
        </div>
      </div>

      <div className="progress">
        <div
          className={`progress-fill${turnout === null || turnout === 0 ? ' progress-fill-idle' : ''}`}
          style={{ width: `${turnout === null ? 0 : Math.max(0, Math.min(100, turnout))}%` }}
        />
      </div>

      <div className="election-card-foot">
        <span className="election-card-when">
          <Icon name="clock" />
          {scheduled ? (
            <Countdown
              targetAt={nextAt}
              serverOffsetMs={serverOffsetMs}
              prefix={election.effective_status === 'open' ? 'Closes ' : 'Opens '}
            />
          ) : (
            `${election.effective_status === 'closed' ? 'Closed' : election.effective_status === 'certified' ? 'Certified' : 'Not scheduled'} ${shortDate(election.ends_at)}`
          )}
        </span>
        <button type="button" className="link-button" onClick={onOpen}>
          Manage
          <Icon name="arrow-right" />
        </button>
      </div>
    </div>
  )
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function shortDate(instant: string): string {
  const at = new Date(instant)
  if (Number.isNaN(at.getTime())) return '—'
  return `${MONTHS[at.getMonth()]} ${at.getDate()}, ${at.getFullYear()}`
}
