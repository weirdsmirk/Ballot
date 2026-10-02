/**
 * The three figures and the two panels that sit at the top of an election's
 * overview: turnout over time, and the readiness checklist.
 *
 * Turnout is drawn from the audit trail rather than from a stored series. Each
 * `vote_cast` entry is one ballot and carries a timestamp, so the cumulative
 * curve can be reconstructed exactly from what the server already records —
 * which means the chart cannot disagree with the audit log an auditor would read
 * beside it.
 *
 * The read is capped at the server's page limit. When a poll has more recorded
 * ballots than one page holds, the card says so rather than drawing a curve that
 * stops pretending to be complete.
 */

import { useEffect, useMemo, useState } from 'react'
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { controlApi, type AuditQueryResult } from '../../lib/api'
import { formatDuration } from '../../lib/time'
import type { BallotPreview, ElectionSummary } from '../../lib/types'
import { Icon, type IconName } from '../../ui/Icon'
import { ControlCard } from '../control/shared'

/** One page of the audit log, which is the server's maximum. */
const AUDIT_PAGE = 1000

export function ElectionStats({
  election,
  preview,
  serverOffsetMs,
}: {
  election: ElectionSummary
  preview: BallotPreview
  serverOffsetMs: number
}) {
  const turnout =
    election.eligible_count > 0 ? (election.participant_count / election.eligible_count) * 100 : 0
  const closingIn = Date.parse(election.ends_at) - (Date.now() + serverOffsetMs)
  const live = election.effective_status === 'open' || election.effective_status === 'paused'

  return (
    <>
      <div className="stats-grid" style={{ marginBottom: 20 }}>
        <figure className="stat-card">
          <div className="stat-card-top">
            <span className="icon-tile icon-tile-sm tile-green">
              <Icon name="trend" />
            </span>
            <span className="stat-label">Turnout</span>
          </div>
          <div className="stat-value">{turnout.toFixed(0)}%</div>
          <div className="stat-sub stat-sub-good">
            {election.participant_count.toLocaleString()} of {election.eligible_count.toLocaleString()} eligible
          </div>
        </figure>

        <figure className="stat-card">
          <div className="stat-card-top">
            <span className="icon-tile icon-tile-sm tile-blue">
              <Icon name="ballot" />
            </span>
            <span className="stat-label">Votes cast</span>
          </div>
          <div className="stat-value">{election.ballot_count.toLocaleString()}</div>
          <div className="stat-sub">{election.approved_candidate_count} approved options</div>
        </figure>

        <figure className="stat-card">
          <div className="stat-card-top">
            <span className={`icon-tile icon-tile-sm tile-${live ? 'orange' : 'slate'}`}>
              <Icon name="clock" />
            </span>
            <span className="stat-label">Time remaining</span>
          </div>
          <div className="stat-value" style={{ fontSize: live && closingIn > 0 ? 24 : 28 }}>
            {live && closingIn > 0 ? formatDuration(closingIn) : '—'}
          </div>
          <div className="stat-sub">
            {live && closingIn > 0 ? `Closes ${shortDateTime(election.ends_at)}` : statusNote(election)}
          </div>
        </figure>
      </div>

      <div className="control-grid control-grid-2-1">
        <TurnoutChart election={election} serverOffsetMs={serverOffsetMs} />
        <ReadinessChecklist election={election} preview={preview} />
      </div>
    </>
  )
}

/* ----------------------------------------------------------------- chart --- */

/**
 * Cumulative ballots over the voting window.
 *
 * The x-axis is bucketed to whole hours between the opening and closing instants
 * so the curve is a rate read, not a list of individual timestamps. Hours with
 * no ballots still appear, because the gaps are the interesting part.
 */
function TurnoutChart({ election, serverOffsetMs }: { election: ElectionSummary; serverOffsetMs: number }) {
  const [events, setEvents] = useState<AuditQueryResult | null>(null)

  useEffect(() => {
    let cancelled = false
    void controlApi
      .audit({ electionId: election.id, action: 'vote_cast', limit: AUDIT_PAGE })
      .then((result) => {
        if (!cancelled && result.ok) setEvents(result.value)
      })
    return () => {
      cancelled = true
    }
  }, [election.id])

  const series = useMemo(() => {
    const from = Date.parse(election.starts_at)
    const to = Math.max(Date.parse(election.ends_at), Date.now() + serverOffsetMs)
    const span = to - from
    if (!Number.isFinite(span) || span <= 0) return { points: [], truncated: false }

    // Keep the axis to a readable number of columns whatever the window is.
    const bucketHours = Math.max(1, Math.ceil(span / 3_600_000 / 48))
    const bucketMs = bucketHours * 3_600_000
    const buckets = Math.max(1, Math.ceil(span / bucketMs))
    const counts = new Array<number>(buckets).fill(0)

    const stamps = (events?.rows ?? [])
      .map((row) => Date.parse(row.created_at))
      .filter((value) => Number.isFinite(value))
      .sort((a, b) => a - b)

    for (const at of stamps) {
      const index = Math.floor((at - from) / bucketMs)
      if (index >= 0 && index < buckets) counts[index] += 1
    }

    const points: { at: string; label: string; ticks: string[]; votes: number }[] = []
    let running = 0
    let lastLabel = ''
    for (let index = 0; index < buckets; index += 1) {
      running += counts[index]
      const at = new Date(from + index * bucketMs)
      const label = `${MONTHS[at.getUTCMonth()]} ${at.getUTCDate()}`
      // A tick is offered only where the day changes, so a window measured in
      // hours does not print the same date three times across the axis.
      const tick = label === lastLabel ? [] : [label]
      lastLabel = label
      points.push({
        at: at.toISOString(),
        label,
        ticks: tick,
        votes: running,
      })
    }
    const ticks = points.flatMap((point) => point.ticks)
    return { points, ticks, truncated: (events?.total ?? 0) > (events?.rows.length ?? 0) }
  }, [events, election.starts_at, election.ends_at, serverOffsetMs])

  return (
    <ControlCard
      eyebrow="Participation"
      title="Turnout over time"
      actions={
        <span className="legend">
          <span className="legend-dot" />
          Votes cast
        </span>
      }
    >
      {series.points.length === 0 ? (
        <p className="control-muted">No ballots have been recorded yet.</p>
      ) : (
        <>
          <div className="chart-frame">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={series.points} margin={{ top: 8, right: 8, bottom: 0, left: -14 }}>
                <defs>
                  <linearGradient id="turnoutFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--blue)" stopOpacity={0.22} />
                    <stop offset="100%" stopColor="var(--blue)" stopOpacity={0.01} />
                  </linearGradient>
                </defs>
                <CartesianGrid vertical={false} stroke="var(--border-soft)" />
                <XAxis
                  dataKey="label"
                  ticks={series.ticks}
                  tickLine={false}
                  axisLine={false}
                  tick={{ fontSize: 11, fill: 'var(--muted-2)' }}
                  minTickGap={24}
                />
                <YAxis
                  tickLine={false}
                  axisLine={false}
                  width={52}
                  tick={{ fontSize: 11, fill: 'var(--muted-2)' }}
                  tickFormatter={(value: number) => value.toLocaleString()}
                />
                <Tooltip
                  cursor={{ stroke: 'var(--border-strong)' }}
                  contentStyle={{
                    borderRadius: 'var(--r-sm)',
                    border: '1px solid var(--border)',
                    boxShadow: 'var(--shadow-md)',
                    fontSize: 12,
                  }}
                  labelStyle={{ color: 'var(--muted)', fontSize: 11 }}
                  formatter={(value) => [`${Number(value).toLocaleString()} ballots`, 'Votes cast']}
                />
                <Area
                  type="monotone"
                  dataKey="votes"
                  stroke="var(--blue)"
                  strokeWidth={2}
                  fill="url(#turnoutFill)"
                  dot={false}
                  activeDot={{ r: 4, strokeWidth: 0, fill: 'var(--blue)' }}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
          {series.truncated && (
            <p className="preview-footnote">
              Showing the most recent {series.points.length} column{series.points.length === 1 ? '' : 's'} of
              recorded ballots. The audit log holds more entries than one page can return.
            </p>
          )}
        </>
      )}
    </ControlCard>
  )
}

/* -------------------------------------------------------------- checklist --- */

/**
 * Readiness.
 *
 * Five statements about whether this election can safely run and be certified.
 * Each is derived from state the server already holds — nothing here is entered,
 * so nothing here can be wrong except by being out of date. A tick is a filled
 * circle; a gap is a dashed ring, so the difference reads without colour.
 */
function ReadinessChecklist({ election, preview }: { election: ElectionSummary; preview: BallotPreview }) {
  const items: { label: string; done: boolean; state: string; icon: IconName }[] = [
    {
      label: 'Ballot structure locked',
      done: election.approved_candidate_count > 0,
      state: election.approved_candidate_count > 0 ? 'Locked' : 'No options',
      icon: 'ballot',
    },
    {
      label: 'Voter list verified',
      done: election.eligible_count > 0,
      state: election.eligible_count > 0 ? `${election.eligible_count.toLocaleString()} eligible` : 'Roll empty',
      icon: 'users',
    },
    {
      label: 'Election published',
      done: Boolean(election.published_at),
      state: election.published_at ? 'Published' : 'Still a draft',
      icon: 'flag',
    },
    {
      label: 'Voting window scheduled',
      done: Number.isFinite(Date.parse(election.starts_at)) && Number.isFinite(Date.parse(election.ends_at)),
      state: 'Scheduled',
      icon: 'clock',
    },
    {
      label: 'Closeout plan configured',
      done: false,
      state: 'Pending',
      icon: 'archive',
    },
  ]

  const done = items.filter((item) => item.done).length

  return (
    <ControlCard
      eyebrow="Readiness"
      title="Election checklist"
      actions={<span className="check-summary">{done}/{items.length}</span>}
    >
      <ul className="check-list">
        {items.map((item) => (
          <li key={item.label} className="check-row">
            <span className={`check-mark ${item.done ? 'check-done' : 'check-pending'}`} aria-hidden="true">
              {item.done && <Icon name="check" strokeWidth={3} />}
            </span>
            <span className="check-label">{item.label}</span>
            <span className={`check-state ${item.done ? 'check-state-ok' : 'check-state-pending'}`}>{item.state}</span>
          </li>
        ))}
      </ul>
      {preview.warnings.length > 0 && (
        <ul className="health-issues" style={{ marginTop: 16 }}>
          {preview.warnings.map((warning) => (
            <li key={warning} className="health-issue health-issue-warning">
              {warning}
            </li>
          ))}
        </ul>
      )}
    </ControlCard>
  )
}

/* --------------------------------------------------------------- helpers --- */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function shortDateTime(instant: string): string {
  const at = new Date(instant)
  if (Number.isNaN(at.getTime())) return '—'
  return `${MONTHS[at.getMonth()]} ${at.getDate()}, ${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
}

function statusNote(election: ElectionSummary): string {
  switch (election.effective_status) {
    case 'closed':
      return 'Voting has ended'
    case 'certified':
      return 'Result certified'
    case 'archived':
      return 'Archived'
    default:
      return 'Not scheduled yet'
  }
}
