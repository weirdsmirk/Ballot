/**
 * Results.
 *
 * Tallies for every election, with the visibility rule made explicit. An
 * election can be mid-poll with its results deliberately withheld, and an
 * operator needs to see that the number is hidden *by policy* rather than
 * missing — so a withheld result says which rule withholds it instead of
 * showing a blank.
 *
 * A tally read from the running database is provisional until the poll closes
 * and is certified, and the screen says so next to the number.
 */

import { useCallback, useMemo, useState } from 'react'
import { electionApi } from '../../../lib/api'
import { roleHas, type AdminRole } from '../../../lib/rbac'
import { STATUS_DESCRIPTIONS, STATUS_LABELS } from '../../../lib/lifecycle'
import type { ElectionResults, ElectionSummary, TallyRow } from '../../../lib/types'
import { Alert, EmptyState, StatusBadge } from '../../../ui/primitives'
import { Icon } from '../../../ui/Icon'
import { ControlCard, SectionHeader, formatInstant, formatPercent, useControlData } from '../shared'
import { TurnoutMeter } from './DashboardPanel'

/** The label for each visibility rule, in the operator's terms. */
const VISIBILITY_LABELS: Record<string, string> = {
  live: 'Live while voting is open',
  after_close: 'Published after voting closes',
  after_certify: 'Published only after certification',
  never: 'Never published to voters',
}

type Entry = { election: ElectionSummary; results: ElectionResults | null; error: string | null }

export function ResultsPanel({
  role,
  elections,
  selectedElectionId,
  onSelectElection,
  serverOffsetMs,
}: {
  role: AdminRole
  elections: ElectionSummary[]
  selectedElectionId: string | null
  onSelectElection: (id: string) => void
  serverOffsetMs: number
}) {
  const canViewRestricted = roleHas(role, 'results.view_restricted')
  const focus = elections.find((item) => item.id === selectedElectionId) ?? elections[0] ?? null

  // Drafts have no meaningful tally, so they are left out of the fetch.
  const tallyable = useMemo(
    () => elections.filter((election) => !['draft', 'archived'].includes(election.effective_status)),
    [elections],
  )

  const { data, error, loading, reload } = useControlData<Entry[]>(
    async () => {
      const settled = await Promise.all(
        tallyable.map(async (election): Promise<Entry> => {
          const result = await electionApi.results(election.id)
          return result.ok
            ? { election, results: result.value.results, error: null }
            : { election, results: null, error: result.error }
        }),
      )
      return { ok: true, value: settled }
    },
    [tallyable.map((election) => election.id).join(','), serverOffsetMs],
  )

  const [expanded, setExpanded] = useState<string | null>(selectedElectionId)

  const toggle = useCallback(
    (id: string) => setExpanded((current) => (current === id ? null : id)),
    [],
  )

  const entries = data ?? []
  const totals = useMemo(
    () =>
      entries.reduce(
        (sum, entry) => ({
          votes: sum.votes + (entry.results?.total_votes ?? 0),
          ballots: sum.ballots + (entry.results?.rows.filter((row) => row.kind === 'candidate').length ?? 0),
          certified: sum.certified + (entry.results?.certified_at ? 1 : 0),
        }),
        { votes: 0, ballots: 0, certified: 0 },
      ),
    [entries],
  )

  if (!elections.length) {
    return (
      <div className="control-body">
        <SectionHeader eyebrow="Admin workspace" title="Results center" description="Certified outcomes and publication controls." />
        <EmptyState title="No elections yet" icon="trend">
          <p>Results appear once an election has candidates and has begun accepting votes.</p>
        </EmptyState>
      </div>
    )
  }

  return (
    <div className="control-body">
      <SectionHeader
        eyebrow="Admin workspace"
        title="Results center"
        description="A tally taken from a running poll is provisional. It becomes final when the poll closes, and official when it is certified."
        actions={
          <>
            <button type="button" className="btn-outline" onClick={reload}>
              Refresh
            </button>
            {focus && (
              <label className="election-picker">
                <span className="preview-meta-label">Focus</span>
                <select value={focus.id} onChange={(event) => onSelectElection(event.target.value)}>
                  {elections.map((election) => (
                    <option key={election.id} value={election.id}>
                      {election.title}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </>
        }
      />

      {error && <Alert tone="error">{error}</Alert>}
      {!canViewRestricted && (
        <Alert tone="info">
          Your role cannot view results for elections whose visibility rule restricts them. Those entries are shown as
          withheld.
        </Alert>
      )}

      <div className="kpi-row" style={{ marginBottom: 22 }}>
        <Kpi icon="ballot" tone="blue" label="Ballots counted" value={totals.votes} sub="across all elections" />
        <Kpi icon="users" tone="green" label="Contested options" value={totals.ballots} sub="candidates on a ballot" />
        <Kpi icon="check-circle" tone="slate" label="Certified" value={totals.certified} sub="signed off as official" />
      </div>

      {loading && !data ? (
        <p className="control-loading">Loading tallies…</p>
      ) : entries.length === 0 ? (
        <EmptyState title="No tallies yet" icon="trend">
          <p>Results appear once an election is published and has candidates on its ballot.</p>
        </EmptyState>
      ) : (
        <div className="results-list">
          {entries.map((entry) => {
            const { election, results } = entry
            const open = expanded === election.id
            return (
              <ControlCard key={election.id}>
                <div className="results-card-head">
                  <div className="results-card-title">
                    <StatusBadge status={election.status} effective={election.effective_status} />
                    <div>
                      {/* The poll's name, set as a title rather than quoted in prose. */}
                      <h2 className="election-name">{election.title}</h2>
                      <p className="cell-secondary">
                        {STATUS_DESCRIPTIONS[election.effective_status]} &middot;{' '}
                        {VISIBILITY_LABELS[election.rules.resultsVisibility] ?? election.rules.resultsVisibility}
                      </p>
                    </div>
                  </div>
                  <button type="button" className="btn-outline" onClick={() => toggle(election.id)} aria-expanded={open}>
                    {open ? 'Hide tally' : 'Show tally'}
                  </button>
                </div>

                {entry.error && <Alert tone="error">{entry.error}</Alert>}

                {results && (
                  <>
                    <div className="results-summary">
                      <div className="results-summary-cell">
                        <span className="preview-meta-label">Ballots</span>
                        <strong>{results.total_votes}</strong>
                      </div>
                      <div className="results-summary-cell">
                        <span className="preview-meta-label">Eligible</span>
                        <strong>{results.eligible_count}</strong>
                      </div>
                      <div className="results-summary-cell">
                        <span className="preview-meta-label">Turnout</span>
                        <strong>{formatPercent(results.turnout)}</strong>
                      </div>
                      <div className="results-summary-cell">
                        <span className="preview-meta-label">Status</span>
                        <strong>{results.certified_at ? 'Certified' : STATUS_LABELS[results.effective_status]}</strong>
                      </div>
                      {results.certified_at && (
                        <div className="results-summary-cell">
                          <span className="preview-meta-label">Certified at</span>
                          <strong>{formatInstant(results.certified_at)}</strong>
                        </div>
                      )}
                    </div>

                    <TurnoutMeter value={results.turnout} label="turnout" />

                    {!results.visible && (
                      <Alert tone="info">
                        Withheld from voters: {results.hidden_reason || 'not yet publishable under this rule'}. The
                        figures above are what an authorised administrator can see.
                      </Alert>
                    )}

                    {open && (
                      <div className="tally-table">
                        <div className="tally-head">
                          <span>Option</span>
                          <span className="col-num">Votes</span>
                          <span className="col-num">Share</span>
                        </div>
                        {results.rows.map((row) => (
                          <TallyLine
                            key={row.key}
                            row={row}
                            leader={results.winner?.key === row.key}
                            total={results.total_votes}
                          />
                        ))}
                      </div>
                    )}
                  </>
                )}
              </ControlCard>
            )
          })}
        </div>
      )}
    </div>
  )
}

function TallyLine({ row, leader, total }: { row: TallyRow; leader: boolean; total: number }) {
  const share = total > 0 ? (row.votes / total) * 100 : 0
  return (
    <div className={`tally-line${leader ? ' tally-line-leading' : ''}`}>
      <div className="tally-line-name">
        <span className="cell-primary">{row.name}</span>
        {row.organization && <span className="cell-secondary">{row.organization}</span>}
        {row.kind !== 'candidate' && <span className="cell-secondary">{row.kind === 'nota' ? 'None of the Above' : 'Abstain'}</span>}
      </div>
      <div className="tally-line-track">
        <div className="tally-line-fill" style={{ width: `${Math.min(100, share)}%` }} />
      </div>
      <span className="col-num num">{row.votes.toLocaleString()}</span>
      <span className="col-num num">{formatPercent(share)}</span>
    </div>
  )
}

/** A figure tile with the same anatomy as the dashboard's. */
function Kpi({ icon, tone, label, value, sub }: {
  icon: 'ballot' | 'users' | 'check-circle' | 'trend' | 'warning'
  tone: 'blue' | 'green' | 'amber' | 'orange' | 'slate'
  label: string
  value: React.ReactNode
  sub: string
}) {
  return (
    <div className="kpi">
      <div className="stat-card-top">
        <span className={`icon-tile icon-tile-sm tile-${tone}`}>
          <Icon name={icon} />
        </span>
        <span className="kpi-label">{label}</span>
      </div>
      <span className="kpi-value">{value}</span>
      <span className="kpi-sub">{sub}</span>
    </div>
  )
}
