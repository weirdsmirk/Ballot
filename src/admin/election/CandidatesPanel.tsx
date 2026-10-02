/**
 * Candidate and ballot-option management for one election.
 *
 * Editing is gated by the election's lifecycle state, and the reason a control
 * is disabled is always shown rather than silently hidden, so an administrator
 * understands *why* they cannot change something.
 */

import { useState } from 'react'
import { electionApi } from '../../lib/api'
import type { CandidateStatus, CandidateWithTally, ElectionSummary } from '../../lib/types'
import { Alert, EmptyState, Eyebrow, Field, Modal } from '../../ui/primitives'
import { Icon, initials } from '../../ui/Icon'

const STATUS_LABELS: Record<CandidateStatus, string> = {
  draft: 'Draft',
  approved: 'Approved',
  withdrawn: 'Withdrawn',
  disqualified: 'Disqualified',
}

/**
 * Avatar colours, cycled down the roster.
 *
 * An option with no portrait gets a monogram instead, and a monogram needs a
 * background. Cycling a fixed set of tints — rather than deriving one from the
 * name — keeps the roster looking like a set rather than a randomiser.
 */
const AVATAR_TONES = ['navy', 'blue', 'green', 'orange', 'slate']
type Draft = {
  id?: number
  name: string
  organization: string
  abbreviation: string
  description: string
  image_url: string
  symbol: string
  position: number
  status: CandidateStatus
}

const EMPTY: Draft = {
  name: '',
  organization: '',
  abbreviation: '',
  description: '',
  image_url: '',
  symbol: '',
  position: 1,
  status: 'approved',
}

export function CandidatesPanel({
  election,
  candidates,
  onChanged,
}: {
  election: ElectionSummary
  candidates: CandidateWithTally[]
  onChanged: () => Promise<void> | void
}) {
  const [editing, setEditing] = useState<Draft | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [statusChange, setStatusChange] = useState<{ candidate: CandidateWithTally; status: CandidateStatus } | null>(null)
  const [reason, setReason] = useState('')

  const canEdit = election.edits_allowed
  const canChangeStatus = election.status_changes_allowed
  const lockReason = canEdit
    ? null
    : election.status === 'open'
      ? 'Voting is open. Pause the poll to change candidate status; the ballot itself is now frozen.'
      : `This election is locked because it is ${election.effective_status.replace('_', ' ')}.`

  const save = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!editing) return
    setBusy(true)
    setError(null)
    const payload = {
      name: editing.name,
      organization: editing.organization,
      abbreviation: editing.abbreviation,
      description: editing.description,
      image_url: editing.image_url,
      symbol: editing.symbol,
      position: editing.position,
      status: editing.status,
    }
    const result = editing.id
      ? await electionApi.updateCandidate(election.id, editing.id, payload)
      : await electionApi.addCandidate(election.id, payload)
    setBusy(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    setEditing(null)
    await onChanged()
  }

  const applyStatus = async () => {
    if (!statusChange) return
    setBusy(true)
    setError(null)
    const result = await electionApi.setCandidateStatus(election.id, statusChange.candidate.id, statusChange.status, reason)
    setBusy(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    setStatusChange(null)
    setReason('')
    await onChanged()
  }

  const remove = async (candidate: CandidateWithTally) => {
    if (!window.confirm(`Remove "${candidate.name}" from the ballot?`)) return
    setBusy(true)
    setError(null)
    const result = await electionApi.removeCandidate(election.id, candidate.id)
    setBusy(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    await onChanged()
  }

  const move = async (candidate: CandidateWithTally, direction: -1 | 1) => {
    const order = candidates.map((item) => item.id)
    const index = order.indexOf(candidate.id)
    const target = index + direction
    if (index < 0 || target < 0 || target >= order.length) return
    ;[order[index], order[target]] = [order[target], order[index]]
    setBusy(true)
    const result = await electionApi.reorderCandidates(election.id, order)
    setBusy(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    await onChanged()
  }

  const totalVotes = candidates.reduce((sum, candidate) => sum + candidate.vote_count, 0)

  return (
    <div className="panel">
      <div className="panel-head">
        <div>
          <Eyebrow>Ballot options</Eyebrow>
          <h2 style={{ marginTop: 9 }}>Candidates on this ballot</h2>
          <p>
            {candidates.length} option{candidates.length === 1 ? '' : 's'} &middot;{' '}
            {election.approved_candidate_count} approved &middot; {totalVotes.toLocaleString()} vote
            {totalVotes === 1 ? '' : 's'} recorded
          </p>
        </div>
        {canEdit && (
          <button
            type="button"
            className="btn-outline"
            onClick={() => setEditing({ ...EMPTY, position: candidates.length + 1 })}
          >
            <Icon name="plus" />
            Add candidate
          </button>
        )}
      </div>

      {error && <Alert tone="error">{error}</Alert>}
      {!canEdit && <Alert tone="warn">{lockReason}</Alert>}

      {candidates.length === 0 ? (
        <EmptyState title="No candidates yet" icon="users">
          <p>Add at least two approved options before this election can be published.</p>
        </EmptyState>
      ) : (
        <ul className="roster">
          {candidates.map((candidate, index) => (
            <li key={candidate.id} className="roster-row">
              <span className={`roster-avatar av-${AVATAR_TONES[index % AVATAR_TONES.length]}`}>
                {initials(candidate.name)}
              </span>
              <div className="roster-body">
                <p className="roster-name">{candidate.name}</p>
                <p className="roster-sub">
                  {candidate.organization || `Position ${candidate.position}`}
                  {candidate.symbol ? ` · ${candidate.symbol}` : ''}
                </p>
              </div>
              <span className={`pill pill-${candidate.status}`}>{STATUS_LABELS[candidate.status]}</span>
              <div className="roster-tally">
                <strong>{candidate.vote_count.toLocaleString()}</strong>
                <span>
                  {totalVotes > 0
                    ? `votes · ${Math.round((candidate.vote_count / totalVotes) * 100)}%`
                    : 'no votes yet'}
                </span>
              </div>
              <details className="menu">
                <summary className="btn-icon btn-icon-sm" aria-label={`Actions for ${candidate.name}`}>
                  <Icon name="more" />
                </summary>
                <div className="menu-panel">
                  {canEdit && (
                    <>
                      <button
                        type="button"
                        className="menu-item"
                        disabled={busy || index === 0}
                        onClick={(event) => {
                          event.currentTarget.closest('details')?.removeAttribute('open')
                          void move(candidate, -1)
                        }}
                      >
                        <Icon name="arrow-left" />
                        Move up
                      </button>
                      <button
                        type="button"
                        className="menu-item"
                        disabled={busy || index === candidates.length - 1}
                        onClick={(event) => {
                          event.currentTarget.closest('details')?.removeAttribute('open')
                          void move(candidate, 1)
                        }}
                      >
                        <Icon name="arrow-right" />
                        Move down
                      </button>
                      <button
                        type="button"
                        className="menu-item"
                        onClick={(event) => {
                          event.currentTarget.closest('details')?.removeAttribute('open')
                          setEditing({ ...candidate })
                        }}
                      >
                        <Icon name="settings" />
                        Edit
                      </button>
                      <div className="menu-rule" />
                    </>
                  )}
                  {canEdit ? (
                    <button
                      type="button"
                      className="menu-item"
                      style={{ color: 'var(--red)' }}
                      onClick={(event) => {
                        event.currentTarget.closest('details')?.removeAttribute('open')
                        void remove(candidate)
                      }}
                    >
                      <Icon name="close" />
                      Remove
                    </button>
                  ) : (
                    canChangeStatus &&
                    (candidate.status === 'approved' ? (
                      <>
                        <button
                          type="button"
                          className="menu-item"
                          onClick={(event) => {
                            event.currentTarget.closest('details')?.removeAttribute('open')
                            setStatusChange({ candidate, status: 'withdrawn' })
                          }}
                        >
                          <Icon name="arrow-left" />
                          Withdraw
                        </button>
                        <button
                          type="button"
                          className="menu-item"
                          style={{ color: 'var(--red)' }}
                          onClick={(event) => {
                            event.currentTarget.closest('details')?.removeAttribute('open')
                            setStatusChange({ candidate, status: 'disqualified' })
                          }}
                        >
                          <Icon name="close" />
                          Disqualify
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className="menu-item"
                        onClick={(event) => {
                          event.currentTarget.closest('details')?.removeAttribute('open')
                          setStatusChange({ candidate, status: 'approved' })
                        }}
                      >
                        <Icon name="check" />
                        Reinstate
                      </button>
                    ))
                  )}
                </div>
              </details>
            </li>
          ))}
        </ul>
      )}

      {editing && (
        <Modal
          title={editing.id ? 'Edit ballot option' : 'Add ballot option'}
          onClose={() => setEditing(null)}
          wide
          footer={
            <>
              <button type="button" className="btn-cancel" onClick={() => setEditing(null)}>
                Cancel
              </button>
              <button type="submit" form="candidate-form" className="btn-primary" disabled={busy}>
                {busy ? 'Saving…' : 'Save'}
              </button>
            </>
          }
        >
          <form id="candidate-form" onSubmit={save}>
            {error && <Alert tone="error">{error}</Alert>}
            <div className="form-grid">
              <Field label="Name" htmlFor="c-name">
                <input
                  id="c-name"
                  value={editing.name}
                  onChange={(event) => setEditing({ ...editing, name: event.target.value })}
                  required
                  maxLength={120}
                />
              </Field>
              <Field label="Party or organisation" htmlFor="c-org">
                <input
                  id="c-org"
                  value={editing.organization}
                  onChange={(event) => setEditing({ ...editing, organization: event.target.value })}
                  maxLength={120}
                  placeholder="Optional"
                />
              </Field>
            </div>
            <div className="form-grid">
              <Field label="Abbreviation" htmlFor="c-abbr" hint="Up to 16 characters.">
                <input
                  id="c-abbr"
                  value={editing.abbreviation}
                  onChange={(event) => setEditing({ ...editing, abbreviation: event.target.value })}
                  maxLength={16}
                  placeholder="Optional"
                />
              </Field>
              <Field label="Symbol" htmlFor="c-symbol" hint="Short symbol or emblem label.">
                <input
                  id="c-symbol"
                  value={editing.symbol}
                  onChange={(event) => setEditing({ ...editing, symbol: event.target.value })}
                  maxLength={8}
                  placeholder="Optional"
                />
              </Field>
            </div>
            <Field label="Description" htmlFor="c-desc" hint="Manifesto summary shown on the ballot.">
              <textarea
                id="c-desc"
                rows={3}
                value={editing.description}
                onChange={(event) => setEditing({ ...editing, description: event.target.value })}
                maxLength={1000}
              />
            </Field>
            <div className="form-grid">
              <Field label="Image URL" htmlFor="c-img" hint="http(s) URL or a root-relative path.">
                <input
                  id="c-img"
                  value={editing.image_url}
                  onChange={(event) => setEditing({ ...editing, image_url: event.target.value })}
                  maxLength={500}
                  placeholder="Optional"
                />
              </Field>
              <Field label="Status" htmlFor="c-status">
                <select
                  id="c-status"
                  value={editing.status}
                  onChange={(event) => setEditing({ ...editing, status: event.target.value as CandidateStatus })}
                >
                  {(Object.keys(STATUS_LABELS) as CandidateStatus[]).map((status) => (
                    <option key={status} value={status}>
                      {STATUS_LABELS[status]}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
          </form>
        </Modal>
      )}

      {statusChange && (
        <Modal
          title={`Mark "${statusChange.candidate.name}" as ${STATUS_LABELS[statusChange.status].toLowerCase()}`}
          onClose={() => setStatusChange(null)}
          footer={
            <>
              <button type="button" className="btn-cancel" onClick={() => setStatusChange(null)}>
                Cancel
              </button>
              <button type="button" className="btn-confirm" disabled={busy} onClick={() => void applyStatus()}>
                {busy ? 'Saving…' : 'Confirm'}
              </button>
            </>
          }
        >
          {error && <Alert tone="error">{error}</Alert>}
          <p className="modal-desc">
            This change is recorded in the audit trail with your name. Votes already cast for this option are retained but
            the option will no longer appear on the ballot.
          </p>
          <Field label="Reason (optional)" htmlFor="c-reason">
            <input id="c-reason" value={reason} onChange={(event) => setReason(event.target.value)} maxLength={300} />
          </Field>
        </Modal>
      )}
    </div>
  )
}
