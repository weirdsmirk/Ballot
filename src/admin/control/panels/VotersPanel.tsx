/**
 * Voter roll.
 *
 * The roll is the list of people who may vote, and it holds the most sensitive
 * data on the platform: names and contact details. It holds no secrets — a
 * verification code is issued per attempt by the server and never written here —
 * so this screen's job is to control who may see the personal data, keeping
 * contact details behind an explicit reveal rather than showing them by default,
 * and to show, per voter, whether a code could actually reach them.
 *
 * The roll is per election, which is what lets one server host several polls
 * without any of them colliding, so the screen starts by choosing one.
 */

import { useCallback, useMemo, useState } from 'react'
import { electionApi, type RollResult } from '../../../lib/api'
import { roleHas, type AdminRole } from '../../../lib/rbac'
import type { RedactedRollVoter } from '../../../lib/types'
import type { ElectionSummary } from '../../../lib/types'
import { Alert, EmptyState, Field } from '../../../ui/primitives'
import { Icon } from '../../../ui/Icon'
import { ConfirmDialog, type ConfirmOptions } from '../ConfirmDialog'
import { DataTable, type Column } from '../DataTable'
import { useElevation } from '../elevation'
import { ControlCard, Denied, SectionHeader, useControlData } from '../shared'
import { RollImport } from './RollImport'

export function VotersPanel({
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
  const election = elections.find((item) => item.id === selectedElectionId) ?? elections[0] ?? null

  // The roll is a separate, permission-gated read. It is not part of the public
  // election payload, so it can only be fetched by an account allowed to see it.
  const { data, error, loading, reload } = useControlData<RollResult | null>(
    async () => (election ? electionApi.roll(election.id) : { ok: true, value: null }),
    [election?.id],
  )

  const [selected, setSelected] = useState<number[]>([])
  const [notice, setNotice] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  /** The single-voter entry form, folded away until it is asked for. */
  const [adding, setAdding] = useState(false)
  const [confirm, setConfirm] = useState<ConfirmOptions | null>(null)
  const [pendingEligibility, setPendingEligibility] = useState<boolean | null>(null)

  const roll = useMemo(() => data?.roll ?? [], [data])
  // The server reports what it released, so the interface renders that rather
  // than deciding independently what the role is allowed to see.
  const canViewPii = data?.can_view_personal_data ?? false
  const canManage = roleHas(role, 'voter.manage') && Boolean(election?.edits_allowed)

  const refresh = useCallback(async () => {
    setSelected([])
    reload()
    onChanged()
  }, [reload, onChanged])

  const setEligibility = useCallback(
    async (eligible: boolean) => {
      if (!election || selected.length === 0) return
      setActionError(null)
      const outcome = await run({ permission: 'voter.manage' }, () =>
        electionApi.setVoterEligibility(election.id, selected, eligible),
      )
      setPendingEligibility(null)
      if (outcome.status === 'failed') {
        setActionError(outcome.error)
        return
      }
      if (outcome.status === 'cancelled') return
      setNotice(`${outcome.value.updated} voter${outcome.value.updated === 1 ? '' : 's'} marked ${eligible ? 'eligible' : 'ineligible'}.`)
      await refresh()
    },
    [election, selected, run, refresh],
  )

  const removeVoters = useCallback(async () => {
    if (!election || selected.length === 0) return
    setActionError(null)
    setConfirm(null)
    const outcome = await run({ permission: 'voter.manage' }, () =>
      electionApi.removeVoters(election.id, selected),
    )
    if (outcome.status === 'failed') {
      setActionError(outcome.error)
      return
    }
    if (outcome.status === 'cancelled') return
    setNotice(`Removed ${outcome.value.removed} voter${outcome.value.removed === 1 ? '' : 's'} from the roll.`)
    await refresh()
  }, [election, selected, run, refresh])

  const columns: Column<RedactedRollVoter>[] = useMemo(() => {
    const idLabel = election?.eligibility.identifierLabel || 'Voter ID'
    const groupLabel = election?.eligibility.groupLabel || 'Group'
    return [
      {
        key: 'voter_id',
        header: idLabel,
        width: '16%',
        render: (voter) => <span className="mono">{voter.voter_id}</span>,
      },
      {
        key: 'full_name',
        header: 'Name',
        render: (voter) =>
          canViewPii ? (
            voter.full_name
          ) : (
            <span className="cell-secondary" title="Requires the voter.view_pii permission">
              withheld
            </span>
          ),
      },
      {
        key: 'external_ref',
        header: groupLabel,
        secondary: true,
        render: (voter) => voter.external_ref || <span className="cell-secondary">—</span>,
      },
      {
        key: 'contact',
        header: canViewPii ? 'Contact details' : 'Contact',
        secondary: true,
        sortable: false,
        render: (voter) => {
          // The server has already masked anything this role may not see. All
          // that is left to do is show it, so the interface never has to decide
          // on its own what a voter is allowed to read.
          const hasContact = voter.phone || voter.email
          if (!hasContact) return <span className="cell-secondary">none on file</span>
          return (
            <div className="cell-stack">
              <span>{voter.phone || '—'}</span>
              <span className="cell-secondary">{voter.email || '—'}</span>
            </div>
          )
        },
      },
      {
        key: 'codes',
        header: 'Can verify by',
        secondary: true,
        sortable: false,
        value: (voter) => (voter.can_verify_by_phone ? '1' : '0') + (voter.can_verify_by_email ? '1' : '0'),
        render: (voter) => {
          // There is no stored code to show or miss. What an operator needs to
          // know is whether a code could be delivered to this voter at all.
          const phone = voter.can_verify_by_phone
          const email = voter.can_verify_by_email
          if (!phone && !email) return <span className="pill pill-disqualified">no contact</span>
          const needed = (election?.rules.requirePhone ?? false) || (election?.rules.requireEmail ?? false)
          const complete = phone && email
          return (
            <span className={`pill pill-${complete || !needed ? 'approved' : 'withdrawn'}`}>
              {complete ? 'phone + email' : phone ? 'phone only' : 'email only'}
            </span>
          )
        },
      },
      {
        key: 'is_eligible',
        header: 'Eligible',
        render: (voter) => (
          <span className={`pill pill-${voter.is_eligible ? 'approved' : 'withdrawn'}`}>
            {voter.is_eligible ? 'Eligible' : 'Excluded'}
          </span>
        ),
      },
      {
        key: 'has_voted',
        header: 'Participated',
        render: (voter) => (
          <span className={`pill pill-${voter.has_voted ? 'approved' : 'draft'}`}>
            {voter.has_voted ? 'Voted' : 'Not yet'}
          </span>
        ),
      },
    ]
  }, [election, canViewPii])

  const voted = roll.filter((voter) => voter.has_voted === 1).length
  const eligible = roll.filter((voter) => voter.is_eligible === 1).length

  if (!elections.length) {
    return (
      <div className="control-body">
        <SectionHeader eyebrow="Admin workspace" title="Voter registry" description="Manage who may vote in each election." />
        <EmptyState title="No elections to attach a roll to" icon="users">
          <p>Create an election first. Each election has its own voter roll.</p>
        </EmptyState>
      </div>
    )
  }

  if (!election) return null

  return (
    <div className="control-body">
      <SectionHeader
        eyebrow="Admin workspace"
        title="Voter registry"
        description={`${eligible.toLocaleString()} verified voters for ${election.title}`}
        actions={
          <>
            <ElectionPicker elections={elections} value={election.id} onChange={onSelectElection} />
            {canManage && (
              <button type="button" className="btn-primary" onClick={() => setImporting(true)}>
                <Icon name="upload" />
                Import voters
              </button>
            )}
          </>
        }
      />

      {!canViewPii && (
        <Denied what="voter names, contact details or grouping" />
      )}

      {notice && <Alert tone="success">{notice}</Alert>}
      {actionError && <Alert tone="error">{actionError}</Alert>}
      {error && <Alert tone="error">{error}</Alert>}

      <ControlCard
        eyebrow="Roll"
        title={`Roll for ${election.title}`}
        description={`${roll.length} on the roll · ${eligible} eligible · ${voted} have voted. Verification codes are never stored here: the server issues a fresh one per attempt, so this roll cannot be used to impersonate anybody. This screen reports participation — who voted, not what they chose.`}
        actions={
          <>
            {canManage && election.edits_allowed && (
              <button type="button" className="btn-outline" onClick={() => setAdding((value) => !value)}>
                <Icon name="plus" />
                Add voter
              </button>
            )}
            {canManage && (
              <button type="button" className="btn-outline" onClick={() => setImporting(true)}>
                <Icon name="upload" />
                Bulk import
              </button>
            )}
          </>
        }
        tone={election.edits_allowed ? 'default' : 'warn'}
      >
        {!election.edits_allowed && (
          <Alert tone="warn">
            This roll is frozen. The election is {election.effective_status.replace('_', ' ')}, and the voter roll can
            only change before voting opens. Eligibility already recorded stays as it is.
          </Alert>
        )}

        {selected.length > 0 && canManage && (
          <div className="bulk-bar">
            <span>
              {selected.length} selected
            </span>
            {pendingEligibility === null ? (
              <>
                <button
                  type="button"
                  className="link-button"
                  onClick={() => {
                    setPendingEligibility(true)
                    setConfirm({
                      title: 'Mark voters eligible?',
                      confirmLabel: 'Mark eligible',
                      body: (
                        <p>
                          {selected.length} voter{selected.length === 1 ? '' : 's'} will be able to authenticate and vote
                          in <strong>{election.title}</strong>.
                        </p>
                      ),
                      footnote: 'Recorded in the audit trail with your account and the request id.',
                    })
                  }}
                >
                  Mark eligible
                </button>
                <button
                  type="button"
                  className="link-button"
                  onClick={() => {
                    setPendingEligibility(false)
                    setConfirm({
                      title: 'Exclude voters from this election?',
                      confirmLabel: 'Mark ineligible',
                      tone: 'danger',
                      body: (
                        <p>
                          {selected.length} voter{selected.length === 1 ? '' : 's'} will be refused if they try to vote
                          in <strong>{election.title}</strong>. Any ballot already cast is not affected.
                        </p>
                      ),
                      footnote: 'Recorded in the audit trail with your account and the request id.',
                    })
                  }}
                >
                  Mark ineligible
                </button>
              </>
            ) : (
              <span className="cell-secondary">Confirm the change…</span>
            )}
            <button
              type="button"
              className="link-button link-danger"
              onClick={() =>
                setConfirm({
                  title: 'Remove voters from the roll?',
                  confirmLabel: 'Remove from roll',
                  tone: 'danger',
                  requireTyped: 'REMOVE',
                  body: (
                    <p>
                      {selected.length} voter{selected.length === 1 ? '' : 's'} will be deleted from the roll of{' '}
                      <strong>{election.title}</strong>. Any ballot they already cast is kept and still counted, but the
                      link between the ballot and the voter is removed.
                    </p>
                  ),
                  footnote: 'Recorded in the audit trail with your account and the request id.',
                })
              }
            >
              Remove from roll
            </button>
            <button type="button" className="link-button" onClick={() => setSelected([])}>
              Clear selection
            </button>
          </div>
        )}

        {loading && !data ? (
          <p className="control-loading">Loading the roll…</p>
        ) : (
          <DataTable
            columns={columns}
            rows={roll}
            rowKey={(row) => row.id}
            searchPlaceholder={`Search by ${(election.eligibility.identifierLabel || 'voter ID').toLowerCase()} or name…`}
            searchKeys={['voter_id', 'full_name', 'external_ref']}            pageSize={25}
            dense
            selectable={canManage}
            selected={selected}
            onSelectedChange={setSelected}
            caption={`Voter roll for ${election.title}`}
            emptyTitle="The roll is empty"
            emptyBody={<p>Add voters individually or import a list before publishing, otherwise nobody can authenticate.</p>}
            filters={[
              {
                key: 'eligibility',
                label: 'Eligibility',
                match: (row, value) => (value === 'eligible' ? row.is_eligible === 1 : row.is_eligible === 0),
                options: [
                  { value: 'eligible', label: 'Eligible' },
                  { value: 'ineligible', label: 'Excluded' },
                ],
              },
              {
                key: 'voted',
                label: 'Ballot',
                match: (row, value) => (value === 'voted' ? row.has_voted === 1 : row.has_voted === 0),
                options: [
                  { value: 'voted', label: 'Has voted' },
                  { value: 'pending', label: 'Not yet' },
                ],
              },
              {
                key: 'verification',
                label: 'Verifiable',
                match: (row, value) =>
                  value === 'complete'
                    ? row.can_verify_by_phone && row.can_verify_by_email
                    : !row.can_verify_by_phone || !row.can_verify_by_email,
                options: [
                  { value: 'complete', label: 'Phone and email' },
                  { value: 'incomplete', label: 'Missing a channel' },
                ],
              },
            ]}
          />
        )}
      </ControlCard>

      {adding && election && canManage && (
        <AddVoterForm
          election={election}
          onCancel={() => setAdding(false)}
          onAdded={() => {
            setAdding(false)
            void refresh()
          }}
        />
      )}

      {importing && election && (
        <RollImport
          election={election}
          onCancel={() => setImporting(false)}
          onImported={(added, skipped) => {
            setImporting(false)
            setNotice(
              `Added ${added} voter${added === 1 ? '' : 's'}.` +
                (skipped.length ? ` Skipped existing: ${skipped.join(', ')}.` : ''),
            )
            void refresh()
          }}
        />
      )}

      {confirm && (
        <ConfirmDialog
          options={confirm}
          onCancel={() => {
            setConfirm(null)
            setPendingEligibility(null)
          }}
          onConfirm={() => {
            if (pendingEligibility !== null) {
              const eligibleNext = pendingEligibility
              setPendingEligibility(null)
              setConfirm(null)
              void setEligibility(eligibleNext)
              return
            }
            void removeVoters()
          }}
        />
      )}
    </div>
  )
}

/**
 * Add a single voter.
 *
 * The bulk paste is the realistic route for building a roll, but a roll also
 * grows one at a time — a late enrolment, a correction. This is that case, and it
 * calls the same command with a one-row batch so there is only one code path that
 * can write to a roll.
 */
function AddVoterForm({
  election,
  onCancel,
  onAdded,
}: {
  election: ElectionSummary
  onCancel: () => void
  onAdded: () => void
}) {
  const { run } = useElevation()
  const [voterId, setVoterId] = useState('')
  const [fullName, setFullName] = useState('')
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')
  const [externalRef, setExternalRef] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    const outcome = await run({ permission: 'voter.import' }, () =>
      electionApi.addVoters(election.id, [
        { voter_id: voterId.trim(), full_name: fullName.trim(), phone: phone.trim(), email: email.trim(), external_ref: externalRef.trim() },
      ]),
    )
    setBusy(false)
    if (outcome.status === 'failed') {
      setError(outcome.error)
      return
    }
    if (outcome.status === 'cancelled') return
    onAdded()
  }

  return (
    <ControlCard eyebrow="Roll" title="Add one voter" description={`Added to ${election.title}.`}>
      <form onSubmit={submit}>
        {error && <Alert tone="error">{error}</Alert>}
        <div className="form-grid">
          <Field label={election.eligibility.identifierLabel || 'Voter ID'} htmlFor="add-voter-id">
            <input id="add-voter-id" value={voterId} onChange={(event) => setVoterId(event.target.value)} required maxLength={80} />
          </Field>
          <Field label="Full name" htmlFor="add-voter-name">
            <input id="add-voter-name" value={fullName} onChange={(event) => setFullName(event.target.value)} required maxLength={160} />
          </Field>
        </div>
        <div className="form-grid">
          <Field label="Phone" htmlFor="add-voter-phone" hint="Needed if this election verifies by code.">
            <input id="add-voter-phone" value={phone} onChange={(event) => setPhone(event.target.value)} maxLength={40} />
          </Field>
          <Field label="Email" htmlFor="add-voter-email" hint="Needed if this election verifies by code.">
            <input id="add-voter-email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} maxLength={200} />
          </Field>
        </div>
        <Field label={election.eligibility.groupLabel || 'Group'} htmlFor="add-voter-group" hint="Optional. Department, society or batch.">
          <input id="add-voter-group" value={externalRef} onChange={(event) => setExternalRef(event.target.value)} maxLength={120} />
        </Field>
        <div className="admin-form-actions">
          <button type="button" className="btn-cancel" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={busy}>
            {busy ? 'Adding…' : 'Add voter'}
          </button>
        </div>
      </form>
    </ControlCard>
  )
}

function ElectionPicker({
  elections,
  value,
  onChange,
}: {
  elections: ElectionSummary[]
  value: string
  onChange: (id: string) => void
}) {
  return (
    <label className="election-picker">
      <span className="preview-meta-label">Election</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {elections.map((election) => (
          <option key={election.id} value={election.id}>
            {election.title} — {election.effective_status.replace('_', ' ')}
          </option>
        ))}
      </select>
    </label>
  )
}
