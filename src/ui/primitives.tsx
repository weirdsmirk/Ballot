/**
 * Small shared UI building blocks used by both the voter and admin interfaces.
 *
 * Everything here is a composition of the design system's atoms: the eyebrow
 * label, the tinted icon tile, the pill, the card. Keeping them in one module is
 * what stops the same visual idea from being re-drawn slightly differently on
 * each screen.
 */

import { useEffect, useState, type ReactNode } from 'react'
import { STATUS_LABELS } from '../lib/lifecycle'
import { formatCountdown, formatDuration } from '../lib/time'
import type { ElectionStatus } from '../lib/types'
import { Icon, type IconName } from './Icon'

/* ------------------------------------------------------------- structure --- */

/** The small uppercase monospace label that names a region, list or field. */
export function Eyebrow({
  children,
  tone = 'muted',
  className = '',
}: {
  children: ReactNode
  tone?: 'muted' | 'blue'
  className?: string
}) {
  return (
    <span className={`eyebrow${tone === 'blue' ? ' eyebrow-blue' : ''} ${className}`.trim()}>{children}</span>
  )
}

/** A tinted rounded square holding a single icon. */
export function IconTile({
  icon,
  tone = 'blue',
  size = 'md',
}: {
  icon: IconName
  tone?: 'blue' | 'green' | 'amber' | 'orange' | 'red' | 'slate' | 'navy' | 'white' | 'white-line'
  size?: 'sm' | 'md' | 'lg' | 'xl'
}) {
  const sizeClass = size === 'md' ? '' : ` icon-tile-${size}`
  return (
    <span className={`icon-tile tile-${tone}${sizeClass}`}>
      <Icon name={icon} />
    </span>
  )
}

export function StatusBadge({ status, effective }: { status: ElectionStatus; effective?: ElectionStatus }) {
  const shown = effective ?? status
  const drifted = effective !== undefined && effective !== status
  return (
    <span className={`status-badge status-${shown}`}>
      <span className="status-dot" aria-hidden="true" />
      {STATUS_LABELS[shown]}
      {drifted && <span className="status-drift" title="The schedule has moved this election past its stored state">auto</span>}
    </span>
  )
}

/**
 * Live countdown to an absolute instant.
 *
 * The caller passes the target as an epoch timestamp and this component derives
 * the remaining time from the server-corrected clock on each tick. Taking an
 * absolute instant rather than a duration is what prevents the classic bug of
 * subtracting elapsed time from an already-relative value.
 */
export function Countdown({
  targetAt,
  serverOffsetMs,
  prefix,
}: {
  targetAt: number | null
  serverOffsetMs: number
  prefix?: string
}) {
  const compute = () => (targetAt === null ? null : targetAt - (Date.now() + serverOffsetMs))
  const [remaining, setRemaining] = useState<number | null>(compute)

  useEffect(() => {
    setRemaining(compute())
    if (targetAt === null) return
    const interval = setInterval(() => setRemaining(compute()), 1000)
    return () => clearInterval(interval)
  }, [targetAt, serverOffsetMs])

  if (remaining === null) return null
  if (remaining <= 0) {
    return <span className="countdown countdown-done">{prefix ? `${prefix}now` : 'now'}</span>
  }
  return (
    <span className="countdown">
      {prefix && <span className="countdown-prefix">{prefix}</span>}
      <span className="countdown-value">{formatCountdown(remaining)}</span>
      <span className="countdown-unit">({formatDuration(remaining)})</span>
    </span>
  )
}

/* ------------------------------------------------------------------ forms --- */

export function Field({
  label,
  hint,
  error,
  children,
  htmlFor,
}: {
  label: string
  hint?: string
  error?: string | null
  children: ReactNode
  htmlFor?: string
}) {
  return (
    <div className={`form-group${error ? ' has-error' : ''}`}>
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {hint && !error && <p className="field-hint">{hint}</p>}
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

/** The switch used for every opt-in, defaulting to the safer state. */
export function Switch({
  checked,
  onChange,
  label,
  detail,
  disabled,
}: {
  checked: boolean
  onChange: (value: boolean) => void
  label: string
  detail?: string
  disabled?: boolean
}) {
  return (
    <label className="switch" style={disabled ? { opacity: 0.5, cursor: 'not-allowed' } : undefined}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="switch-track" aria-hidden="true" />
      <span className="switch-text">
        <strong>{label}</strong>
        {detail && <span>{detail}</span>}
      </span>
    </label>
  )
}

/** The amber strip that names a demo-only affordance. Never used for anything else. */
export function DemoNote({ children }: { children: ReactNode }) {
  return (
    <div className="demo-note">
      <Icon name="sparkle" />
      <span>{children}</span>
    </div>
  )
}

export function Alert({ tone = 'info', children }: { tone?: 'info' | 'warn' | 'error' | 'success'; children: ReactNode }) {
  return (
    <div className={`alert alert-${tone}`} role={tone === 'error' ? 'alert' : undefined}>
      {children}
    </div>
  )
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="app-loading">
      <div className="loading-spinner" />
      {label && <p>{label}</p>}
    </div>
  )
}

/* ------------------------------------------------------------ empty state --- */

/**
 * The empty state.
 *
 * One composition everywhere a screen has nothing to show: a tinted tile, a
 * sentence about what happened, and — where there is one — the way forward.
 * The tile is soft blue rather than a warning colour, because an empty list is
 * a normal state, not a failure.
 */
export function EmptyState({
  title,
  icon = 'shield-check',
  children,
  action,
  compact,
}: {
  title: string
  icon?: IconName
  children?: ReactNode
  action?: ReactNode
  compact?: boolean
}) {
  return (
    <div className={`empty-state${compact ? ' empty-state-inline' : ''}`}>
      <IconTile icon={icon} size="lg" />
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action && <div className="empty-state-actions">{action}</div>}
    </div>
  )
}

/* ------------------------------------------------------------------- stats --- */

/** A figure with its label, its qualifier and — where it helps — an icon. */
export function Stat({
  label,
  value,
  sub,
  icon,
  tone,
}: {
  label: string
  value: ReactNode
  sub?: string
  icon?: IconName
  tone?: 'blue' | 'green' | 'amber' | 'orange' | 'red'
}) {
  const subClass = tone === 'green' ? ' stat-sub-good' : tone === 'amber' ? ' stat-sub-warn' : ''
  return (
    <div className="stat-card">
      {icon && (
        <div className="stat-card-top">
          <IconTile icon={icon} tone={tone ?? 'blue'} size="sm" />
          <span className="stat-label">{label}</span>
        </div>
      )}
      {!icon && <span className="stat-label">{label}</span>}
      <div className="stat-value">{value}</div>
      {sub && <div className={`stat-sub${subClass}`}>{sub}</div>}
    </div>
  )
}

/* ------------------------------------------------------------------ modals --- */

export function Modal({
  title,
  onClose,
  children,
  footer,
  wide,
}: {
  title: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  wide?: boolean
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="modal-overlay active"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className={`modal-content${wide ? ' modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <button className="modal-close" type="button" aria-label="Close" onClick={onClose}>
          <Icon name="close" />
        </button>
        <h2>{title}</h2>
        {children}
        {footer && <div className="modal-actions">{footer}</div>}
      </div>
    </div>
  )
}
