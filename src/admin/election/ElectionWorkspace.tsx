/**
 * The election workspace.
 *
 * This is the administrative workflow: configure the election, review the
 * ballot, then drive it through its lifecycle. The lifecycle action bar only
 * offers transitions the server permits, and explains why the others are
 * unavailable, so the UI cannot drift from the enforced state machine.
 */

import { useCallback, useEffect, useState } from 'react'
import { electionApi, type ElectionDetail } from '../../lib/api'
import { LIFECYCLE_ACTION_LABELS, STATUS_DESCRIPTIONS, STATUS_LABELS } from '../../lib/lifecycle'
import { elevationFor, permissionForLifecycleAction, type Permission } from '../../lib/rbac'
import { formatInZone, utcToWallTime, wallTimeToUtc } from '../../lib/time'
import { ELECTION_TYPES, ELECTION_TYPE_LABELS, RESULTS_VISIBILITIES, type ElectionSummary, type ElectionType, type LifecycleAction } from '../../lib/types'
import { defaultEligibility, defaultRules } from '../../lib/validate'
import { Alert, Countdown, Eyebrow, Field, Spinner, StatusBadge } from '../../ui/primitives'
import { Icon, type IconName } from '../../ui/Icon'
import { ConfirmDialog, type ConfirmOptions } from '../control/ConfirmDialog'
import { useElevation } from '../control/elevation'
import { CandidatesPanel } from './CandidatesPanel'
import { RollPanel } from './RollPanel'
import { BallotPreviewPanel } from './BallotPreviewPanel'
import { AuditTrail } from './AuditTrail'
import { ElectionStats } from './ElectionStats'
import { ResultsPanel } from '../../voter/ResultsPanel'

type Tab = 'overview' | 'rules' | 'candidates' | 'roll' | 'preview' | 'results' | 'audit'

const TABS: { id: Tab; label: string; icon: IconName }[] = [
  { id: 'overview', label: 'Overview', icon: 'gauge' },
  { id: 'rules', label: 'Rules & eligibility', icon: 'settings' },
  { id: 'candidates', label: 'Ballot options', icon: 'users' },
  { id: 'roll', label: 'Voter roll', icon: 'user' },
  { id: 'preview', label: 'Ballot preview', icon: 'ballot' },
  { id: 'results', label: 'Results', icon: 'trend' },
  { id: 'audit', label: 'Audit trail', icon: 'audit' },
]

/** Tabs reachable from the header's overflow menu — the same set, minus the
    preview the header already offers as a named button. */
const WORKSPACE_TABS = TABS

/** The status tint used on the flag tile above the title. */
const TILE_FOR_STATUS: Record<string, string> = {
  draft: 'slate',
  scheduled: 'blue',
  open: 'green',
  paused: 'amber',
  closed: 'slate',
  certified: 'green',
  archived: 'slate',
}

export function ElectionWorkspace({
  electionId,
  serverOffsetMs,
  onChanged,
  onBack,
}: {
  electionId: string
  serverOffsetMs: number
  onChanged: () => void
  onBack: () => void
}) {
  const [detail, setDetail] = useState<ElectionDetail | null>(null)
  const [tab, setTab] = useState<Tab>('overview')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  const [confirm, setConfirm] = useState<ConfirmOptions | null>(null)
  const [awaiting, setAwaiting] = useState<LifecycleAction | null>(null)
  const { run } = useElevation()

  // Two reads, because they have different sensitivity. The election payload is
  // public and the voter roll is not, so the roll is fetched from its own
  // permission-gated command and merged in here for the workspace's benefit.
  const load = useCallback(async () => {
    const [detail, roll] = await Promise.all([
      electionApi.get(electionId),
      electionApi.roll(electionId),
    ])
    if (!detail.ok) {
      setError(detail.error)
      setDetail(null)
      return
    }
    if (!roll.ok) {
      setError(roll.error)
      setDetail(null)
      return
    }
    setDetail({ ...detail.value, roll: roll.value.roll })
    setError(null)
  }, [electionId])

  useEffect(() => {
    void load()
  }, [load, refreshKey])

  // The lifecycle depends on the clock, so refresh while a poll is running.
  useEffect(() => {
    if (!detail) return
    const live = ['open', 'scheduled', 'paused'].includes(detail.election.effective_status)
    if (!live) return
    const interval = setInterval(() => setRefreshKey((value) => value + 1), 15_000)
    return () => clearInterval(interval)
  }, [detail])

  const election = detail?.election ?? null

  /**
   * Run a lifecycle transition.
   *
   * The server decides whether the action needs a password, a second factor or
   * a second approver, and refuses it until that is satisfied; this only carries
   * the result back to the screen.
   */
  const runTransition = useCallback(
    async (action: LifecycleAction, note?: string) => {
      const permission = permissionForLifecycleAction(action)
      if (!permission || !election) return
      setBusy(true)
      setError(null)
      setNotice(null)
      const outcome = await run({ permission }, (approvalToken) =>
        electionApi.transition(election.id, action, note, approvalToken),
      )
      setBusy(false)
      if (outcome.status === 'failed') {
        setError(outcome.error)
        return
      }
      if (outcome.status === 'cancelled') return
      setNotice(`Moved to ${STATUS_LABELS[outcome.value.election.effective_status].toLowerCase()}.`)
      setRefreshKey((value) => value + 1)
      onChanged()
    },
    [run, election, onChanged],
  )

  /**
   * Transitions that fix what has already happened get a warning and a reason
   * before anything runs, so the audit record shows a deliberate decision.
   */
  const requestTransition = (action: LifecycleAction) => {
    if (!election) return
    const warning = irreversibleWarning(election, action)
    if (!warning) {
      void runTransition(action)
      return
    }
    setAwaiting(action)
    setConfirm(warning)
  }

  if (error && !detail) return <Alert tone="error">{error}</Alert>
  if (!detail || !election) return <Spinner label="Loading election…" />

  return (
    <div className="workspace">
      <button type="button" className="workspace-back" onClick={onBack}>
        <Icon name="arrow-left" />
        All elections
      </button>

      <div className="workspace-head">
        <div className="workspace-id">
          <span className={`icon-tile tile-${TILE_FOR_STATUS[election.effective_status] ?? 'slate'}`}>
            <Icon name="flag" />
          </span>
          <StatusBadge status={election.status} effective={election.effective_status} />
          <span className="mono-key">{election.id}</span>
        </div>

        <div className="workspace-title-row">
          <div className="workspace-title">
            <h1>{election.title}</h1>
            <p className="workspace-sub">
              {ELECTION_TYPE_LABELS[election.election_type]} · {election.timezone}
            </p>
          </div>
          <div className="workspace-actions">
            <button type="button" className="btn-outline" onClick={() => setTab('preview')}>
              <Icon name="ballot" />
              Preview
            </button>
            <details className="menu">
              <summary className="btn-icon" aria-label="More actions">
                <Icon name="more" />
              </summary>
              <div className="menu-panel">
                {WORKSPACE_TABS.filter((item) => item.id !== 'preview').map((item) => (
                  <button key={item.id} type="button" className="menu-item" onClick={() => setTab(item.id)}>
                    <Icon name={item.icon} />
                    {item.label}
                  </button>
                ))}
              </div>
            </details>
          </div>
        </div>
      </div>

      <LifecycleBar
        election={election}
        serverOffsetMs={serverOffsetMs}
        busy={busy}
        onTransition={(action) => requestTransition(action)}
      />

      {notice && <Alert tone="success">{notice}</Alert>}
      {error && <Alert tone="error">{error}</Alert>}

      <nav className="tabs" role="tablist">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            className={`tab${tab === item.id ? ' active' : ''}`}
            onClick={() => setTab(item.id)}
          >
            <Icon name={item.icon} />
            {item.label}
            {item.id === 'candidates' && <span className="tab-count">{election.approved_candidate_count}</span>}
            {item.id === 'roll' && <span className="tab-count">{election.eligible_count}</span>}
          </button>
        ))}
      </nav>

      {tab === 'overview' && <OverviewPanel detail={detail} serverOffsetMs={serverOffsetMs} onChanged={onChanged} onRefresh={() => setRefreshKey((v) => v + 1)} />}
      {tab === 'rules' && <RulesPanel detail={detail} onChanged={onChanged} onRefresh={() => setRefreshKey((v) => v + 1)} />}
      {tab === 'candidates' && (
        <CandidatesPanel election={election} candidates={detail.candidates} onChanged={async () => { await load(); onChanged() }} />
      )}
      {tab === 'roll' && <RollPanel election={election} roll={detail.roll} onChanged={async () => { await load(); onChanged() }} />}
      {tab === 'preview' && <BallotPreviewPanel electionId={election.id} serverOffsetMs={serverOffsetMs} />}
      {tab === 'results' && <ResultsPanel electionId={election.id} />}
      {tab === 'audit' && <AuditTrail electionId={election.id} timezone={election.timezone} refreshKey={refreshKey} />}

      {confirm && (
        <ConfirmDialog
          options={confirm}
          busy={busy}
          onCancel={() => {
            setConfirm(null)
            setAwaiting(null)
          }}
          onConfirm={() => {
            const action = awaiting
            setConfirm(null)
            setAwaiting(null)
            if (action) void runTransition(action)
          }}
        />
      )}
    </div>
  )
}

/**
 * The warning shown before a transition that cannot be undone.
 *
 * Returning null means the action can run straight away.
 */
function irreversibleWarning(election: ElectionSummary, action: LifecycleAction): ConfirmOptions | null {
  if (action === 'close') {
    return {
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
            records that voting was ended by an administrator rather than by the schedule.
          </p>
        </>
      ),
      footnote: 'Recorded in the audit trail against your account, with the request id and result.',
    }
  }
  if (action === 'certify') {
    return {
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
    }
  }
  if (action === 'archive') {
    return {
      title: 'Archive this election?',
      confirmLabel: 'Archive',
      body: (
        <p>
          <strong>{election.title}</strong> will be archived and hidden from the active list. It stays fully readable
          for the record, but no further changes are possible.
        </p>
      ),
    }
  }
  if (action === 'pause') {
    return {
      title: 'Pause voting?',
      confirmLabel: 'Pause voting',
      body: (
        <p>
          No ballots will be accepted while <strong>{election.title}</strong> is paused. Pausing is also the only window
          in which candidate status can change, because the ballot is frozen once voting has begun.
        </p>
      ),
    }
  }
  return null
}

function LifecycleBar({
  election,
  serverOffsetMs,
  busy,
  onTransition,
}: {
  election: ElectionSummary
  serverOffsetMs: number
  busy: boolean
  onTransition: (action: LifecycleAction) => void
}) {
  const nextChangeAt =
    election.effective_status === 'open'
      ? Date.parse(election.ends_at)
      : election.effective_status === 'scheduled'
        ? Date.parse(election.starts_at)
        : null
  const hasCountdown = nextChangeAt !== null && nextChangeAt - (Date.now() + serverOffsetMs) > 0
  const available = election.actions.filter((entry) => entry.available)
  const unavailable = election.actions.filter((entry) => !entry.available)

  return (
    <div className="lifecycle">
      <div className="lifecycle-status">
        <div className="lifecycle-current">
          <span className={`icon-tile tile-${TILE_FOR_STATUS[election.effective_status] ?? 'slate'}`}>
            <Icon name="activity" />
          </span>
          <div>
            <Eyebrow>Lifecycle</Eyebrow>
            <p className="lifecycle-headline" style={{ marginTop: 7 }}>
              {election.effective_status === 'open' && 'Voting is open'}
              {election.effective_status === 'scheduled' && 'Waiting for the scheduled start'}
              {election.effective_status === 'paused' && 'Voting is paused'}
              {election.effective_status === 'closed' && 'Voting has ended'}
              {election.effective_status === 'certified' && 'Results certified'}
              {election.effective_status === 'archived' && 'Archived'}
              {election.effective_status === 'draft' && 'Draft — not visible to voters'}
            </p>
            <p className="lifecycle-desc">{STATUS_DESCRIPTIONS[election.effective_status]}</p>
          </div>
        </div>
        <div className="lifecycle-timing">
          <div>
            <Eyebrow>Opens</Eyebrow>
            <span>{formatInZone(election.starts_at, election.timezone)}</span>
          </div>
          <div>
            <Eyebrow>Closes</Eyebrow>
            <span>{formatInZone(election.ends_at, election.timezone)}</span>
          </div>
          {hasCountdown && nextChangeAt !== null && (
            <div>
              <Eyebrow>{election.effective_status === 'open' ? 'Closes in' : 'Opens in'}</Eyebrow>
              <Countdown targetAt={nextChangeAt} serverOffsetMs={serverOffsetMs} />
            </div>
          )}
        </div>
      </div>

      {/*
        The bar is split in two on purpose. What can be done now is a row of
        buttons; what cannot is folded away behind a disclosure that still names
        every transition and says why it is unavailable. A flat row of eight
        mostly-disabled buttons reads as eight failures rather than two actions.
      */}
      <div className="lifecycle-actions">
        {available.map((entry) => (
          <LifecycleAction key={entry.action} entry={entry} explain={explainFor(entry, permissionOf(entry), elevationOf(entry))} disabled={busy} onRun={onTransition} />
        ))}
        {unavailable.length > 0 && (
          <details className="menu lifecycle-more">
            <summary className="btn-ghost">
              <Icon name="more" />
              {unavailable.length} unavailable
            </summary>
            <div className="menu-panel">
              {unavailable.map((entry) => (
                <button
                  key={entry.action}
                  type="button"
                  className="menu-item"
                  disabled
                  title={explainFor(entry, permissionOf(entry), elevationOf(entry))}
                >
                  <Icon name="close" />
                  {LIFECYCLE_ACTION_LABELS[entry.action]}
                </button>
              ))}
            </div>
          </details>
        )}
      </div>
    </div>
  )
}

const permissionOf = (entry: ElectionSummary['actions'][number]) => permissionForLifecycleAction(entry.action)
const elevationOf = (entry: ElectionSummary['actions'][number]) => {
  const permission = permissionOf(entry)
  return permission ? elevationFor(permission).elevation : 'none'
}

/** Why a transition is or is not available, in the order an operator needs it. */
function explainFor(entry: ElectionSummary['actions'][number], permission: Permission | null, step: string): string {
  return [
    entry.reason,
    permission ? `Requires ${permission}.` : null,
    step === 'reauth' ? 'You will be asked to confirm your password.' : null,
    step === 'mfa' ? 'You will be asked for a second factor.' : null,
    step === 'two_person' ? 'A second administrator must approve this.' : null,
  ]
    .filter(Boolean)
    .join(' ')
}

function LifecycleAction({ entry, explain, disabled, onRun }: {
  entry: ElectionSummary['actions'][number]
  explain: string
  disabled: boolean
  onRun: (action: LifecycleAction) => void
}) {
  const step = elevationOf(entry)
  return (
    <button
      type="button"
      className={`btn-lifecycle btn-lifecycle-${entry.action}${step !== 'none' ? ' btn-lifecycle-elevated' : ''}`}
      disabled={disabled}
      title={explain}
      onClick={() => onRun(entry.action)}
    >
      {LIFECYCLE_ACTION_LABELS[entry.action]}
      {step !== 'none' && (
        <span className="btn-lifecycle-lock" aria-hidden="true" title="Requires an extra check">
          {step === 'two_person' ? '2' : '•'}
        </span>
      )}
    </button>
  )
}

function OverviewPanel({
  detail,
  serverOffsetMs,
  onChanged,
  onRefresh,
}: {
  detail: ElectionDetail
  serverOffsetMs: number
  onChanged: () => void
  onRefresh: () => void
}) {
  const { election, preview } = detail
  const [title, setTitle] = useState(election.title)
  const [description, setDescription] = useState(election.description)
  const [type, setType] = useState<ElectionType>(election.election_type)
  const [startsAt, setStartsAt] = useState(() => utcToWallTime(election.starts_at, election.timezone))
  const [endsAt, setEndsAt] = useState(() => utcToWallTime(election.ends_at, election.timezone))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    setTitle(election.title)
    setDescription(election.description)
    setType(election.election_type)
    setStartsAt(utcToWallTime(election.starts_at, election.timezone))
    setEndsAt(utcToWallTime(election.ends_at, election.timezone))
  }, [election])

  const save = async (event: React.FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    setSaved(false)
    const starts = wallTimeToUtc(startsAt, election.timezone)
    const ends = wallTimeToUtc(endsAt, election.timezone)
    if (!starts || !ends) {
      setError('Enter valid start and end times.')
      setBusy(false)
      return
    }
    const result = await electionApi.update(election.id, {
      title,
      description,
      election_type: type,
      starts_at: starts,
      ends_at: ends,
    })
    setBusy(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    setSaved(true)
    onRefresh()
    onChanged()
  }

  const lockNote = election.edits_allowed
    ? null
    : election.status === 'open'
      ? 'Voting is open. Pause the poll to change candidate status; the ballot and schedule are frozen from here.'
      : election.status === 'paused'
        ? 'Voting has been paused. Candidate status and the description can still change, but the ballot itself is frozen.'
        : `This election is ${election.effective_status.replace('_', ' ')} and is read-only.`

  return (
    <>
      <ElectionStats election={election} preview={preview} serverOffsetMs={serverOffsetMs} />
      <div style={{ marginTop: 20 }}>
        <div className="panel">
          <div className="panel-head">
            <div>
              <Eyebrow>Configuration</Eyebrow>
              <h3 style={{ marginTop: 9 }}>Election details</h3>
              <p>Identity, classification and the voting window.</p>
            </div>
          </div>

          {lockNote && <Alert tone="warn">{lockNote}</Alert>}

          <form onSubmit={save}>
            <Field label="Title" htmlFor="o-title">
              <input id="o-title" value={title} onChange={(event) => setTitle(event.target.value)} disabled={!election.edits_allowed} maxLength={160} required />
            </Field>
            <Field label="Description" htmlFor="o-desc">
              <textarea id="o-desc" rows={4} value={description} onChange={(event) => setDescription(event.target.value)} disabled={!election.edits_allowed} maxLength={2000} />
            </Field>
            <div className="form-grid">
              <Field label="Election type" htmlFor="o-type">
                <select id="o-type" value={type} onChange={(event) => setType(event.target.value as ElectionType)} disabled={!election.edits_allowed}>
                  {ELECTION_TYPES.map((item) => (
                    <option key={item} value={item}>
                      {ELECTION_TYPE_LABELS[item]}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Timezone" htmlFor="o-tz">
                <input id="o-tz" value={election.timezone} disabled readOnly />
              </Field>
            </div>
            <div className="form-grid">
              <Field label="Opens (local to timezone)" htmlFor="o-start">
                <input id="o-start" type="datetime-local" value={startsAt} onChange={(event) => setStartsAt(event.target.value)} disabled={!election.edits_allowed} />
              </Field>
              <Field label="Closes (local to timezone)" htmlFor="o-end">
                <input id="o-end" type="datetime-local" value={endsAt} onChange={(event) => setEndsAt(event.target.value)} disabled={!election.edits_allowed} />
              </Field>
            </div>

            {error && <Alert tone="error">{error}</Alert>}
            {saved && <Alert tone="success">Saved. The change is recorded in the audit trail.</Alert>}

            {election.edits_allowed && (
              <div className="admin-form-actions">
                <button type="submit" className="btn-primary" disabled={busy}>
                  {busy ? 'Saving…' : 'Save changes'}
                </button>
              </div>
            )}
          </form>

          <div className="preview-meta">
            <div>
              <Eyebrow>Created</Eyebrow>
              <span>{formatInZone(election.created_at, election.timezone)}</span>
            </div>
            <div>
              <Eyebrow>Published</Eyebrow>
              <span>{election.published_at ? formatInZone(election.published_at, election.timezone) : 'Not yet'}</span>
            </div>
            <div>
              <Eyebrow>Closed</Eyebrow>
              <span>{election.closed_at ? formatInZone(election.closed_at, election.timezone) : '—'}</span>
            </div>
            <div>
              <Eyebrow>Certified</Eyebrow>
              <span>{election.certified_at ? formatInZone(election.certified_at, election.timezone) : '—'}</span>
            </div>
            <div>
              <Eyebrow>Ballots recorded</Eyebrow>
              <span>{election.ballot_count}</span>
            </div>
            <div>
              <Eyebrow>Ready to publish</Eyebrow>
              <span>{preview.ready_to_publish ? 'Yes' : 'No'}</span>
            </div>
          </div>
          <p className="preview-footnote">Server time is {new Date(Date.now() + serverOffsetMs).toISOString()}.</p>
        </div>
      </div>
    </>
  )
}

function RulesPanel({ detail, onChanged, onRefresh }: { detail: ElectionDetail; onChanged: () => void; onRefresh: () => void }) {
  const { election } = detail
  const [rules, setRules] = useState(election.rules)
  const [eligibility, setEligibility] = useState(election.eligibility)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    setRules(election.rules)
    setEligibility(election.eligibility)
  }, [election])

  const saveRules = async (event: React.FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    setSaved(false)
    const result = await electionApi.setRules(election.id, rules)
    if (result.ok) {
      const second = await electionApi.setEligibility(election.id, eligibility)
      setBusy(false)
      if (!second.ok) {
        setError(second.error)
        return
      }
      setSaved(true)
      onRefresh()
      onChanged()
      return
    }
    setBusy(false)
    setError(result.error)
  }

  const toggle = (key: keyof typeof rules) => () => setRules({ ...rules, [key]: !rules[key] })

  return (
    <div className="panel">
      <div className="panel-head">
        <div>
          <Eyebrow>Policy</Eyebrow>
          <h3 style={{ marginTop: 9 }}>Voting rules and eligibility</h3>
          <p>These are enforced on the server. The voter interface cannot override them.</p>
        </div>
      </div>

      {!election.edits_allowed && (
        <Alert tone="warn">
          Rules are locked because this election is {election.effective_status.replace('_', ' ')}. They were fixed when
          voting began.
        </Alert>
      )}

      <form onSubmit={saveRules}>
        <fieldset className="fieldset" disabled={!election.edits_allowed}>
          <legend>Ballot</legend>
          <div className="form-grid">
            <Field label="Selections per voter" htmlFor="r-vpv">
              <input
                id="r-vpv"
                type="number"
                min={1}
                max={20}
                value={rules.votesPerVoter}
                onChange={(event) => setRules({ ...rules, votesPerVoter: Number(event.target.value) })}
              />
            </Field>
            <Field label="Results visibility" htmlFor="r-vis">
              <select
                id="r-vis"
                value={rules.resultsVisibility}
                onChange={(event) => setRules({ ...rules, resultsVisibility: event.target.value as typeof rules.resultsVisibility })}
              >
                {RESULTS_VISIBILITIES.map((value) => (
                  <option key={value} value={value}>
                    {value === 'live'
                      ? 'Live while voting is open'
                      : value === 'after_close'
                        ? 'After voting closes'
                        : value === 'after_certify'
                          ? 'After certification'
                          : 'Never published'}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <label className="checkbox">
            <input type="checkbox" checked={rules.allowNotA} onChange={toggle('allowNotA')} /> Offer &ldquo;None of the Above&rdquo;
          </label>
          <label className="checkbox">
            <input type="checkbox" checked={rules.allowAbstain} onChange={toggle('allowAbstain')} /> Offer &ldquo;Abstain&rdquo;
          </label>
          <label className="checkbox">
            {/*
              Disabled on purpose, with the reason on screen. Replacing a ballot means
              locating it, and locating it means linking it to the person who cast it —
              the one capability the ballot store is built not to have. Presenting this
              as a live option would be a promise the platform cannot keep.
            */}
            <label className="checkbox disabled" title="Not available: a ballot cannot be linked to the voter who cast it.">
              <input type="checkbox" checked={false} disabled readOnly /> Let voters replace their selection before
              closing (not available on a secret ballot)
            </label>
          </label>
          <label className="checkbox">
            <input type="checkbox" checked={rules.issueReceipts} onChange={toggle('issueReceipts')} /> Issue a receipt code after voting
          </label>
          <label className="checkbox">
            <input type="checkbox" checked={rules.randomizeBallotOrder} onChange={toggle('randomizeBallotOrder')} /> Shuffle option order per voter
          </label>
          <label className="checkbox">
            <input type="checkbox" checked={rules.showCandidateImages} onChange={toggle('showCandidateImages')} /> Show candidate images
          </label>
        </fieldset>

        <fieldset className="fieldset" disabled={!election.edits_allowed}>
          <legend>Identity verification</legend>
          <label className="checkbox">
            <input type="checkbox" checked={rules.requireOtp} onChange={toggle('requireOtp')} /> Require one-time codes
          </label>
          <label className="checkbox">
            <input type="checkbox" checked={rules.requirePhone} onChange={toggle('requirePhone')} /> Verify by phone code
          </label>
          <label className="checkbox">
            <input type="checkbox" checked={rules.requireEmail} onChange={toggle('requireEmail')} /> Verify by email code
          </label>
        </fieldset>

        <fieldset className="fieldset" disabled={!election.edits_allowed}>
          <legend>Eligibility</legend>
          <div className="form-grid">
            <Field label="Mode" htmlFor="el-mode">
              <select
                id="el-mode"
                value={eligibility.mode}
                onChange={(event) => setEligibility({ ...eligibility, mode: event.target.value as typeof eligibility.mode })}
              >
                <option value="roll">Closed roll managed by administrators</option>
                <option value="open_registration">Open registration</option>
              </select>
            </Field>
            <Field label="Identifier label" htmlFor="el-label">
              <input
                id="el-label"
                value={eligibility.identifierLabel}
                onChange={(event) => setEligibility({ ...eligibility, identifierLabel: event.target.value })}
                maxLength={60}
              />
            </Field>
          </div>
          <Field label="Group label" htmlFor="el-group" hint="Optional, e.g. Department, Society, Batch.">
            <input
              id="el-group"
              value={eligibility.groupLabel}
              onChange={(event) => setEligibility({ ...eligibility, groupLabel: event.target.value })}
              maxLength={60}
            />
          </Field>
          <Field label="Guidance shown to voters" htmlFor="el-notes">
            <textarea
              id="el-notes"
              rows={3}
              value={eligibility.notes}
              onChange={(event) => setEligibility({ ...eligibility, notes: event.target.value })}
              maxLength={500}
            />
          </Field>
        </fieldset>

        {error && <Alert tone="error">{error}</Alert>}
        {saved && <Alert tone="success">Rules saved and recorded in the audit trail.</Alert>}

        {election.edits_allowed && (
          <div className="admin-form-actions">
            <button type="submit" className="btn-primary" disabled={busy}>
              {busy ? 'Saving…' : 'Save rules'}
            </button>
          </div>
        )}
      </form>
    </div>
  )
}

export { defaultEligibility, defaultRules }
