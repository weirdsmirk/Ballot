/**
 * Bulk voter import.
 *
 * The realistic way to build a roll is to paste a list an organisation already
 * has, so the import is a paste rather than a file upload: no upload endpoint, no
 * temporary copies of personal data, and the operator can see exactly what will
 * be sent before sending it.
 *
 * Parsing happens in the browser purely to report problems at the line they
 * occur. The server parses and validates the same batch again, so a hand-crafted
 * request cannot bypass the checks.
 */

import { useState } from 'react'
import { electionApi, type RollVoterInput } from '../../../lib/api'
import type { ElectionSummary } from '../../../lib/types'
import { Alert, Field, Modal } from '../../../ui/primitives'
import { useElevation } from '../elevation'

const TEMPLATE = `voter_id, full_name, phone, email, external_ref
STU-2026-0100, Sample Student, 9876500000, sample.student@example.com, Computer Science`

type ParseResult = { voters: RollVoterInput[]; problems: string[] }

/**
 * Split a pasted list into roll records.
 *
 * Reports every bad line rather than stopping at the first, so one typo does not
 * hide the rest of the problems in a large file.
 */
function parseCsv(text: string): ParseResult {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)

  const problems: string[] = []
  if (lines.length === 0) return { voters: [], problems: ['Nothing to import.'] }

  const hasHeader = lines[0].toLowerCase().includes('voter_id')
  const rows = hasHeader ? lines.slice(1) : lines
  if (rows.length === 0) return { voters: [], problems: ['The header row is present but there are no voter rows.'] }

  const voters: RollVoterInput[] = []
  const seen = new Set<string>()

  rows.forEach((line, index) => {
    const lineNumber = index + (hasHeader ? 2 : 1)
    const cells = line.split(',').map((cell) => cell.trim())
    if (cells.length < 2) {
      problems.push(`Line ${lineNumber}: expected at least an identifier and a name.`)
      return
    }
    const voterId = cells[0]
    if (!voterId) {
      problems.push(`Line ${lineNumber}: the identifier is empty.`)
      return
    }
    if (seen.has(voterId.toLowerCase())) {
      problems.push(`Line ${lineNumber}: ${voterId} appears twice in this paste.`)
      return
    }
    seen.add(voterId.toLowerCase())
    voters.push({
      voter_id: voterId,
      full_name: cells[1],
      phone: cells[2] ?? '',
      email: cells[3] ?? '',
      // Trailing columns from an older list are ignored rather than rejected, so
      // an export made before passcodes were removed still imports cleanly.
      external_ref: cells[4] ?? '',
    })
  })

  return { voters, problems }
}

export function RollImport({
  election,
  onCancel,
  onImported,
}: {
  election: ElectionSummary
  onCancel: () => void
  onImported: (added: number, skipped: string[]) => void
}) {
  const { run } = useElevation()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const parsed = text.trim() ? parseCsv(text) : { voters: [], problems: [] }
  const ready = parsed.voters.length > 0 && parsed.problems.length === 0

  const submit = async () => {
    if (!ready) return
    setBusy(true)
    setError(null)
    const outcome = await run({ permission: 'voter.import' }, () =>
      electionApi.addVoters(election.id, parsed.voters),
    )
    setBusy(false)
    if (outcome.status === 'failed') {
      setError(outcome.error)
      return
    }
    if (outcome.status === 'cancelled') return
    onImported(outcome.value.added, outcome.value.skipped)
  }

  return (
    <Modal
      title="Bulk import voters"
      onClose={onCancel}
      wide
      footer={
        <>
          <button type="button" className="btn-cancel" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="btn-confirm" disabled={!ready || busy} onClick={() => void submit()}>
            {busy ? 'Importing…' : `Import ${parsed.voters.length || ''} voter${parsed.voters.length === 1 ? '' : 's'}`.trim()}
          </button>
        </>
      }
    >
      <p className="modal-desc">
        One voter per line, comma separated. A header row is optional. The list is parsed here to show problems at the
        line they occur, and validated again on the server before anything is written.
      </p>
      <pre className="code-block">{TEMPLATE}</pre>

      <Field
        label="CSV"
        htmlFor="roll-csv"
        hint={`Voters without a ${election.eligibility.identifierLabel || 'voter ID'} or name are skipped. Up to 500 rows per import.`}
      >
        <textarea
          id="roll-csv"
          rows={10}
          className="mono"
          value={text}
          spellCheck={false}
          onChange={(event) => setText(event.target.value)}
        />
      </Field>

      {election.rules.requireOtp && (
        <Alert tone="warn">
          This election requires a one-time code, so each voter needs a phone number and an email address on file. A
          voter missing a required channel will be unable to receive a code and so cannot verify. The codes themselves
          are generated per attempt by the server and are never stored.
        </Alert>
      )}

      {parsed.problems.length > 0 && (
        <Alert tone="error">
          <p>
            <strong>
              {parsed.problems.length} problem{parsed.problems.length === 1 ? '' : 's'} found
            </strong>
          </p>
          <ul>
            {parsed.problems.slice(0, 8).map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
            {parsed.problems.length > 8 && <li>&hellip;and {parsed.problems.length - 8} more.</li>}
          </ul>
        </Alert>
      )}

      {error && <Alert tone="error">{error}</Alert>}

      {ready && (
        <Alert tone="success">
          {parsed.voters.length} voter{parsed.voters.length === 1 ? '' : 's'} ready to import into{' '}
          <strong>{election.title}</strong>. Existing identifiers are skipped rather than overwritten.
        </Alert>
      )}
    </Modal>
  )
}
