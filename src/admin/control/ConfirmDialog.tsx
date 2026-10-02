/**
 * Confirmation for destructive and irreversible operations.
 *
 * Two strengths, chosen by how bad a mistake is:
 *
 * - a warning dialog for a single click on a reversible action
 * - a typed confirmation for anything that destroys records, where a stray
 *   click must not be enough
 *
 * Both spell out what will happen, what will not be recoverable, and what the
 * server records. Neither is an authorisation: the server independently demands
 * elevation and audit entry for every action that can be confirmed here.
 */

import { useState, type ReactNode } from 'react'
import { Alert, Modal } from '../../ui/primitives'

export type ConfirmOptions = {
  title: string
  /** What is about to happen, in the operator's terms. */
  body: ReactNode
  confirmLabel: string
  tone?: 'default' | 'danger'
  /**
   * When set, the operator must type this exact text to enable the button. Use
   * for irreversible operations.
   */
  requireTyped?: string
  /**
   * When set, the operator must supply a reason, which is handed to the server
   * and written to the audit trail. Used where a decision needs a defensible
   * explanation, such as disqualifying an option.
   */
  reason?: { label: string; hint?: string; required?: boolean }
  /** Extra line under the body, e.g. the audit record that will be written. */
  footnote?: ReactNode
}

export function ConfirmDialog({
  options,
  busy,
  onConfirm,
  onCancel,
}: {
  options: ConfirmOptions
  busy?: boolean
  onConfirm: (reason?: string) => void
  onCancel: () => void
}) {
  const [typed, setTyped] = useState('')
  const [reason, setReason] = useState('')
  const danger = options.tone !== 'default'
  const typedOk = !options.requireTyped || typed.trim() === options.requireTyped
  const reasonOk = !options.reason?.required || reason.trim().length > 0
  const satisfied = typedOk && reasonOk

  return (
    <Modal
      title={options.title}
      onClose={onCancel}
      footer={
        <>
          <button type="button" className="btn-cancel" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className={danger ? 'btn-confirm btn-confirm-danger' : 'btn-confirm'}
            disabled={!satisfied || busy}
            onClick={() => onConfirm(reason.trim() || undefined)}
          >
            {busy ? 'Working…' : options.confirmLabel}
          </button>
        </>
      }
    >
      <div className="confirm-body">{options.body}</div>
      {danger && (
        <Alert tone="warn">
          This cannot be undone from the interface. Anything already recorded stays recorded.
        </Alert>
      )}
      {options.reason && (
        <div className="confirm-typed">
          <label className="confirm-typed-label" htmlFor="confirm-reason">
            {options.reason.label}
          </label>
          <textarea
            id="confirm-reason"
            rows={2}
            value={reason}
            maxLength={400}
            onChange={(event) => setReason(event.target.value)}
            placeholder={options.reason.hint}
          />
        </div>
      )}
      {options.requireTyped && (
        <div className="confirm-typed">
          <label className="confirm-typed-label" htmlFor="confirm-typed">
            Type <code>{options.requireTyped}</code> to continue
          </label>
          <input
            id="confirm-typed"
            className="mono"
            autoComplete="off"
            spellCheck={false}
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
          />
        </div>
      )}
      {options.footnote && <p className="preview-footnote">{options.footnote}</p>}
    </Modal>
  )
}

/**
 * Small wrapper so a panel can hold one pending confirmation at a time without
 * repeating the null checks in its render path.
 */
export function useConfirm() {
  const [options, setOptions] = useState<ConfirmOptions | null>(null)
  return {
    options,
    ask: setOptions,
    close: () => setOptions(null),
  }
}