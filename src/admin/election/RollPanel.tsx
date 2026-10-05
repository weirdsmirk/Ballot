/**
 * Voter roll management.
 *
 * The roll is per election, which is what lets one server host a university
 * election, a club election and a departmental election without any of them
 * colliding. Bulk paste accepts the same field names the API uses.
 */

import { useState } from 'react'
import { electionApi, type RollVoterInput } from '../../lib/api'
import type { ElectionSummary, RedactedRollVoter } from '../../lib/types'
import { Alert, EmptyState, Field, Modal } from '../../ui/primitives'

const TEMPLATE = `voter_id, full_name, phone, email, external_ref
STU-2026-0100, Sample Student, 9876500000, sample.student@example.com, Computer Science`

function parseCsv(text: string): RollVoterInput[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  if (lines.length === 0) throw new Error('Nothing to import.')

  const header = lines[0].toLowerCase().includes('voter_id')
  const rows = header ? lines.slice(1) : lines
  if (rows.length === 0) throw new Error('The header row is present but there are no voter rows.')

  return rows.map((line, index) => {
    const cells = line.split(',').map((cell) => cell.trim())
    if (cells.length < 2) throw new Error(`Line ${index + 1}: expected at least an identifier and a name.`)
    return {
      voter_id: cells[0],
      full_name: cells[1],
      phone: cells[2] ?? '',
      email: cells[3] ?? '',
      // Any trailing columns from an older list — which used to carry passcodes —
      // are ignored rather than rejected, so an existing export still imports.
      external_ref: cells[4] ?? '',
    }
  })
}

export function RollPanel({
  election,
  roll,
  onChanged,
}: {
  election: ElectionSummary
  roll: RedactedRollVoter[]
  onChanged: () => Promise<void> | void
}) {
  const [importing, setImporting] = useState(false)
  const [bulk, setBulk] = useState('')
  const [single, setSingle] = useState<Partial<RollVoterInput>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [selected, setSelected] = useState<number[]>([])

  const canEdit = election.edits_allowed
  const voted = roll.filter((voter) => voter.has_voted === 1).length

  const importBulk = async () => {
    setBusy(true)
    setError(null)
    try {
      const voters = parseCsv(bulk)
      const result = await electionApi.addVoters(election.id, voters)
      if (!result.ok) {
        setError(result.error)
      } else {
        setNotice(
          `Added ${result.value.added} voter${result.value.added === 1 ? '' : 's'}.` +
            (result.value.skipped.length ? ` Skipped existing: ${result.value.skipped.join(', ')}.` : ''),
        )
        setBulk('')
        setImporting(false)
        await onChanged()
      }
    } catch (parseError) {
      setError((parseError as Error).message)
    }
    setBusy(false)
  }

  const addSingle = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!single.voter_id || !single.full_name) return
    setBusy(true)
    setError(null)
    const result = await electionApi.addVoters(election.id, [single as RollVoterInput])
    setBusy(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    setNotice('Voter added.')
    setSingle({})
    await onChanged()
  }

  const toggleEligibility = async (voters: number[], eligible: boolean) => {
    setBusy(true)
    setError(null)
    const result = await electionApi.setVoterEligibility(election.id, voters, eligible)
    setBusy(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    setSelected([])
    await onChanged()
  }

  return (
    <div className="panel">
      <div className="panel-head">
        <div>
          <h3>Voter roll</h3>
          <p>
            {election.eligible_count} eligible &middot; {roll.length} total &middot; {voted} have voted
          </p>
        </div>
        {canEdit && (
          <div className="row-actions">
            <button type="button" className="btn-outline" onClick={() => setImporting(true)}>
              Bulk import
            </button>
          </div>
        )}
      </div>

      {error && <Alert tone="error">{error}</Alert>}
      {notice && <Alert tone="success">{notice}</Alert>}
      {!canEdit && (
        <Alert tone="warn">
          The roll is frozen because this election is {election.effective_status.replace('_', ' ')}. Editing the roll is
          only possible before voting opens.
        </Alert>
      )}

      {canEdit && (
        <form className="inline-form" onSubmit={addSingle}>
          <Field label={election.eligibility.identifierLabel || 'Voter ID'} htmlFor="r-id">
            <input id="r-id" value={single.voter_id ?? ''} onChange={(event) => setSingle({ ...single, voter_id: event.target.value.toUpperCase() })} required />
          </Field>
          <Field label="Full name" htmlFor="r-name">
            <input id="r-name" value={single.full_name ?? ''} onChange={(event) => setSingle({ ...single, full_name: event.target.value })} required />
          </Field>
          <Field label="Phone" htmlFor="r-phone">
            <input id="r-phone" value={single.phone ?? ''} onChange={(event) => setSingle({ ...single, phone: event.target.value })} />
          </Field>
          <Field label="Email" htmlFor="r-email">
            <input id="r-email" value={single.email ?? ''} onChange={(event) => setSingle({ ...single, email: event.target.value })} />
          </Field>
          {/*
            No passcode fields. Verification codes are generated by the server for
            each attempt and never stored, so there is nothing for an operator to
            enter here — and nothing on this form that could be a stored secret.
          */}
          <Field label={election.eligibility.groupLabel || 'Group'} htmlFor="r-group">
            <input id="r-group" value={single.external_ref ?? ''} onChange={(event) => setSingle({ ...single, external_ref: event.target.value })} />
          </Field>
          <button type="submit" className="btn-primary" disabled={busy}>
            Add voter
          </button>
        </form>
      )}

      {roll.length === 0 ? (
        <EmptyState title="The roll is empty">
          <p>Add voters before publishing, otherwise nobody will be able to authenticate.</p>
        </EmptyState>
      ) : (
        <>
          {canEdit && selected.length > 0 && (
            <div className="bulk-bar">
              <span>{selected.length} selected</span>
              <button type="button" className="link-button" disabled={busy} onClick={() => void toggleEligibility(selected, true)}>
                Mark eligible
              </button>
              <button type="button" className="link-button" disabled={busy} onClick={() => void toggleEligibility(selected, false)}>
                Mark ineligible
              </button>
              <button type="button" className="link-button" onClick={() => setSelected([])}>
                Clear
              </button>
            </div>
          )}
          <table className="data-table">
            <thead>
              <tr>
                {canEdit && <th className="col-check" />}
                <th>{election.eligibility.identifierLabel || 'Voter ID'}</th>
                <th>Name</th>
                <th>{election.eligibility.groupLabel || 'Group'}</th>
                <th>Contact</th>
                <th>Eligible</th>
                <th>Voted</th>
              </tr>
            </thead>
            <tbody>
              {roll.map((voter) => (
                <tr key={voter.id}>
                  {canEdit && (
                    <td className="col-check">
                      <input
                        type="checkbox"
                        checked={selected.includes(voter.id)}
                        onChange={(event) =>
                          setSelected((current) =>
                            event.target.checked ? [...current, voter.id] : current.filter((id) => id !== voter.id),
                          )
                        }
                        aria-label={`Select ${voter.voter_id}`}
                      />
                    </td>
                  )}
                  <td className="data">{voter.voter_id}</td>
                  <td>
                    {voter.full_name || (
                      <span className="cell-secondary" title="Requires the voter.view_pii permission">
                        withheld
                      </span>
                    )}
                  </td>
                  <td>{voter.external_ref || '—'}</td>
                  <td className="cell-secondary">
                    {/*
                      The server decides what this role may see and withholds the
                      rest, so an empty field means "not released", not "not on
                      file". Saying so avoids an operator concluding a voter has no
                      contact details when they are simply hidden from them.
                    */}
                    {voter.phone || voter.email ? (
                      <>
                        {voter.phone || '—'}
                        <br />
                        {voter.email || '—'}
                      </>
                    ) : (
                      <span title="Withheld: requires the voter.view_pii permission">on file · withheld</span>
                    )}
                  </td>
                  <td>
                    <span className={`pill pill-${voter.is_eligible ? 'approved' : 'withdrawn'}`}>
                      {voter.is_eligible ? 'Eligible' : 'Excluded'}
                    </span>
                  </td>
                  <td>
                    <span className={`pill pill-${voter.has_voted ? 'approved' : 'draft'}`}>
                      {voter.has_voted ? 'Voted' : 'Not yet'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {importing && (
        <Modal
          title="Bulk import voters"
          onClose={() => setImporting(false)}
          wide
          footer={
            <>
              <button type="button" className="btn-cancel" onClick={() => setImporting(false)}>
                Cancel
              </button>
              <button type="button" className="btn-confirm" disabled={busy} onClick={() => void importBulk()}>
                {busy ? 'Importing…' : 'Import'}
              </button>
            </>
          }
        >
          {error && <Alert tone="error">{error}</Alert>}
          <p className="modal-desc">
            One voter per line, comma separated. A header row is optional. Passcodes are only needed when this election
            requires one-time code verification.
          </p>
          <pre className="code-block">{TEMPLATE}</pre>
          <Field label="CSV" htmlFor="r-csv">
            <textarea id="r-csv" rows={10} value={bulk} onChange={(event) => setBulk(event.target.value)} className="data" />
          </Field>
        </Modal>
      )}
    </div>
  )
}
