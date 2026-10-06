/**
 * Voter interface.
 *
 * A linear flow: pick an election, prove identity, review the ballot, vote,
 * receive a receipt. Every screen reflects the lifecycle state the server
 * reports, and the ballot itself is only rendered when the server says voting
 * is open, so a voter is never left guessing why they cannot proceed.
 *
 * The frame is constant across the flow: a dark brand strip, a step
 * indicator, then a single focused card. Only the card's contents change, which
 * is what keeps a voter oriented while they move through it.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  forgetVoterSession,
  markVoterSession,
  voterApi,
  type VoterBallotResult,
  type VoterBeginResult,
} from '../lib/api'
import { describeVotableState, formatWindow } from '../lib/time'
import { STATUS_LABELS } from '../lib/lifecycle'
import {
  ELECTION_TYPE_LABELS,
  SPECIAL_OPTION_IDS,
  type BallotOption,
  type ElectionSummary,
} from '../lib/types'
import { Alert, Countdown, DemoNote, Eyebrow, Field, Modal, StatusBadge } from '../ui/primitives'
import { Icon } from '../ui/Icon'
import { ResultsPanel } from './ResultsPanel'

type Stage = 'pick' | 'preview' | 'identify' | 'codes' | 'ballot' | 'receipt' | 'results'

/**
 * The stages the progress indicator names, in order.
 *
 * One entry per stage a voter can actually be on. The list deliberately mirrors
 * the flow's own states rather than grouping them, so the indicator is a map of
 * where they are rather than a summary of what happened.
 */
const STEPS = [
  { id: 'pick', label: 'Choose' },
  { id: 'preview', label: 'Preview' },
  { id: 'identify', label: 'Identify' },
  { id: 'codes', label: 'Code' },
  { id: 'ballot', label: 'Ballot' },
  { id: 'receipt', label: 'Receipt' },
] as const

function stepFor(stage: Stage): number {
  if (stage === 'pick') return 0
  if (stage === 'preview') return 1
  if (stage === 'identify') return 2
  if (stage === 'codes') return 3
  if (stage === 'ballot') return 4
  // 'results' is not a stage of its own — it is a detour off the ballot, reached
  // from a stage already passed, so it keeps that stage's marker rather than
  // inventing one.
  if (stage === 'receipt') return 5
  return 4
}

type Flash = { tone: 'info' | 'warn' | 'error' | 'success'; text: string } | null

/**
 * Copy to the clipboard, reporting whether it worked.
 *
 * The receipt code is the only record a voter keeps, so the copy affordance has
 * to acknowledge itself either way rather than silently doing nothing when the
 * browser refuses clipboard access.
 */
async function copyText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value)
    return true
  } catch {
    return false
  }
}

function optionLabel(option: BallotOption) {
  return option.kind === 'candidate' ? option.name : option.name
}

function ballotPurpose(description: string, title: string, type: string) {
  const outOfScope = /\b(candidates?|voters? rank|choices?|options?|preferential ballot|single transferable|voting (?:opens|closed|will)|results?|tally|certif\w*|draft|published|paused|archived|standing order|never published|whether\b.*\bor\b)\b/i
  const summary = description
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => !outOfScope.test(sentence))
    .join(' ')
    .trim()
  const purpose = summary || `This ballot is for the ${type.toLowerCase()} titled “${title}.”`
  return `${purpose} The ballot records the official outcome of this election.`
}

function shuffled<T>(items: T[], seed: number): T[] {
  const copy = [...items]
  // Deterministic per-session shuffle so a reload does not reorder the ballot.
  let state = seed || 1
  for (let i = copy.length - 1; i > 0; i -= 1) {
    state = (state * 1103515245 + 12345) % 2147483648
    const j = state % (i + 1)
    ;[copy[i], copy[j]] = [copy[j], copy[i]]
  }
  return copy
}

/**
 * The progress indicator.
 *
 * A bar per stage with the label beneath it. The bar carries the state — filled
 * and lit where the voter has been, flat where they have not — so progress is
 * legible at a glance without reading five numbers.
 */
function StageSteps({ activeStep }: { activeStep: number }) {
  return (
    <nav aria-label="Progress">
      <ol className="steps">
        {STEPS.map((step, index) => (
          <li
            key={step.id}
            className={`step-slot${
              index === activeStep ? ' step-active' : index < activeStep ? ' step-done' : ''
            }`}
            aria-current={index === activeStep ? 'step' : undefined}
          >
            <span className="step-bar" aria-hidden="true" />
            <span className="step-label">{step.label}</span>
          </li>
        ))}
      </ol>
    </nav>
  )
}

export function VoterFlow({
  elections,
  serverOffsetMs,
  onChanged,
}: {
  elections: ElectionSummary[]
  serverOffsetMs: number
  onChanged: () => void
}) {
  const [electionId, setElectionId] = useState<string | null>(null)
  const [stage, setStage] = useState<Stage>('pick')
  const [flash, setFlash] = useState<Flash>(null)
  const [begin, setBegin] = useState<VoterBeginResult | null>(null)
  const [ballot, setBallot] = useState<VoterBallotResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [identifier, setIdentifier] = useState('')
  /** Codes are keyed by challenge id, so the form never handles a channel index. */
  const [codes, setCodes] = useState<Record<string, string>>({})
  const [receipt, setReceipt] = useState<{ receipts: string[]; submittedAt: string; digest: string } | null>(null)
  const [copied, setCopied] = useState(false)

  const election = useMemo(
    () => elections.find((item) => item.id === electionId) ?? null,
    [elections, electionId],
  )

  /**
   * Try to pick up an existing verified session.
   *
   * A refusal is not a failure. The cookie is `HttpOnly`, so the page cannot know
   * whether it holds a session and has to ask; the ordinary answer on a first
   * visit is "no", and that must not be reported to a voter as an error or a
   * warning. Only a refusal that is *not* about the session — the election closed
   * underneath them, the server is down — is worth showing.
   */
  const loadBallot = useCallback(async (id: string) => {
    const result = await voterApi.ballot(id)
    if (!result.ok) {
      if (result.code === 'unauthorized' || result.code === 'not_found') return false
      setFlash({ tone: 'error', text: result.error })
      return false
    }
    setBallot(result.value)
    return true
  }, [])

  /*
   * Resume an in-progress verification when the page is reloaded.
   *
   * The session cookie is `HttpOnly`, so the page cannot check whether it exists
   * — it asks the server. Only the server's answer decides whether a ballot is
   * shown, which is the whole point: nothing here can manufacture a session.
   */
  useEffect(() => {
    if (!electionId || stage !== 'identify') return
    let cancelled = false
    void (async () => {
      const result = await voterApi.ballot(electionId)
      if (cancelled) return
      if (result.ok) {
        markVoterSession(true, electionId)
        setBallot(result.value)
        // Deliberately 'ballot' whether or not the vote is already cast. BallotStage
        // reads `has_voted` and renders the "You have already voted" card itself, and
        // that card is the correct screen for a *resumed* session.
        //
        // The 'receipt' stage used to be chosen here when `has_voted` was true. But
        // the receipt payload only exists in memory for the response to a vote this
        // page just submitted — the server will not hand back a digest on a later
        // request, because the ballot is deliberately not retrievable by identity.
        // So on a reload, or in a second tab sharing the HttpOnly cookie, `receipt`
        // was null while `stage` was 'receipt', and the `{stage === 'receipt' &&
        // receipt && ...}` guard rendered nothing at all: a blank page for a voter
        // who had already voted, with no receipt and no way forward. 'Receipt' now
        // means exactly "just submitted, and here is the payload".
        setStage('ballot')
      } else {
        forgetVoterSession()
      }
    })()
    return () => {
      cancelled = true
    }
  }, [electionId, stage])

  const openElection = useCallback(
    (id: string) => {
      setElectionId(id)
      setFlash(null)
      setBallot(null)
      setBegin(null)
      setReceipt(null)
      setCodes({})
      setStage('preview')
    },
    [],
  )

  const state = useMemo(() => {
    if (!election) return null
    return describeVotableState({
      status: election.effective_status,
      startsAt: election.starts_at,
      endsAt: election.ends_at,
      serverOffsetMs,
    })
  }, [election, serverOffsetMs])

  const submitIdentifier = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!election) return
    setBusy(true)
    setFlash(null)
    const result = await voterApi.begin(election.id, identifier.trim())
    setBusy(false)
    if (!result.ok) {
      setFlash({ tone: 'error', text: result.error })
      return
    }
    setBegin(result.value)
    // A null identity is the deliberate "we are not telling you" response for an
    // identifier that is not on the roll. The form still asks for a code, so the
    // screen looks identical either way and reveals nothing.
    setCodes({})
    setStage(result.value.requires_code && result.value.challenges.length > 0 ? 'codes' : 'ballot')
  }

  const submitCodes = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!election || !begin) return
    setBusy(true)
    setFlash(null)
    const answers = begin.challenges
      .map((challenge) => ({ challenge_id: challenge.challenge_id, code: (codes[challenge.challenge_id] ?? '').trim() }))
      .filter((answer) => answer.code.length > 0)
    const result = await voterApi.verify(election.id, begin.voter?.voter_id ?? identifier.trim(), answers)
    setBusy(false)
    if (!result.ok) {
      setFlash({ tone: 'error', text: result.error })
      return
    }
    // No token to store: the server has set an HttpOnly cookie.
    markVoterSession(true, election.id)
    await loadBallot(election.id)
    setStage('ballot')
  }

  /**
   * Ask for a fresh voting credential.
   *
   * Needed because the credential is deliberately short lived: a voter who paused
   * to read a long ballot can come back to it without re-entering their
   * verification code. The server still holds the authenticated session, so this is
   * not a way around verification.
   */
  const requestCredential = useCallback(async () => {
    if (!election) return
    setBusy(true)
    setFlash(null)
    const result = await voterApi.credential(election.id)
    setBusy(false)
    if (!result.ok) {
      setFlash({ tone: 'error', text: result.error })
      return
    }
    await loadBallot(election.id)
  }, [election, loadBallot])

  const signOut = async () => {
    if (election) await voterApi.logout(election.id)
    forgetVoterSession()
    setBallot(null)
    setBegin(null)
    setReceipt(null)
    setStage('identify')
    setFlash(null)
    onChanged()
  }

  const back = () => {
    setStage('pick')
    setElectionId(null)
    setFlash(null)
  }

  /* ------------------------------------------------------------ the picker --- */

  if (elections.length === 0) {
    return (
      <div className="voter-shell">
        <div className="empty-state">
          <span className="icon-tile icon-tile-lg tile-blue">
            <Icon name="ballot" />
          </span>
          <h3>No elections are available</h3>
          <p>There are no published elections on this server yet. An administrator needs to create and publish one first.</p>
        </div>
      </div>
    )
  }

  if (stage === 'pick' || !election || !state) {
    return (
      <div className="voter-shell">
        <StageSteps activeStep={stepFor('pick')} />
        <div className="election-list-header">
          <Eyebrow tone="blue">Voter portal</Eyebrow>
          <h1 style={{ marginTop: 12 }}>Available elections</h1>
          <p>Choose an election to take part in. Each election has its own schedule and voter roll.</p>
        </div>
        <div className="election-grid">
          {elections
            .filter((item) => item.status !== 'archived')
            .map((item) => {
              const itemState = describeVotableState({
                status: item.effective_status,
                startsAt: item.starts_at,
                endsAt: item.ends_at,
                serverOffsetMs,
              })
              const window_ = formatWindow(item.starts_at, item.ends_at, item.timezone)
              const status = item.effective_status
              return (
                <button key={item.id} type="button" className="election-card" onClick={() => void openElection(item.id)}>
                  <div className="election-card-meta">
                    <span className="election-card-type">{ELECTION_TYPE_LABELS[item.election_type]}</span>
                    <span className={`election-card-status election-card-status-${status}`}>
                      <span className="election-card-status-dot" aria-hidden="true" />
                      {STATUS_LABELS[status]}
                      {status !== item.status && <span className="election-card-auto">Auto</span>}
                    </span>
                    <span className="roster-arrow" aria-hidden="true"><Icon name="arrow-right" /></span>
                  </div>

                  <h2>{item.title}</h2>
                  <p className="election-card-desc">{item.description || 'No description provided.'}</p>

                  <div className="election-card-foot">
                    <span className="election-card-window" title={window_.zone ? `${window_.label} · ${window_.zone}` : window_.label}>
                      <span className="election-card-window-label">{window_.label}</span>
                      {window_.zone && <span className="election-card-window-zone">{window_.zone}</span>}
                    </span>
                    {itemState.nextChangeAt !== null ? (
                      <span className="election-card-timer" aria-label={itemState.nextChangeLabel ?? 'Time remaining'}>
                        <Countdown
                          targetAt={itemState.nextChangeAt}
                          serverOffsetMs={serverOffsetMs}
                          prefix={itemState.nextChangeLabel?.replace(/^Voting /, '').replace(/^window /, '')}
                        />
                      </span>
                    ) : (
                      <span className="election-card-state-detail">{itemState.headline}</span>
                    )}
                  </div>
                </button>
              )
            })}
        </div>
      </div>
    )
  }

  /* ------------------------------------------------------------- the flow --- */

  const activeStep = stepFor(stage)
  const label = [election.title, ELECTION_TYPE_LABELS[election.election_type]].filter(Boolean).join(' · ')
  const purpose = ballotPurpose(election.description, election.title, ELECTION_TYPE_LABELS[election.election_type])

  return (
    <div className="voter-shell">
      <StageSteps activeStep={activeStep} />

      {stage !== 'results' && (
        <div style={{ marginBottom: 18 }}>
          <button type="button" className="workspace-back" onClick={back}>
            <Icon name="arrow-left" />
            All elections
          </button>
        </div>
      )}

      {flash && (
        <Alert tone={flash.tone}>
          {flash.text}
        </Alert>
      )}

      {stage === 'preview' && (
        <div className="focus-card focus-card-plain">
          <div className="focus-head">
            <div>
              <Eyebrow tone="blue">Ballot preview · {ELECTION_TYPE_LABELS[election.election_type]}</Eyebrow>
              <h1>{election.title}</h1>
              <p>The description below explains why the election is being held and what the ballot covers.</p>
            </div>
          </div>

          <div className="ballot-heading">
            <h2 className="ballot-description-title">Description</h2>
            <p>{purpose}</p>
          </div>

          <button type="button" className="btn-primary btn-block btn-lg" onClick={() => setStage('identify')}>
            Continue to verification
            <Icon name="arrow-right" />
          </button>
        </div>
      )}

      {stage === 'identify' && (
        <form className="focus-card" onSubmit={submitIdentifier}>
          <div className="focus-head">
            <div>
              <Eyebrow tone="blue">{label}</Eyebrow>
              <h1>Cast your ballot securely.</h1>
              <p>
                Enter the {election.eligibility.identifierLabel || 'voter identifier'} issued to you for this
                election. Your identity and ballot choices are kept separate by design.
              </p>
            </div>
          </div>

          <Field label={election.eligibility.identifierLabel || 'Voter ID'} htmlFor="identifier">
            <input
              id="identifier"
              type="text"
              value={identifier}
              autoComplete="off"
              onChange={(event) => setIdentifier(event.target.value)}
              placeholder="e.g. STU-2026-0001"
              required
              disabled={!state.canVote}
            />
          </Field>

          {election.eligibility.notes && <p className="voter-info-note">{election.eligibility.notes}</p>}

          {!state.canVote && (
            <div style={{ marginBottom: 18 }}>
              <Alert tone="warn">
                You cannot vote in this election right now. You can still review the schedule above.
                <button type="button" className="link-button inline" onClick={() => setStage('results')}>
                  View results
                </button>
              </Alert>
            </div>
          )}

          <div className="voter-state-bar" style={{ marginBottom: 18 }}>
            <StatusBadge status={election.status} effective={election.effective_status} />
            <span className="voter-state-headline">{state.headline}</span>
            {state.nextChangeAt !== null && (
              <Countdown targetAt={state.nextChangeAt} serverOffsetMs={serverOffsetMs} prefix={`${state.nextChangeLabel} `} />
            )}
          </div>

          <button type="submit" className="btn-primary btn-block btn-lg" disabled={busy || !state.canVote}>
            {busy ? 'Checking…' : 'Verify & continue'}
            {!busy && <Icon name="arrow-right" />}
          </button>

          <div className="focus-foot">
            <p>Need help? Contact your election officer.</p>
          </div>
        </form>
      )}

      {stage === 'codes' && begin && (
        <form className="focus-card" onSubmit={submitCodes}>
          <div className="focus-head">
            <span className="icon-tile icon-tile-lg tile-blue">
              <Icon name="key" />
            </span>
            <div>
              <Eyebrow tone="blue">{label}</Eyebrow>
              <h1>Enter your code.</h1>
              <p>
                {/*
                 * One wording, always. The server does not say whether this identifier
                 * is on the roll, so neither does the screen: it would be pointless to
                 * ask the browser to keep a secret the response never carried.
                 */}
                Enter the one-time codes sent to the contacts registered to you.
              </p>
            </div>
          </div>

          {begin.demo_codes && (
            <div style={{ marginBottom: 18 }}>
              <DemoNote>
                Demonstration build
                {begin.demo_codes.phone && (
                  <>
                    {' · '}Phone <code>{begin.demo_codes.phone}</code>
                  </>
                )}
                {begin.demo_codes.email && (
                  <>
                    {' · '}Email <code>{begin.demo_codes.email}</code>
                  </>
                )}
                . Generated fresh for each attempt and they expire.
              </DemoNote>
            </div>
          )}

          {begin.challenges.map((challenge) => (
            <Field
              key={challenge.challenge_id}
              label={challenge.channel === 'phone' ? 'Code sent by phone' : 'Code sent by email'}
              htmlFor={`code-${challenge.channel}`}
              hint={`Valid for ${challenge.expires_in} seconds. One wrong try counts against it.`}
            >
              <input
                id={`code-${challenge.channel}`}
                className="otp-field"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={challenge.digits}
                placeholder={'•'.repeat(challenge.digits)}
                value={codes[challenge.challenge_id] ?? ''}
                onChange={(event) =>
                  setCodes((current) => ({
                    ...current,
                    [challenge.challenge_id]: event.target.value
                      .replace(/\D/g, '')
                      .slice(0, challenge.digits),
                  }))
                }
                required
              />
            </Field>
          ))}

          <button type="submit" className="btn-primary btn-block btn-lg" disabled={busy} style={{ marginTop: 20 }}>
            {busy ? 'Verifying…' : 'Verify & open ballot'}
            {!busy && <Icon name="arrow-right" />}
          </button>
          <div className="focus-foot">
            <button type="button" className="link-secondary" onClick={() => setStage('identify')}>
              Use a different identifier
            </button>
          </div>
        </form>
      )}

      {stage === 'ballot' && !ballot && (
        <div className="focus-card" style={{ textAlign: 'center' }}>
          <div className="confirmed-icon" style={{ margin: '0 auto 20px', background: 'var(--red-soft)' }}>
            <Icon name="warning" style={{ color: 'var(--red)' }} />
          </div>
          <Eyebrow tone="blue">{label}</Eyebrow>
          <h1 style={{ fontSize: 24, fontWeight: 700, letterSpacing: '-0.028em', marginTop: 10 }}>Your ballot could not be opened</h1>
          <p style={{ color: 'var(--muted)', fontSize: 13.5, lineHeight: 1.65, marginTop: 12 }}>
            The server did not return a ballot, so nothing is shown here rather than a blank page. You have not been
            charged a vote: this election can only be cast once, and that happens on submission.
          </p>
          <div style={{ display: 'flex', gap: 10, marginTop: 22, justifyContent: 'center', flexWrap: 'wrap' }}>
            <button type="button" className="btn-outline" onClick={back}>
              <Icon name="arrow-left" />
              All elections
            </button>
            <button
              type="button"
              className="btn-primary"
              onClick={() => {
                setFlash(null)
                void openElection(election.id)
              }}
            >
              <Icon name="refresh" />
              Try again
            </button>
          </div>
        </div>
      )}

      {stage === 'ballot' && ballot && (
        <BallotStage
          ballot={ballot}
          busy={busy}
          setBusy={setBusy}
          onVoted={async (payload) => {
            setReceipt(payload)
            setCopied(false)
            setStage('receipt')
            await loadBallot(election.id)
            onChanged()
          }}
          onError={(text) => setFlash({ tone: 'error', text })}
          onRequestCredential={requestCredential}
        />
      )}

      {stage === 'receipt' && receipt && (
        <div className="confirmed-card">
          <div className="green-stripe" />
          <div className="confirmed-icon">
            <Icon name="check" strokeWidth={2.5} />
          </div>
          <Eyebrow tone="blue">{label}</Eyebrow>
          <h2 className="confirmed-title" style={{ marginTop: 10 }}>Your ballot is cast</h2>
          <p className="confirmed-subtitle">
            Keep the receipt code below. It is the only way to confirm a ballot exists for this election, and it
            deliberately cannot show what you chose.
          </p>

          {receipt.receipts.length > 0 && (
            <div className="receipt-box">
              <div className="receipt-label">Receipt code</div>
              {receipt.receipts.map((code) => (
                <div className="receipt-hash" key={code}>
                  {code}
                </div>
              ))}
              <button
                type="button"
                className="receipt-copy"
                onClick={() => {
                  void copyText(receipt.receipts.join('\n')).then((ok) => {
                    if (ok) setCopied(true)
                  })
                }}
              >
                <Icon name={copied ? 'check' : 'archive'} />
                {copied ? 'Copied' : 'Copy code'}
              </button>
            </div>
          )}

          <div className="receipt-note">
            <p>
              This code proves a ballot was recorded for the election. It cannot show what you chose, and it cannot
              be turned back into your identity.
              {receipt.digest && (
                <>
                  {' '}Integrity digest{' '}
                  <code>{receipt.digest.slice(0, 24)}…</code>
                </>
              )}
            </p>
          </div>

          <div className="confirmed-actions">
            <button type="button" className="btn-outline" onClick={() => setStage('results')}>
              View results
            </button>
            <button type="button" className="btn-primary" onClick={signOut}>
              Finish and sign out
            </button>
          </div>
        </div>
      )}

      {stage === 'results' && (
        <div className="voter-results">
          <ResultsPanel electionId={election.id} onSignOut={signOut} />
          <div className="focus-foot">
            <button type="button" className="link-secondary" onClick={back}>
              <Icon name="arrow-left" />
              Back to elections
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function BallotStage({
  ballot,
  busy,
  setBusy,
  onVoted,
  onError,
  onRequestCredential,
}: {
  ballot: VoterBallotResult
  busy: boolean
  setBusy: (value: boolean) => void
  onVoted: (payload: { receipts: string[]; submittedAt: string; digest: string }) => void | Promise<void>
  onError: (text: string) => void
  onRequestCredential: () => void
}) {
  const required = ballot.rules.votesPerVoter
  const [selected, setSelected] = useState<number[]>([])
  const [confirming, setConfirming] = useState(false)

  const options = useMemo(() => {
    if (!ballot.rules.randomizeBallotOrder) return ballot.options
    return shuffled(ballot.options, ballot.election.id.split('').reduce((sum, ch) => sum + ch.charCodeAt(0), 7))
  }, [ballot.options, ballot.rules.randomizeBallotOrder, ballot.election.id])

  const alreadyCast = ballot.has_voted
  const idsFor = (option: BallotOption) =>
    option.kind === 'nota' ? SPECIAL_OPTION_IDS.nota : option.kind === 'abstain' ? SPECIAL_OPTION_IDS.abstain : Number(option.key.split('-')[1])

  const toggle = (option: BallotOption) => {
    if (alreadyCast) return
    const id = idsFor(option)
    setSelected((current) => {
      if (current.includes(id)) return current.filter((item) => item !== id)
      if (current.length >= required) return [...current.slice(1), id]
      return [...current, id]
    })
  }

  const submit = async () => {
    setBusy(true)
    const result = await voterApi.vote(ballot.election.id, selected)
    setBusy(false)
    if (!result.ok) {
      setConfirming(false)
      onError(result.error)
      return
    }
    setConfirming(false)
    await onVoted({
      receipts: result.value.receipts,
      submittedAt: result.value.submitted_at,
      digest: result.value.integrity_digest,
    })
  }

  if (alreadyCast) {
    return (
      <div className="focus-card focus-card-lg" style={{ textAlign: 'center' }}>
        <div className="confirmed-icon" style={{ margin: '0 auto 20px' }}>
          <Icon name="check" strokeWidth={2.5} />
        </div>
        <Eyebrow tone="blue">{ballot.election.title}</Eyebrow>
        <h1 style={{ fontSize: 26, fontWeight: 700, letterSpacing: '-0.03em', marginTop: 10 }}>You have already voted</h1>
        <p style={{ color: 'var(--muted)', fontSize: 13.5, lineHeight: 1.65, marginTop: 12 }}>
          Your ballot for this election was recorded. One vote per eligible voter is enforced, and because your ballot
          is not stored against your identity there is nothing to show you about what you chose — your receipt is the
          record of it.
        </p>
      </div>
    )
  }

  if (!ballot.can_vote) {
    return (
      <div className="focus-card focus-card-lg" style={{ textAlign: 'center' }}>
        <div className="confirmed-icon" style={{ margin: '0 auto 20px', background: 'var(--amber-soft)' }}>
          <Icon name="clock" style={{ color: 'var(--amber-ink)' }} />
        </div>
        <Eyebrow tone="blue">{ballot.election.title}</Eyebrow>
        <h1 style={{ fontSize: 26, fontWeight: 700, letterSpacing: '-0.03em', marginTop: 10 }}>Voting credential expired</h1>
        <p style={{ color: 'var(--muted)', fontSize: 13.5, lineHeight: 1.65, marginTop: 12 }}>
          Your voting credential is short lived, so it has expired while the ballot was open. Get a fresh one to cast
          your vote — you do not need to verify your identity again.
        </p>
        <button type="button" className="btn-primary btn-lg" style={{ marginTop: 22 }} disabled={busy} onClick={onRequestCredential}>
          {busy ? 'Requesting…' : 'Get a new credential'}
          {!busy && <Icon name="arrow-right" />}
        </button>
      </div>
    )
  }

  const chosen = options.filter((option) => selected.includes(idsFor(option)))

  return (
    <div className="vote-content">
      <div className="ballot-heading">
        <Eyebrow tone="blue">{ballot.election.title}</Eyebrow>
        <h2 style={{ marginTop: 10 }}>
          {required === 1 ? 'Choose one option.' : `Choose ${required} options.`}
        </h2>
        <p>Your vote is final once submitted. Nothing links your name to your selection.</p>
      </div>
      <div className="candidate-list">
        {options.map((option) => {
          const id = idsFor(option)
          const isSelected = selected.includes(id)
          return (
            <label key={option.key} className={`candidate-row${isSelected ? ' selected' : ''}${option.kind !== 'candidate' ? ' special' : ''}`}>
              <span className="radio-circle" aria-hidden="true" />
              <input type="checkbox" name={`option-${option.key}`} checked={isSelected} onChange={() => toggle(option)} />
              {ballot.rules.showCandidateImages && option.image_url && option.kind === 'candidate' && (
                <img className="candidate-photo" src={option.image_url} alt="" />
              )}
              <span className="candidate-info">
                <span className="candidate-name">{optionLabel(option)}</span>
                {option.organization && <span className="candidate-party">{option.organization}</span>}
                {option.symbol && <span className="candidate-symbol">{option.symbol}</span>}
                {option.description && <span className="candidate-desc">{option.description}</span>}
              </span>
            </label>
          )
        })}
      </div>
      <button type="button" className="btn-submit-ballot" disabled={selected.length !== required} onClick={() => setConfirming(true)}>
        Review and submit
        <Icon name="arrow-right" />
      </button>
      <p className="focus-foot">
        <span className="muted">
          {selected.length} of {required} selected
        </span>
      </p>
      {confirming && (
        <Modal
          title="Confirm your selection"
          onClose={() => setConfirming(false)}
          footer={
            <>
              <button type="button" className="btn-cancel" disabled={busy} onClick={() => setConfirming(false)}>
                Go back
              </button>
              <button type="button" className="btn-confirm" disabled={busy} onClick={() => void submit()}>
                {busy ? 'Recording…' : 'Submit vote'}
              </button>
            </>
          }
        >
          <p className="modal-desc">You are about to submit your vote for:</p>
          {chosen.map((option) => (
            <div className="modal-candidate-card" key={option.key}>
              <div className="mc-name">{option.name}</div>
              {option.organization && <div className="mc-party">{option.organization}</div>}
            </div>
          ))}
          <div className="modal-warning">This is final and cannot be changed unless this election allows vote changes.</div>
        </Modal>
      )}
    </div>
  )
}
