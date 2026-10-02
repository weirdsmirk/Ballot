/**
 * Ballot options.
 *
 * Candidates, across every election, in one searchable table. An operator
 * running several polls needs to answer "who is on the ballot for the club
 * election, and what is their status" without opening five workspaces.
 *
 * The rule that shapes this screen is the freeze: once a poll opens, options
 * cannot be added, removed or reordered, because that would change what voters
 * have already seen. Status changes (withdraw, disqualify, reinstate) remain
 * possible only while a poll is paused. The screen says which regime applies
 * rather than leaving the server to refuse a click.
 */

import { useCallback, useMemo, useState } from 'react'
import { electionApi, type CandidateInput } from '../../../lib/api'
import { roleHas, type AdminRole } from '../../../lib/rbac'
import {
  CANDIDATE_STATUSES,
  ELECTION_TYPE_LABELS,
  type CandidateStatus,
  type CandidateWithTally,
  type ElectionSummary,
} from '../../../lib/types'
import { Alert, EmptyState, Field, Modal } from '../../../ui/primitives'
import { Icon } from '../../../ui/Icon'
import { ConfirmDialog, type ConfirmOptions } from '../ConfirmDialog'
import { DataTable, type Column } from '../DataTable'
import { useElevation } from '../elevation'
import { ControlCard, SectionHeader, useControlData } from '../shared'
import { StatusPill } from './StatusPill'

/** Statuses an administrator can set directly, and the ones that need a reason. */
const SETTABLE: Record<CandidateStatus, string> = {
  draft: 'Move to draft',
  approved: 'Approve',
  withdrawn: 'Withdraw',
  disqualified: 'Disqualify',
}

/** Disqualifying or reinstating changes the ballot mid-poll, so it needs a reason. */
const REASON_REQUIRED: CandidateStatus[] = ['disqualified', 'withdrawn']

type Row = CandidateWithTally & { electionId: string; electionTitle: string }

export function CandidatesPanel({
  role,
  elections,
  selectedElectionId,
  onSelectElection,
  onChanged,
}: {
  role: AdminRole
  elections: ElectionSummary[]
  selectedElectionId: string | null
  onSelectElection: (id: string) => void
  onChanged: () => void
}) {
  const { run } = useElevation()
  const canManage = roleHas(role, 'candidate.manage')

  // Candidates are fetched per election, because the API serves one election's
  // ballot at a time. Only the elections that actually have options are asked
  // for, so an empty server costs no requests.
  const withOptions = useMemo(() => elections.filter((election) => election.candidate_count > 0), [elections])
  const focus = elections.find((election) => election.id === selectedElectionId) ?? elections[0] ?? null

  const { data, error, loading, reload } = useControlData<Row[]>(
    async () => {
      if (!withOptions.length) return { ok: true, value: [] as Row[] }
      const results = await Promise.all(
        withOptions.map((election) => electionApi.get(election.id)),
      )
      const rows: Row[] = []
      results.forEach((result, index) => {
        if (!result.ok) return
        const election = withOptions[index]
        for (const candidate of result.value.candidates) {
          rows.push({
            ...candidate,
            electionId: election.id,
            electionTitle: election.title,
          })
        }
      })
      return { ok: true, value: rows }
    },
    [withOptions.map((election) => election.id).join(',')],
  )

  const [editing, setEditing] = useState<Row | null>(null)
  const [creating, setCreating] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<ConfirmOptions | null>(null)
  const [pendingStatus, setPendingStatus] = useState<{ candidate: Row; status: CandidateStatus } | null>(null)
  const [pendingRemoval, setPendingRemoval] = useState<Row | null>(null)

  const rows = useMemo(() => data ?? [], [data])

  const refresh = useCallback(() => {
    reload()
    onChanged()
  }, [reload, onChanged])

  const electionOf = useCallback((row: Row) => elections.find((item) => item.id === row.electionId), [elections])

  const changeStatus = useCallback(
    async (candidate: Row, status: CandidateStatus, reason?: string) => {
      setActionError(null)
      setPendingStatus(null)
      setConfirm(null)
      const outcome = await run({ permission: 'candidate.manage' }, () =>
        electionApi.setCandidateStatus(candidate.electionId, candidate.id, status, reason),
      )
      if (outcome.status === 'failed') {
        setActionError(outcome.error)
        return
      }
      if (outcome.status === 'cancelled') return
      setNotice(`${candidate.name} is now ${status}.`)
      refresh()
    },
    [run, refresh],
  )

  const remove = useCallback(
    async (candidate: Row) => {
      setActionError(null)
      // Clear the confirmation first so no second dialog stacks on top of it.
      setConfirm(null)
      setPendingRemoval(null)
      const outcome = await run({ permission: 'candidate.manage' }, () =>
        electionApi.removeCandidate(candidate.electionId, candidate.id),
      )
      if (outcome.status === 'failed') {
        setActionError(outcome.error)
        return
      }
      if (outcome.status === 'cancelled') return
      setNotice(`Removed ${candidate.name} from the ballot.`)
      refresh()
    },
    [run, refresh],
  )

  const requestStatus = useCallback(
    (candidate: Row, status: CandidateStatus) => {
      const election = electionOf(candidate)
      if (!election) return
      setPendingStatus({ candidate, status })
      setConfirm({
        title: `${SETTABLE[status]}: ${candidate.name}?`,
        confirmLabel: SETTABLE[status],
        tone: status === 'disqualified' || status === 'withdrawn' ? 'danger' : 'default',
        body: (
          <>
            <p>
              In <strong>{election.title}</strong>, {candidate.name} will move to <strong>{status}</strong>.
            </p>
            {election.edits_allowed ? (
              <p>The ballot is not yet frozen, so this can be reversed before voting opens.</p>
            ) : (
              <p>
                Voting has already begun for this election, so the ballot is frozen. The change affects the recorded
                tally and is written to the audit trail permanently.
              </p>
            )}
            {status === 'disqualified' && <p>A disqualified option cannot receive votes.</p>}
          </>
        ),
        reason: REASON_REQUIRED.includes(status)
          ? {
              label: 'Reason',
              hint: 'Recorded in the audit trail against your account.',
              required: true,
            }
          : undefined,
        footnote: 'Recorded in the audit trail with your account, the request id and the result.',
      })
    },
    [electionOf],
  )

  const columns: Column<Row>[] = [
    {
      key: 'name',
      header: 'Option',
      width: '24%',
      render: (row) => (
        <div className="cell-stack">
          <span className="cell-primary">{row.name}</span>
          {row.organization && <span className="cell-secondary">{row.organization}</span>}
        </div>
      ),
    },
    {
      key: 'electionTitle',
      header: 'Election',
      secondary: true,
      render: (row) => {
        const election = electionOf(row)
        return (
          <div className="cell-stack">
            <span>{row.electionTitle}</span>
            {election && <span className="cell-secondary">{ELECTION_TYPE_LABELS[election.election_type]}</span>}
          </div>
        )
      },
    },
    { key: 'position', header: 'Ballot position', align: 'right', secondary: true },
    { key: 'status', header: 'Status', render: (row) => <StatusPill status={row.status} /> },
    { key: 'vote_count', header: 'Votes', align: 'right' },
    {
      key: 'editable',
      header: 'Ballot',
      secondary: true,
      sortable: false,
      value: () => '',
      render: (row) => {
        const election = electionOf(row)
        if (!election) return null
        if (election.edits_allowed) return <span className="pill pill-draft">editable</span>
        if (election.status === 'paused') return <span className="pill pill-withdrawn">status only</span>
        return <span className="pill pill-draft">frozen</span>
      },
    },
  ]

  if (!elections.length) {
    return (
      <div className="control-body">
        <SectionHeader eyebrow="Admin workspace" title="Candidate registry" description="Manage the options on each ballot." />
        <EmptyState title="No elections yet" icon="flag">
          <p>Create an election before adding candidates or ballot options.</p>
        </EmptyState>
      </div>
    )
  }

  return (
    <div className="control-body">
      <SectionHeader
        eyebrow="Admin workspace"
        title="Candidate registry"
        description="Every ballot option across every election. The ballot freezes when voting opens, so structural changes stop at that point."
        actions={
          <>
            <label className="election-picker">
              <span className="eyebrow">Add to</span>
              <select value={focus?.id ?? ''} onChange={(event) => onSelectElection(event.target.value)}>
                {elections.map((election) => (
                  <option key={election.id} value={election.id}>
                    {election.title}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="btn-primary"
              disabled={!canManage || !focus?.edits_allowed}
              title={
                !canManage
                  ? 'Your role does not permit candidate management.'
                  : focus && !focus.edits_allowed
                    ? 'This ballot is frozen. Options cannot be added once voting has begun.'
                    : 'Add a ballot option'
              }
              onClick={() => focus && setCreating(true)}
            >
              <Icon name="plus" />
              Add candidate
            </button>
          </>
        }
      />

      {notice && <Alert tone="success">{notice}</Alert>}
      {actionError && <Alert tone="error">{actionError}</Alert>}
      {error && <Alert tone="error">{error}</Alert>}

      <ControlCard
        eyebrow="Ballot options"
        title="All ballot options"
        description={
          canManage
            ? 'Status can be changed at any time; additions and removals only before voting opens, or while paused.'
            : 'Your role permits viewing candidates but not changing them.'
        }
      >
        {loading && !data ? (
          <p className="control-loading">Loading candidates…</p>
        ) : (
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(row) => `${row.electionId}:${row.id}`}
            searchPlaceholder="Search by name, party or election…"
            searchKeys={['name', 'organization', 'electionTitle']}
            pageSize={25}
            dense
            caption="Ballot options across all elections"
            emptyTitle="No candidates yet"
            emptyBody={<p>Add options to an election before publishing it, otherwise the ballot is empty.</p>}
            filters={[
              {
                key: 'status',
                label: 'Status',
                match: (row, value) => row.status === value,
                options: CANDIDATE_STATUSES.map((status) => ({ value: status, label: status })),
              },
              {
                key: 'election',
                label: 'Election',
                match: (row, value) => row.electionId === value,
                options: elections.map((election) => ({ value: election.id, label: election.title })),
              },
            ]}
            rowActions={(row) => {
              const election = electionOf(row)
              if (!canManage || !election) return <span className="cell-secondary">view only</span>
              return (
                <>
                  {election.edits_allowed && (
                    <button
                      type="button"
                      className="link-button"
                      onClick={() => setEditing(row)}
                      title="Edit name, party, description and ballot position"
                    >
                      Edit
                    </button>
                  )}
                  {CANDIDATE_STATUSES.filter((status) => status !== row.status).map((status) => (
                    <button
                      key={status}
                      type="button"
                      className={`link-button${status === 'disqualified' ? ' link-danger' : ''}`}
                      onClick={() => requestStatus(row, status)}
                    >
                      {SETTABLE[status]}
                    </button>
                  ))}
                  {election.edits_allowed && (
                    <button
                      type="button"
                      className="link-button link-danger"
                      onClick={() => {
                        setPendingRemoval(row)
                        setConfirm({
                          title: `Remove ${row.name} from the ballot?`,
                          confirmLabel: 'Remove option',
                          tone: 'danger',
                          requireTyped: 'REMOVE',
                          body: (
                            <p>
                              {row.name} will be removed from the ballot of <strong>{election.title}</strong>. This
                              election is still a draft or scheduled poll, so no voter has seen this ballot.
                            </p>
                          ),
                          footnote: 'Recorded in the audit trail with your account, the request id and the result.',
                        })
                      }}
                    >
                      Remove
                    </button>
                  )}
                </>
              )
            }}
          />
        )}
      </ControlCard>

      {(creating || editing) && focus && (
        <CandidateEditor
          election={focus}
          candidate={editing}
          onCancel={() => {
            setCreating(false)
            setEditing(null)
          }}
          onSaved={(message) => {
            setCreating(false)
            setEditing(null)
            setNotice(message)
            refresh()
          }}
        />
      )}

      {confirm && (
        <ConfirmDialog
          options={confirm}
          onCancel={() => {
            setConfirm(null)
            setPendingStatus(null)
            setPendingRemoval(null)
          }}
          onConfirm={(reason) => {
            if (pendingStatus) {
              void changeStatus(pendingStatus.candidate, pendingStatus.status, reason)
              return
            }
            if (pendingRemoval) void remove(pendingRemoval)
          }}
        />
      )}
    </div>
  )
}

/** Add or edit a ballot option. */
function CandidateEditor({
  election,
  candidate,
  onCancel,
  onSaved,
}: {
  election: ElectionSummary
  candidate: Row | null
  onCancel: () => void
  onSaved: (message: string) => void
}) {
  const [form, setForm] = useState<CandidateInput>({
    name: candidate?.name ?? '',
    organization: candidate?.organization ?? '',
    abbreviation: candidate?.abbreviation ?? '',
    description: candidate?.description ?? '',
    symbol: candidate?.symbol ?? '',
    position: candidate?.position,
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async (event: React.FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    const result = candidate
      ? await electionApi.updateCandidate(election.id, candidate.id, form as Record<string, unknown>)
      : await electionApi.addCandidate(election.id, form)
    setBusy(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    onSaved(`${result.value.candidate.name} saved.`)
  }

  return (
    <Modal
      title={candidate ? `Edit ${candidate.name}` : 'Add a ballot option'}
      onClose={onCancel}
      footer={
        <>
          <button type="button" className="btn-cancel" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" form="candidate-form" className="btn-confirm" disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <form id="candidate-form" onSubmit={save}>
        <p className="modal-desc">
          Adding to <strong>{election.title}</strong>. The ballot order is what voters see, so position matters.
        </p>
        {error && <Alert tone="error">{error}</Alert>}
        <Field label="Name" htmlFor="c-name">
          <input
            id="c-name"
            value={form.name ?? ''}
            onChange={(event) => setForm({ ...form, name: event.target.value })}
            required
            maxLength={120}
          />
        </Field>
        <div className="form-grid">
          <Field label="Party or organisation" htmlFor="c-org" hint="Optional.">
            <input
              id="c-org"
              value={form.organization ?? ''}
              onChange={(event) => setForm({ ...form, organization: event.target.value })}
              maxLength={80}
            />
          </Field>
          <Field label="Abbreviation" htmlFor="c-abbr" hint="Shown on a compact ballot.">
            <input
              id="c-abbr"
              value={form.abbreviation ?? ''}
              onChange={(event) => setForm({ ...form, abbreviation: event.target.value })}
              maxLength={12}
            />
          </Field>
        </div>
        <Field label="Description" htmlFor="c-desc" hint="Optional statement shown to voters.">
          <textarea
            id="c-desc"
            rows={3}
            value={form.description ?? ''}
            onChange={(event) => setForm({ ...form, description: event.target.value })}
            maxLength={500}
          />
        </Field>
        <div className="form-grid">
          <Field label="Ballot position" htmlFor="c-pos" hint="Lower numbers appear first. Leave blank to append.">
            <input
              id="c-pos"
              type="number"
              min={1}
              value={form.position ?? ''}
              onChange={(event) =>
                setForm({ ...form, position: event.target.value ? Number(event.target.value) : undefined })
              }
            />
          </Field>
          <Field label="Symbol" htmlFor="c-sym" hint="Optional single character or short mark.">
            <input
              id="c-sym"
              value={form.symbol ?? ''}
              onChange={(event) => setForm({ ...form, symbol: event.target.value })}
              maxLength={8}
            />
          </Field>
        </div>
      </form>
    </Modal>
  )
}
