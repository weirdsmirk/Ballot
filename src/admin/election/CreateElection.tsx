/**
 * Administrative election creation.
 *
 * Captures the fields that define an election: identity, type, schedule in a
 * chosen timezone, and the opening rule set. Everything else (candidates,
 * eligibility, ballot order) is configured afterwards in the workspace.
 */

import { useState } from 'react'
import { electionApi } from '../../lib/api'
import { commonTimeZones, formatInZone, isValidTimeZone, localTimeZone, utcToWallTime, wallTimeToUtc } from '../../lib/time'
import { ELECTION_TYPES, ELECTION_TYPE_LABELS, type ElectionSummary, type ElectionType } from '../../lib/types'
import { defaultEligibility, defaultRules } from '../../lib/validate'
import { Alert, Eyebrow, Field } from '../../ui/primitives'

function defaultStart(): string {
  const now = new Date()
  now.setDate(now.getDate() + 1)
  now.setMinutes(0, 0, 0)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:00`
}

function defaultEnd(): string {
  const now = new Date()
  now.setDate(now.getDate() + 2)
  now.setMinutes(0, 0, 0)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:00`
}

export function CreateElection({ onCreated, onCancel }: { onCreated: (election: ElectionSummary) => void; onCancel: () => void }) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [electionType, setElectionType] = useState<ElectionType>('university')
  const [timezone, setTimezone] = useState(() => localTimeZone())
  const [startsAt, setStartsAt] = useState(defaultStart)
  const [endsAt, setEndsAt] = useState(defaultEnd)
  const [votesPerVoter, setVotesPerVoter] = useState(1)
  const [allowNotA, setAllowNotA] = useState(true)
  const [requireOtp, setRequireOtp] = useState(true)
  const [resultsVisibility, setResultsVisibility] = useState(defaultRules().resultsVisibility)
  const [identifierLabel, setIdentifierLabel] = useState(defaultEligibility().identifierLabel)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const startInstant = wallTimeToUtc(startsAt, timezone)
  const endInstant = wallTimeToUtc(endsAt, timezone)
  const zoneValid = isValidTimeZone(timezone)
  const orderingValid = Boolean(startInstant && endInstant && Date.parse(endInstant) > Date.parse(startInstant))

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setError(null)
    if (!zoneValid) {
      setError('Choose a valid IANA timezone.')
      return
    }
    if (!startInstant || !endInstant) {
      setError('Enter valid start and end times.')
      return
    }
    if (Date.parse(endInstant) <= Date.parse(startInstant)) {
      setError('The end time must be after the start time.')
      return
    }
    setBusy(true)
    const result = await electionApi.create({
      title,
      description,
      election_type: electionType,
      timezone,
      starts_at: startInstant,
      ends_at: endInstant,
      rules: { ...defaultRules(), votesPerVoter, allowNotA, requireOtp, resultsVisibility },
      eligibility: { ...defaultEligibility(), identifierLabel },
    })
    setBusy(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    onCreated(result.value.election)
  }

  return (
    <form className="admin-form" onSubmit={submit}>
      <div className="admin-form-head">
        <Eyebrow>New election</Eyebrow>
        <h2 style={{ marginTop: 9 }}>Create an election</h2>
        <p>
          A new election always starts as a <strong>draft</strong>. Nothing is visible to voters and no votes are accepted
          until you publish it, open it, and the scheduled window is reached.
        </p>
      </div>

      {error && <Alert tone="error">{error}</Alert>}

      <div className="form-grid">
        <Field label="Title" htmlFor="e-title" hint="Shown to voters on the ballot and results pages.">
          <input id="e-title" value={title} onChange={(event) => setTitle(event.target.value)} required maxLength={160} />
        </Field>
        <Field label="Election type" htmlFor="e-type" hint="Controls labelling only; the platform is not specialised per type.">
          <select id="e-type" value={electionType} onChange={(event) => setElectionType(event.target.value as ElectionType)}>
            {ELECTION_TYPES.map((type) => (
              <option key={type} value={type}>
                {ELECTION_TYPE_LABELS[type]}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <Field label="Description" htmlFor="e-desc" hint="Explain what is being voted on and who is eligible.">
        <textarea id="e-desc" value={description} onChange={(event) => setDescription(event.target.value)} rows={3} maxLength={2000} />
      </Field>

      <div className="form-grid">
        <Field label="Timezone" htmlFor="e-tz" hint="All times below are entered in this zone. Stored as UTC.">
          <select id="e-tz" value={timezone} onChange={(event) => setTimezone(event.target.value)}>
            {!commonTimeZones().includes(timezone) && <option value={timezone}>{timezone}</option>}
            {commonTimeZones().map((zone) => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Identifier label" htmlFor="e-idlabel" hint="What voters are asked for, e.g. Student ID or Roll Number.">
          <input id="e-idlabel" value={identifierLabel} onChange={(event) => setIdentifierLabel(event.target.value)} maxLength={60} />
        </Field>
      </div>

      <div className="form-grid">
        <Field label="Voting opens (local)" htmlFor="e-start">
          <input
            id="e-start"
            type="datetime-local"
            value={startsAt}
            onChange={(event) => {
              const next = event.target.value
              setStartsAt(next)
              const instant = wallTimeToUtc(next, timezone)
              if (instant) setEndsAt(utcToWallTime(new Date(Date.parse(instant) + 86_400_000).toISOString(), timezone))
            }}
            required
          />
        </Field>
        <Field label="Voting closes (local)" htmlFor="e-end" error={!orderingValid ? 'The end time must be after the start time.' : null}>
          <input id="e-end" type="datetime-local" value={endsAt} onChange={(event) => setEndsAt(event.target.value)} required />
        </Field>
      </div>

      {startInstant && endInstant && orderingValid && (
        <p className="form-preview">
          Stored window: <strong>{formatInZone(startInstant, 'UTC')}</strong> &rarr; <strong>{formatInZone(endInstant, 'UTC')}</strong>{' '}
          (UTC). Voters in any timezone see the same absolute moment.
        </p>
      )}

      <fieldset className="fieldset">
        <legend>Opening rules</legend>
        <div className="form-grid">
          <Field label="Selections per voter" htmlFor="e-vpv">
            <input
              id="e-vpv"
              type="number"
              min={1}
              max={20}
              value={votesPerVoter}
              onChange={(event) => setVotesPerVoter(Number(event.target.value))}
            />
          </Field>
          <Field label="Results visibility" htmlFor="e-res">
            <select
              id="e-res"
              value={resultsVisibility}
              onChange={(event) => setResultsVisibility(event.target.value as typeof resultsVisibility)}
            >
              <option value="live">Live, while voting is open</option>
              <option value="after_close">After voting closes</option>
              <option value="after_certify">After results are certified</option>
              <option value="never">Never published</option>
            </select>
          </Field>
        </div>
        <label className="checkbox">
          <input type="checkbox" checked={allowNotA} onChange={(event) => setAllowNotA(event.target.checked)} />
          Offer a &ldquo;None of the Above&rdquo; option
        </label>
        <label className="checkbox">
          <input type="checkbox" checked={requireOtp} onChange={(event) => setRequireOtp(event.target.checked)} />
          Require one-time codes for identity verification
        </label>
      </fieldset>

      <div className="admin-form-actions">
        <button type="button" className="btn-cancel" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn-primary" disabled={busy || !orderingValid}>
          {busy ? 'Creating…' : 'Create draft'}
        </button>
      </div>
    </form>
  )
}
