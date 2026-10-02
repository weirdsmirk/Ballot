/**
 * Step-up elevation for critical operations.
 *
 * A role permission answers "may this account ever do this". Elevation answers
 * "is this account, right now, still the one that should". The server decides
 * which is required (`src/lib/rbac.ts`) and refuses the action when it is not
 * satisfied; this module is the dialog that lets an operator satisfy it, and
 * then retries the original intent unchanged.
 *
 * Three steps are supported:
 *
 * - `reauth`     re-enter the password. The server stamps the session, and the
 *                action is retried with the same body.
 * - `mfa`        present a second factor against the already-open session.
 * - `two_person` open an approval request, wait for a *different* administrator
 *                to decide it, then retry carrying the approval token.
 *
 * Nothing here grants access. Every dialog only calls endpoints that re-check the
 * same session, role and approval the original call would have needed, so the
 * flow cannot be used to obtain a permission the account does not hold.
 */

import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react'
import { authApi, controlApi, type TwoPersonRequest } from '../../lib/api'
import { elevationFor, type Permission } from '../../lib/rbac'
import type { ActionResult } from '../../lib/types'
import { Alert, Field, Modal } from '../../ui/primitives'

/** What the caller wants to do, and what the server said it needs first. */
export type ElevationSpec = {
  permission: Permission
  /** Only meaningful for `two_person`: what the second administrator approves. */
  twoPerson?: TwoPersonRequest
}

type Attempt<T> = (approvalToken?: string) => Promise<ActionResult<T>>

export type ElevationOutcome<T> =
  | { status: 'done'; value: T }
  | { status: 'cancelled' }
  | { status: 'failed'; error: string; code: string }

/** A paused action waiting for the operator to prove themselves. */
type Job = {
  spec: ElevationSpec
  attempt: Attempt<unknown>
  settle: (outcome: ElevationOutcome<unknown>) => void
  step: 'reauth' | 'mfa' | 'two_person'
  reason: string
  approvalId: number | null
}

type ElevationContextValue = {
  /**
   * Run an action that may demand elevation, transparently satisfying it.
   *
   * Resolves once the action has actually run, or with `cancelled` if the
   * operator backed out. Callers therefore do not need to know in advance which
   * of their actions are sensitive.
   */
  run: <T>(spec: ElevationSpec, attempt: Attempt<T>) => Promise<ElevationOutcome<T>>
  busy: boolean
}

const ElevationContext = createContext<ElevationContextValue | null>(null)

export function ElevationProvider({ children }: { children: ReactNode }) {
  const [job, setJob] = useState<Job | null>(null)
  const [busy, setBusy] = useState(false)
  // Kept in a ref as well so `retry` can read the current job without the
  // dialogs having to be handed a fresh closure on every render.
  const current = useRef<Job | null>(null)
  current.current = job

  const attemptOnce = useCallback(async <T,>(fn: Attempt<T>): Promise<ActionResult<T>> => {
    setBusy(true)
    try {
      return await fn()
    } finally {
      setBusy(false)
    }
  }, [])

  const retry = useCallback(
    async (token?: string) => {
      const active = current.current
      if (!active) return
      const result = await attemptOnce(() => active.attempt(token))
      if (result.ok) {
        setJob(null)
        active.settle({ status: 'done', value: result.value })
        return
      }
      if (!result.elevation) {
        setJob(null)
        active.settle({ status: 'failed', error: result.error, code: result.code })
        return
      }
      // Still refused after satisfying a step. Refresh the explanation and stay
      // open rather than silently closing on a request the server still denies.
      setJob({ ...active, reason: result.reason ?? active.reason })
    },
    [attemptOnce],
  )

  const run = useCallback(
    async <T,>(spec: ElevationSpec, attempt: Attempt<T>): Promise<ElevationOutcome<T>> => {
      const result = await attemptOnce(() => attempt())
      if (result.ok) return { status: 'done', value: result.value }
      if (!result.elevation) return { status: 'failed', error: result.error, code: result.code }

      return new Promise<ElevationOutcome<T>>((resolve) => {
        setJob({
          spec,
          attempt: attempt as Attempt<unknown>,
          settle: resolve as (outcome: ElevationOutcome<unknown>) => void,
          step: result.elevation as Job['step'],
          reason: result.reason ?? elevationFor(spec.permission).reason,
          approvalId: null,
        })
      })
    },
    [attemptOnce],
  )

  const cancel = useCallback(() => {
    const active = current.current
    setJob(null)
    active?.settle({ status: 'cancelled' })
  }, [])

  const value = useMemo(() => ({ run, busy }), [run, busy])

  return (
    <ElevationContext.Provider value={value}>
      {children}
      {job && <ElevationDialog job={job} onRetry={retry} onCancel={cancel} onJobChange={setJob} />}
    </ElevationContext.Provider>
  )
}

export function useElevation(): ElevationContextValue {
  const context = useContext(ElevationContext)
  if (!context) throw new Error('useElevation must be used inside an ElevationProvider')
  return context
}

/** The dialog for whichever step is outstanding. */
function ElevationDialog({
  job,
  onRetry,
  onCancel,
  onJobChange,
}: {
  job: Job
  onRetry: (token?: string) => void
  onCancel: () => void
  onJobChange: (job: Job) => void
}) {
  if (job.step === 'two_person') {
    return <TwoPersonDialog job={job} onRetry={onRetry} onCancel={onCancel} onJobChange={onJobChange} />
  }
  return <CredentialDialog job={job} onRetry={onRetry} onCancel={onCancel} />
}

/**
 * Re-authentication or a second factor: a short credential form.
 *
 * The form is the only thing standing between the click and the action, so it
 * states plainly what is being authorised and why.
 */
function CredentialDialog({
  job,
  onRetry,
  onCancel,
}: {
  job: Job
  onRetry: (token?: string) => void
  onCancel: () => void
}) {
  const isReauth = job.step === 'reauth'
  const [secret, setSecret] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    const result = isReauth ? await authApi.reauthenticate(secret) : await authApi.mfaStepUp(secret)
    setBusy(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    setSecret('')
    onRetry()
  }

  return (
    <Modal
      title={isReauth ? 'Confirm it is you' : 'Enter your verification code'}
      onClose={onCancel}
      footer={
        <>
          <button type="button" className="btn-cancel" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" form="elevation-form" className="btn-confirm" disabled={busy}>
            {busy ? 'Verifying…' : 'Authorise'}
          </button>
        </>
      }
    >
      <form id="elevation-form" onSubmit={submit}>
        <ElevationReason permission={job.spec.permission} reason={job.reason} step={job.step} />
        {error && <Alert tone="error">{error}</Alert>}
        <Field
          label={isReauth ? 'Your password' : 'Authenticator or recovery code'}
          htmlFor="elevation-secret"
          hint={
            isReauth
              ? 'A successful check stays valid for five minutes, so a group of related actions does not each ask again.'
              : 'A six digit code from your authenticator, or one unused recovery code.'
          }
        >
          <input
            id="elevation-secret"
            type="password"
            autoFocus
            autoComplete={isReauth ? 'current-password' : 'one-time-code'}
            inputMode={isReauth ? 'text' : 'numeric'}
            value={secret}
            onChange={(event) => setSecret(event.target.value)}
            required
          />
        </Field>
      </form>
    </Modal>
  )
}

/**
 * Two-person approval: the operator cannot satisfy this alone.
 *
 * The dialog therefore becomes a request that another administrator answers.
 * Nothing is executed until an approval exists and the action is retried with
 * the token that approval carries.
 */
function TwoPersonDialog({
  job,
  onRetry,
  onCancel,
  onJobChange,
}: {
  job: Job
  onRetry: (token?: string) => void
  onCancel: () => void
  onJobChange: (job: Job) => void
}) {
  const [justification, setJustification] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [checking, setChecking] = useState(false)

  const request = job.spec.twoPerson

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (justification.trim().length < 10) {
      setError('Explain why this is necessary. The approver reads this text.')
      return
    }
    setBusy(true)
    setError(null)
    const created = await controlApi.requestApproval({
      permission: job.spec.permission,
      action: request?.action ?? job.spec.permission,
      resource: request?.resource ?? '',
      electionId: request?.electionId ?? null,
      payloadSummary: request?.payloadSummary ?? '',
      payload: request?.payload,
      justification: justification.trim(),
    })
    setBusy(false)
    if (!created.ok) {
      setError(created.error)
      return
    }
    onJobChange({ ...job, approvalId: created.value.approval.id })
  }

  const check = async () => {
    if (job.approvalId === null) return
    setChecking(true)
    setError(null)
    const listed = await controlApi.approvals('all')
    setChecking(false)
    if (!listed.ok) {
      setError(listed.error)
      return
    }
    const approval = listed.value.approvals.find((item) => item.id === job.approvalId)
    if (!approval) {
      setError('That approval request no longer exists.')
      return
    }
    if (approval.status === 'approved') {
      onRetry(approval.token)
      return
    }
    if (approval.status === 'rejected' || approval.status === 'expired') {
      setError(`This request was ${approval.status}. Nothing was changed.`)
    }
  }

  if (job.approvalId !== null) {
    return (
      <Modal
        title="Waiting for a second administrator"
        onClose={onCancel}
        footer={
          <>
            <button type="button" className="btn-cancel" onClick={onCancel}>
              Close
            </button>
            <button type="button" className="btn-confirm" disabled={checking} onClick={() => void check()}>
              {checking ? 'Checking…' : 'Check for approval'}
            </button>
          </>
        }
      >
        <div className="approval-waiting">
          <span className="approval-waiting-spinner" aria-hidden="true" />
          <div>
            <p className="approval-waiting-title">Request #{job.approvalId} is pending</p>
            <p className="approval-waiting-detail">
              A different administrator must approve it. You cannot approve your own request. The request expires 30
              minutes after it was raised.
            </p>
          </div>
        </div>
        {error && <Alert tone="error">{error}</Alert>}
        <p className="preview-footnote">
          Another signed-in administrator can find it under <strong>Security &rarr; Approvals</strong>.
        </p>
      </Modal>
    )
  }

  return (
    <Modal
      title="A second administrator must approve this"
      onClose={onCancel}
      footer={
        <>
          <button type="button" className="btn-cancel" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" form="approval-form" className="btn-confirm" disabled={busy}>
            {busy ? 'Sending…' : 'Request approval'}
          </button>
        </>
      }
    >
      <form id="approval-form" onSubmit={submit}>
        <ElevationReason permission={job.spec.permission} reason={job.reason} step="two_person" />
        {request?.payloadSummary && (
          <div className="approval-summary">
            <span className="preview-meta-label">Requested action</span>
            <p>{request.payloadSummary}</p>
          </div>
        )}
        {error && <Alert tone="error">{error}</Alert>}
        <Field
          label="Justification"
          htmlFor="approval-justification"
          hint="Recorded permanently in the audit trail and shown to the approver."
        >
          <textarea
            id="approval-justification"
            rows={3}
            autoFocus
            value={justification}
            onChange={(event) => setJustification(event.target.value)}
            maxLength={600}
            required
          />
        </Field>
      </form>
    </Modal>
  )
}

/** Shared explanation of what is about to happen and what authorises it. */
function ElevationReason({ permission, reason, step }: { permission: Permission; reason: string; step: string }) {
  return (
    <div className="elevation-reason">
      <p className="elevation-reason-text">{reason}</p>
      <p className="elevation-reason-meta">
        Requires <code>{permission}</code>
        {step === 'two_person' ? ' · two-person control' : ''}
      </p>
    </div>
  )
}
