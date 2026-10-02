/**
 * Shared pieces of the control centre.
 *
 * Small formatting helpers, a section header that states what a screen is for,
 * and a data-loading hook that gives every panel the same loading, error and
 * refresh behaviour. Kept in one module because each is a few lines and they
 * are used by nearly every section.
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { Permission } from '../../lib/rbac'
import { roleHas, type AdminRole } from '../../lib/rbac'
import { Alert, Eyebrow, Spinner } from '../../ui/primitives'

/* ------------------------------------------------------------ formatting --- */

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`
}

export function formatPercent(value: number, digits = 1): string {
  if (!Number.isFinite(value)) return '—'
  return `${value.toFixed(digits)}%`
}

/** Compact age, e.g. `4m ago`, `2h ago`, `3d ago`. */
export function formatAge(instant: string | null, now = Date.now()): string {
  if (!instant) return '—'
  const at = Date.parse(instant)
  if (!Number.isFinite(at)) return '—'
  const seconds = Math.round((now - at) / 1000)
  if (seconds < 0) return 'in the future'
  if (seconds < 45) return `${seconds}s ago`
  if (seconds < 5400) return `${Math.round(seconds / 60)}m ago`
  if (seconds < 172_800) return `${Math.round(seconds / 3600)}h ago`
  return `${Math.round(seconds / 86_400)}d ago`
}

/** Local wall-clock rendering, for operators reading a log on their own machine. */
export function formatInstant(instant: string | null): string {
  if (!instant) return '—'
  const at = Date.parse(instant)
  if (!Number.isFinite(at)) return instant
  return new Date(at).toISOString().replace('T', ' ').slice(0, 19)
}

export function formatUptime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—'
  const days = Math.floor(seconds / 86_400)
  const hours = Math.floor((seconds % 86_400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m ${seconds % 60}s`
}

/** `12 chars` / `1.2 KB`, used to keep long identifiers from breaking a table. */
export function truncate(value: string, length = 12): string {
  if (!value) return '—'
  return value.length <= length ? value : `${value.slice(0, length)}…`
}

/* ---------------------------------------------------------------- layout --- */

export function SectionHeader({
  eyebrow,
  title,
  description,
  actions,
  meta,
}: {
  /** The small uppercase label naming the surface. Blue, as everywhere else. */
  eyebrow?: string
  title: string
  description: string
  actions?: ReactNode
  meta?: ReactNode
}) {
  return (
    <div className="control-head">
      <div className="control-head-text">
        {eyebrow && <Eyebrow tone="blue">{eyebrow}</Eyebrow>}
        <h1>{title}</h1>
        <p className="page-sub">{description}</p>
        {meta && <div className="control-head-meta">{meta}</div>}
      </div>
      {actions && <div className="control-head-actions">{actions}</div>}
    </div>
  )
}

export function ControlCard({
  eyebrow,
  title,
  description,
  actions,
  children,
  tone,
  className = '',
}: {
  eyebrow?: string
  title?: string
  description?: string
  actions?: ReactNode
  children: ReactNode
  tone?: 'default' | 'warn' | 'danger' | 'ok'
  className?: string
}) {
  return (
    <section className={`control-card${tone && tone !== 'default' ? ` control-card-${tone}` : ''} ${className}`}>
      {(title || actions) && (
        <header className="control-card-head">
          <div>
            {eyebrow && <Eyebrow>{eyebrow}</Eyebrow>}
            {title && <h2 style={eyebrow ? { marginTop: 9 } : undefined}>{title}</h2>}
            {description && <p>{description}</p>}
          </div>
          {actions && <div className="control-card-actions">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  )
}

/**
 * Renders children only when the signed-in role holds the permission.
 *
 * Purely cosmetic: it keeps the interface honest about what the account can do.
 * The server independently refuses anything unauthorised, so removing this would
 * not open a hole.
 */
export function Can({ role, permission, children, fallback = null }: {
  role: AdminRole
  permission: Permission
  children: ReactNode
  fallback?: ReactNode
}) {
  return <>{roleHas(role, permission) ? children : fallback}</>
}

export function Denied({ what }: { what: string }) {
  return (
    <Alert tone="warn">
      Your role does not grant access to {what}. The server enforces this independently of the interface, so the
      request would be refused even if it were shown.
    </Alert>
  )
}

/* ------------------------------------------------------------ data loading --- */

export type Loaded<T> = {
  data: T | null
  error: string | null
  loading: boolean
  reload: () => void
}

/**
 * Load an authorised read, with the loading and error states every panel needs.
 *
 * `reload` is returned rather than a bare refetch so a mutation can refresh the
 * view it changed without the panel remounting.
 */
export function useControlData<T>(load: () => Promise<{ ok: true; value: T } | { ok: false; error: string }>, deps: unknown[] = []): Loaded<T> {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [nonce, setNonce] = useState(0)

  // `load` is intentionally not a dependency: callers pass an inline closure and
  // `deps` is the explicit list of things that should trigger a refetch.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const runner = useCallback(load, deps)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void runner().then((result) => {
      if (cancelled) return
      setLoading(false)
      if (result.ok) {
        setData(result.value)
        setError(null)
      } else {
        setError(result.error)
      }
    })
    return () => {
      cancelled = true
    }
  }, [runner, nonce])

  return { data, error, loading, reload: () => setNonce((value) => value + 1) }
}

export function LoadingPanel({ label }: { label: string }) {
  return <Spinner label={label} />
}
