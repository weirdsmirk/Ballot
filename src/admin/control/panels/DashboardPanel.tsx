/**
 * Operations dashboard.
 *
 * The first screen an administrator sees, so it answers the questions a returning
 * operator actually has, in priority order: is anything wrong, what is running
 * right now, how many people have voted, and what has been happening.
 *
 * Every number here comes from one authorised `control.dashboard` read, so the
 * screen cannot show a mixture of states from different moments. Where a figure
 * is withheld — a result that is not yet publishable, for instance — it says so
 * rather than showing a number that would mislead.
 *
 * Composition, top to bottom: a dated greeting, four figures, the elections in
 * play as cards, then a two-column base of the audit stream and a single dark
 * card of things that need doing. The dark card is the only dark surface inside
 * the working area, which is what makes it read as an interruption rather than
 * another panel.
 */

import { useEffect } from 'react'
import { controlApi } from '../../../lib/api'
import { ELECTION_TYPE_LABELS, type ElectionType } from '../../../lib/types'
import { formatInZoneShort } from '../../../lib/time'
import { Eyebrow, StatusBadge } from '../../../ui/primitives'
import { Icon, type IconName } from '../../../ui/Icon'
import { ControlCard, SectionHeader, formatAge, formatBytes, formatPercent, formatUptime, useControlData } from '../shared'
import type { AlertCounts } from '../../AdminApp'
import type { DashboardData } from '../../../lib/adminTypes'

export function DashboardPanel({ onNavigate, canAccess, serverOffsetMs, onOpenWorkspace, onAlertCounts }: {
  onNavigate: (section: string, electionId?: string) => void
  /** Whether the signed-in role may open a section, so no dead links are offered. */
  canAccess: (section: string) => boolean
  serverOffsetMs: number
  /** Opens an election's workspace directly, which is what an election card means. */
  onOpenWorkspace: (electionId: string) => void
  onAlertCounts?: (counts: AlertCounts) => void
}) {
  const { data, error, loading, reload } = useControlData<DashboardData>(() => controlApi.dashboard())

  // Lift the alert count into the rail.
  //
  // Reported from an effect, above the loading and error returns, and computed
  // from whatever the last read produced. Calling the parent's setter during
  // render would be a setState-in-render loop; doing it after an early return
  // would be a change in hook order. Both are avoided by doing it here, once,
  // unconditionally.
  const openAlerts = data
    ? data.security.unacknowledged_critical + data.security.unacknowledged_warning
    : 0
  useEffect(() => {
    onAlertCounts?.({ security: openAlerts })
  }, [onAlertCounts, openAlerts])

  if (loading && !data) return <div className="control-body"><p className="control-loading">Loading the operations dashboard…</p></div>
  if (error && !data) return <div className="control-body"><div className="alert alert-error" role="alert">{error}</div></div>
  if (!data) return null

  const { totals, health, security, backup, approvals } = data
  const running = data.elections.filter((row) => row.effective_status === 'open')
  const live = data.elections.filter((row) => row.effective_status !== 'archived')

  // One funnel across everything currently in play, which is the number an
  // election officer is actually judged on during a poll.
  const funnel = live.reduce(
    (sum, row) => ({
      registered: sum.registered + row.funnel.registered,
      eligible: sum.eligible + row.funnel.eligible,
      verified: sum.verified + row.funnel.verified,
      voted: sum.voted + row.funnel.voted,
    }),
    { registered: 0, eligible: 0, verified: 0, voted: 0 },
  )
  const turnout = funnel.eligible > 0 ? (funnel.voted / funnel.eligible) * 100 : 0

  const attention = attentionItems(data)

  const firstName = data.viewer.display_name.split(' ')[0] || data.viewer.display_name

  return (
    <div className="control-body">
      <SectionHeader
        eyebrow={longDate(data.server_time, serverOffsetMs)}
        title={`Good ${greeting()}, ${firstName}.`}
        description="Your elections are healthy. Here's what needs your attention."
        actions={
          canAccess('elections') ? (
            <button type="button" className="btn-primary" onClick={() => onNavigate('elections')}>
              <Icon name="plus" />
              Create election
            </button>
          ) : (
            <button type="button" className="btn-outline" onClick={reload}>
              <Icon name="refresh" />
              Refresh
            </button>
          )
        }
      />

      {error && <div className="alert alert-error" role="alert">{error}</div>}

      {/* Headline counters: the state of the platform right now. */}
      <div className="kpi-row" style={{ marginBottom: 32 }}>
        <Kpi
          icon="activity"
          tone="green"
          label="Active elections"
          value={totals.running}
          sub={totals.running === 1 ? '1 accepting ballots' : `${totals.running} accepting ballots`}
        />
        <Kpi icon="users" tone="blue" label="Registered voters" value={funnel.registered.toLocaleString()} sub="Across all elections" />
        <Kpi
          icon="trend"
          tone="orange"
          label="Average turnout"
          value={formatPercent(turnout)}
          sub={`${funnel.verified.toLocaleString()} identities verified`}
        />
        <Kpi
          icon="warning"
          tone="amber"
          label="Open alerts"
          value={openAlerts}
          sub={openAlerts > 0 ? 'Review recommended' : 'Nothing outstanding'}
          alert={openAlerts > 0}
        />
      </div>

      {attention.length > 0 && (
        <div className="control-head" style={{ marginBottom: 16 }}>
          <div className="control-head-text">
            <Eyebrow tone="blue">Live workspace</Eyebrow>
            <h1 className="card-title" style={{ fontSize: 20 }}>Your elections</h1>
          </div>
        </div>
      )}

      <div className="control-grid" style={{ marginBottom: 22 }}>
        {live.length === 0 ? (
          <ControlCard>
            <p className="control-muted">No elections exist yet. Create one to get started.</p>
          </ControlCard>
        ) : (
          <div className="election-grid election-grid-wide">
            {live.map((row) => (
              <ElectionTile key={row.id} row={row} onOpen={() => onOpenWorkspace(row.id)} />
            ))}
          </div>
        )}
      </div>

      <div className="control-grid control-grid-2-1">
        <ControlCard eyebrow="Recent activity" title="Audit stream" actions={
          <button type="button" className="btn-icon btn-icon-sm" aria-label="Open the full audit log" onClick={() => onNavigate('audit')}>
            <Icon name="arrow-right" />
          </button>
        }>
          {data.recent_activity.length === 0 ? (
            <p className="control-muted">Nothing recorded yet.</p>
          ) : (
            <ol className="activity-list">
              {data.recent_activity.slice(0, 6).map((event) => (
                <li key={event.id} className="activity-row">
                  <span className={`activity-result activity-${event.result}`} aria-hidden="true">
                    <Icon name={event.result === 'success' ? 'check' : 'close'} strokeWidth={2.5} />
                  </span>
                  <div className="activity-body">
                    <p className="activity-summary">{event.summary}</p>
                    <p className="activity-meta">
                      <span>{event.actor_label || event.actor_type}</span>
                      <code>{event.action}</code>
                      <span title={event.created_at}>{formatAge(event.created_at)}</span>
                      {event.result !== 'success' && <span className="activity-flag">{event.result}</span>}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </ControlCard>

        <div className="control-stack">
          <div className="attention-card">
            <div className="attention-card-head">
              <div>
                <Eyebrow tone="muted" className="eyebrow-navy">Needs attention</Eyebrow>
                <h2 style={{ marginTop: 8 }}>Keep things moving</h2>
              </div>
              <span className="icon-tile tile-white-line">
                <Icon name="sparkle" />
              </span>
            </div>

            {attention.length === 0 ? (
              <p style={{ fontSize: 13, color: 'var(--navy-text)', padding: '14px 0 4px' }}>
                Nothing needs you right now. Every election is on schedule and no alert is outstanding.
              </p>
            ) : (
              <ul className="attention-list">
                {attention.slice(0, 4).map((item, index) => (
                  <li key={item.text} className={`attention attention-${item.tone}`}>
                    <span className="attention-index">{String(index + 1).padStart(2, '0')}</span>
                    <span className="attention-text">
                      <strong>{item.title}</strong>
                      <span>{item.text}</span>
                    </span>
                    {item.section && canAccess(item.section) && (
                      <button type="button" onClick={() => onNavigate(item.section as string)} aria-label={`Open ${item.title}`}>
                        <Icon name="arrow-right" />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <ControlCard
            eyebrow="Assurance"
            title="Security"
            description="Sign-in activity and anything an operator should review."
            tone={security.unacknowledged_critical > 0 ? 'danger' : security.unacknowledged_warning > 0 ? 'warn' : 'default'}
            actions={
              canAccess('security') ? (
                <button type="button" className="btn-outline" onClick={() => onNavigate('security')}>
                  Open
                </button>
              ) : undefined
            }
          >
            <div className="mini-stats">
              <MiniStat label="Critical alerts" value={security.unacknowledged_critical} tone={security.unacknowledged_critical > 0 ? 'danger' : 'ok'} />
              <MiniStat label="Warnings" value={security.unacknowledged_warning} tone={security.unacknowledged_warning > 0 ? 'warn' : 'ok'} />
              <MiniStat label="Failed sign-ins (24h)" value={security.failed_logins_24h} tone={security.failed_logins_24h > 0 ? 'warn' : 'ok'} />
              <MiniStat label="Active sessions" value={security.active_sessions} />
              <MiniStat label="Locked accounts" value={security.locked_accounts} tone={security.locked_accounts > 0 ? 'warn' : 'ok'} />
              <MiniStat label="Without MFA" value={security.admins_without_mfa} tone={security.admins_without_mfa > 0 ? 'warn' : 'ok'} />
            </div>
            {security.recent.length > 0 && (
              <ul className="security-peek" style={{ marginTop: 14 }}>
                {security.recent.slice(0, 3).map((event) => (
                  <li key={event.id} className="security-peek-row">
                    <span className={`severity-dot severity-${event.severity}`} aria-hidden="true" />
                    <span className="security-peek-text">{event.summary}</span>
                    <span className="cell-secondary">{formatAge(event.created_at)}</span>
                  </li>
                ))}
              </ul>
            )}
          </ControlCard>

          <ControlCard
            eyebrow="Durability"
            title="Backups"
            description={backup.latest ? `Newest archive is ${formatAge(backup.latest.created_at)}.` : 'No archive has been taken yet.'}
            tone={backup.stale ? 'warn' : 'default'}
            actions={
              canAccess('backups') ? (
                <button type="button" className="btn-outline" onClick={() => onNavigate('backups')}>
                  Manage
                </button>
              ) : undefined
            }
          >
            <div className="mini-stats">
              <MiniStat label="Archives" value={backup.count} />
              <MiniStat label="Total size" value={formatBytes(backup.total_size_bytes)} />
              <MiniStat
                label="Newest age"
                value={backup.newest_age_seconds === null ? 'none' : formatUptime(backup.newest_age_seconds)}
                tone={backup.stale ? 'warn' : 'ok'}
              />
            </div>
            {health.issues.length > 0 && (
              <ul className="health-issues">
                {health.issues.map((issue) => (
                  <li key={issue.message} className={`health-issue health-issue-${issue.severity}`}>
                    {issue.message}
                  </li>
                ))}
              </ul>
            )}
          </ControlCard>
        </div>
      </div>

      {approvals.length > 0 && (
        <ControlCard
          eyebrow="Second signature"
          title="Approvals awaiting a second administrator"
          description="These operations are blocked until a different administrator decides them."
          actions={
            canAccess('security') ? (
              <button type="button" className="btn-outline" onClick={() => onNavigate('security')}>
                Review
              </button>
            ) : undefined
          }
        >
          <ul className="approval-list">
            {approvals.map((approval) => (
              <li key={approval.id} className="approval-row">
                <div className="approval-row-body">
                  <p className="cell-primary">{approval.action}</p>
                  <p className="cell-secondary">
                    Requested by {approval.requested_by_label} {formatAge(approval.requested_at)} &middot;{' '}
                    <code>{approval.permission}</code>
                  </p>
                  {approval.justification && <p className="approval-justification">&ldquo;{approval.justification}&rdquo;</p>}
                </div>
                <span className={`pill pill-${approval.status === 'pending' ? 'pending' : 'draft'}`}>{approval.status}</span>
              </li>
            ))}
          </ul>
        </ControlCard>
      )}

      {running.length === 0 && totals.elections > 0 && (
        <ControlCard title="Nothing is open" tone="warn">
          <p>
            No election is currently accepting ballots. Open one from the{' '}
            <button type="button" className="link-button" onClick={() => onNavigate('elections')}>
              elections list
            </button>{' '}
            when its scheduled start time arrives.
          </p>
        </ControlCard>
      )}
    </div>
  )
}

/* ---------------------------------------------------------------- pieces --- */

function Kpi({ icon, tone, label, value, sub, alert }: {
  icon: IconName
  tone: 'blue' | 'green' | 'amber' | 'orange' | 'red'
  label: string
  value: React.ReactNode
  sub?: string
  alert?: boolean
}) {
  return (
    <div className={`kpi${alert ? ' kpi-warn' : ''}`}>
      <div className="stat-card-top">
        <span className={`icon-tile icon-tile-sm tile-${tone}`}>
          <Icon name={icon} />
        </span>
        <span className="kpi-label">{label}</span>
      </div>
      <span className="kpi-value">{value}</span>
      {sub && <span className={`kpi-sub${tone === 'green' && !alert ? ' kpi-sub-good' : ''}`}>{sub}</span>}
    </div>
  )
}

/**
 * One election, as a card.
 *
 * The card answers three questions in a fixed order — what is it, how is it
 * going, and when does it change — and the whole card is the way into the
 * election. The turnout bar sits between the numbers and the date because it is
 * the only element that shows a proportion rather than a value.
 */
function ElectionTile({ row, onOpen }: {
  row: DashboardData['elections'][number]
  onOpen: () => void
}) {
  return (
    <button type="button" className="election-card" onClick={onOpen}>
      <div className="election-card-top">
        <StatusBadge status={row.status} effective={row.effective_status} />
        <span className="roster-arrow">
          <Icon name="more" />
        </span>
      </div>
      <h2>{row.title}</h2>
      <p className="election-card-desc">
        {ELECTION_TYPE_LABELS[row.election_type as ElectionType] ?? row.election_type} · {row.candidate_count}{' '}
        {row.candidate_count === 1 ? 'candidate' : 'candidates'}
      </p>
      <div className="election-tally">
        <div>
          <Eyebrow>Turnout</Eyebrow>
          <strong>{formatPercent(row.funnel.turnout, 0)}</strong>
        </div>
        <div>
          <Eyebrow>Votes cast</Eyebrow>
          <strong>{row.funnel.voted === 0 ? '—' : row.funnel.voted.toLocaleString()}</strong>
        </div>
        <div>
          <Eyebrow>Eligible</Eyebrow>
          <strong>{row.funnel.eligible.toLocaleString()}</strong>
        </div>
      </div>
      <div className="progress">
        <div
          className={`progress-fill${row.funnel.turnout > 0 ? '' : ' progress-fill-idle'}`}
          style={{ width: `${Math.max(0, Math.min(100, row.funnel.turnout))}%` }}
        />
      </div>
      <div className="election-card-foot">
        <span className="election-card-when">
          <Icon name="clock" />
          {whenLabel(row)}
        </span>
        <span className="roster-arrow">
          <Icon name="arrow-right" />
        </span>
      </div>
    </button>
  )
}

/**
 * When this election next matters, as a single line.
 *
 * A running or scheduled poll shows the instant it changes; a closed one shows
 * when it closed; a draft has no schedule to speak of, so it says what it is.
 */
function whenLabel(row: DashboardData['elections'][number]): string {
  if (row.effective_status === 'open') return `Closes ${formatInZoneShort(row.ends_at, row.timezone)}`
  if (row.effective_status === 'scheduled') return `Opens ${formatInZoneShort(row.starts_at, row.timezone)}`
  if (row.effective_status === 'paused') return `Paused · was due to close ${formatInZoneShort(row.ends_at, row.timezone)}`
  if (row.effective_status === 'closed') return `Closed ${formatInZoneShort(row.ends_at, row.timezone)}`
  if (row.effective_status === 'certified') return `Certified ${formatInZoneShort(row.ends_at, row.timezone)}`
  if (row.effective_status === 'archived') return `Archived ${formatInZoneShort(row.ends_at, row.timezone)}`
  return 'Not scheduled yet'
}

function MiniStat({ label, value, tone }: { label: string; value: React.ReactNode; tone?: 'ok' | 'warn' | 'danger' }) {
  return (
    <div className={`mini-stat${tone ? ` mini-stat-${tone}` : ''}`}>
      <span className="mini-stat-value">{value}</span>
      <span className="mini-stat-label">{label}</span>
    </div>
  )
}

export function TurnoutMeter({ value, label }: { value: number; label?: string }) {
  const bounded = Math.max(0, Math.min(100, value))
  return (
    <div className="meter" title={`${value.toFixed(1)}% turnout`}>
      <div className="meter-track">
        <div className={`meter-fill${bounded >= 50 ? ' meter-fill-good' : bounded > 0 ? ' meter-fill-mid' : ''}`} style={{ width: `${bounded}%` }} />
      </div>
      {label && <span className="meter-label">{label}</span>}
      <span className="meter-value">{formatPercent(value)}</span>
    </div>
  )
}

/* --------------------------------------------------------------- helpers --- */

function greeting(): string {
  const hour = new Date().getHours()
  if (hour < 12) return 'morning'
  if (hour < 18) return 'afternoon'
  return 'evening'
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

/** `TUESDAY, MAY 20, 2025` — the same voice as the reference header. */
function longDate(instant: string, offsetMs: number): string {
  const at = new Date(Date.parse(instant) + offsetMs)
  if (Number.isNaN(at.getTime())) return ''
  return `${WEEKDAYS[at.getDay()].toUpperCase()}, ${MONTHS[at.getMonth()].toUpperCase()} ${at.getDate()}, ${at.getFullYear()}`
}

/**
 * Things an operator should look at before anything else.
 *
 * A plain derivation rather than a hook, so it can be called from anywhere in the
 * render without constraining the order hooks are declared in. Each item carries a
 * title as well as a sentence, because the dark card sets them as a pair: the
 * title is what gets scanned, the sentence explains why it appeared.
 */
function attentionItems(data: DashboardData) {
  const items: { tone: 'critical' | 'warning' | 'info'; title: string; text: string; section?: string }[] = []
  const { security, backup, health, approvals } = data

  if (security.unacknowledged_critical > 0) {
    items.push({
      tone: 'critical',
      title: `Review ${security.unacknowledged_critical} security alert${security.unacknowledged_critical === 1 ? '' : 's'}`,
      text: 'Unusual administrator sign-in attempts were detected.',
      section: 'security',
    })
  }
  if (security.locked_accounts > 0) {
    items.push({
      tone: 'warning',
      title: `${security.locked_accounts} account${security.locked_accounts === 1 ? '' : 's'} locked out`,
      text: 'Repeated failed sign-ins have locked an administrator account.',
      section: 'security',
    })
  }
  if (security.admins_without_mfa > 0) {
    items.push({
      tone: 'warning',
      title: 'Second factors not enrolled',
      text: `${security.admins_without_mfa} active administrator${security.admins_without_mfa === 1 ? ' has' : 's have'} no second factor.`,
      section: 'security',
    })
  }
  if (backup.stale) {
    items.push({
      tone: backup.newest_age_seconds === null ? 'warning' : 'info',
      title: backup.newest_age_seconds === null ? 'No backup has ever been taken' : 'Refresh the backup archive',
      text:
        backup.newest_age_seconds === null
          ? 'Nothing on this server is recoverable yet.'
          : `The newest backup is ${formatUptime(backup.newest_age_seconds)} old.`,
      section: 'backups',
    })
  }
  if (health.status !== 'ok') {
    for (const issue of health.issues.filter((item) => item.severity !== 'info').slice(0, 1)) {
      items.push({ tone: issue.severity === 'critical' ? 'critical' : 'warning', title: 'System health needs review', text: issue.message, section: 'settings' })
    }
  }
  if (approvals.length > 0) {
    items.push({
      tone: 'info',
      title: `${approvals.length} approval request${approvals.length === 1 ? '' : 's'} pending`,
      text: 'A second administrator is needed before these can run.',
      section: 'security',
    })
  }
  return items
}
