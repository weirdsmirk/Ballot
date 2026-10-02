/**
 * Destructive operations.
 *
 * Resetting the platform and restoring from a backup are the two operations that
 * destroy real records, so they are gathered on one screen behind heavy
 * confirmation rather than scattered through the interface where they could be
 * triggered by a stray click.
 *
 * Nothing here is a shortcut. The typed phrase, the two-person approval, the
 * pre-operation snapshot and the audit entry are all enforced or performed
 * server side; this screen exists so an operator cannot perform them by accident.
 */

import { useState } from 'react'
import { controlApi } from '../../../lib/api'
import { roleHas, type AdminRole } from '../../../lib/rbac'
import { Alert } from '../../../ui/primitives'
import { ConfirmDialog, type ConfirmOptions } from '../ConfirmDialog'
import { useElevation } from '../elevation'
import { ControlCard, SectionHeader, formatInstant } from '../shared'

export function DangerPanel({ role, onChanged }: { role: AdminRole; onChanged: () => void }) {
  const canReset = roleHas(role, 'system.reset')
  const { run } = useElevation()
  const [keepAdmins, setKeepAdmins] = useState(true)
  const [confirm, setConfirm] = useState<ConfirmOptions | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const reset = async () => {
    setBusy(true)
    setError(null)
    // Dismiss the confirmation before the elevation dialog opens, so the two
    // never stack.
    setConfirm(null)
    const outcome = await run(
      {
        permission: 'system.reset',
        twoPerson: {
          permission: 'system.reset',
          action: 'system.reset',
          resource: 'platform',
          payloadSummary: `Destroy every election, ballot, voter roll entry and audit record on this server${
            keepAdmins ? ', keeping administrator accounts' : ', including all administrator accounts'
          }.`,
          justification: '',
        },
      },
      (approvalToken) => controlApi.resetSystem(keepAdmins, approvalToken),
    )
    setBusy(false)
    if (outcome.status === 'failed') {
      setError(outcome.error)
      return
    }
    if (outcome.status === 'cancelled') return
    setNotice(
      `Platform reset complete. A safety archive (#${outcome.value.safetyBackupId}) was taken first. Reload to see the empty platform.`,
    )
    onChanged()
  }

  return (
    <div className="control-body">
      <SectionHeader
        eyebrow="Admin workspace"
        title="Destructive operations"
        description="Operations that destroy recorded data. Each one takes an automatic archive first, requires a second administrator's approval, and is written to the audit trail."
      />

      {notice && <Alert tone="success">{notice}</Alert>}
      {error && <Alert tone="error">{error}</Alert>}

      <ControlCard
        eyebrow="Irreversible"
        title="Reset all platform data"
        description="Returns the platform to a freshly installed state."
        tone="danger"
      >
        <Alert tone="error">
          This destroys every election, every ballot cast, every voter roll entry and the entire audit trail. It cannot
          be undone from the interface.
        </Alert>

        <ul className="danger-list">
          <li>All elections, their schedules, rules and eligibility configuration are deleted.</li>
          <li>All candidates and every ballot cast are deleted.</li>
          <li>All voter roll entries, including contact details, are deleted.</li>
          <li>The audit trail is deleted, so this reset cannot itself be reviewed afterwards.</li>
          <li>
            {keepAdmins
              ? 'Administrator accounts, their sessions and platform settings are kept, so you stay signed in.'
              : 'Administrator accounts and sessions are also deleted, which signs everyone out and requires a new first account.'}
          </li>
        </ul>

        <label className="checkbox">
          <input
            type="checkbox"
            checked={keepAdmins}
            disabled={!canReset}
            onChange={(event) => setKeepAdmins(event.target.checked)}
          />
          Keep administrator accounts and platform settings
        </label>

        {canReset ? (
          <button
            type="button"
            className="btn-danger"
            disabled={busy}
            onClick={() =>
              setConfirm({
                title: 'Reset all platform data?',
                confirmLabel: 'Reset the platform',
                tone: 'danger',
                requireTyped: 'RESET',
                body: (
                  <>
                    <p>
                      <strong>Every election, ballot, voter and audit record on this server will be permanently
                      destroyed.</strong>
                    </p>
                    <p>
                      A full archive is taken immediately before the reset, so this is technically recoverable by an
                      administrator who still has access afterwards &mdash; but only if they act on it.
                    </p>
                    {!keepAdmins && (
                      <p>
                        Administrator accounts will be deleted too. You will be signed out and the server will ask
                        someone to create the first account again.
                      </p>
                    )}
                    <p className="cell-secondary">
                      Taken at {formatInstant(new Date().toISOString())} on this machine.
                    </p>
                  </>
                ),
                footnote:
                  'A reset needs a second administrator to approve it, because it removes the audit trail that would otherwise record it.',
              })
            }
          >
            Reset all platform data…
          </button>
        ) : (
          <Alert tone="warn">
            Your role does not permit a platform reset. The server refuses the request independently of this screen.
          </Alert>
        )}
      </ControlCard>

      {confirm && (
        <ConfirmDialog
          options={confirm}
          busy={busy}
          onCancel={() => setConfirm(null)}
          onConfirm={() => void reset()}
        />
      )}
    </div>
  )
}
