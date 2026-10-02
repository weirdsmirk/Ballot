/**
 * Results and turnout, shown to voters and reused by the admin workspace.
 *
 * Whether results are visible at all is decided by the election's
 * `resultsVisibility` rule, which the server enforces, so this component only
 * has to render whatever the server chose to send.
 */

import { useEffect, useState } from 'react'
import { electionApi } from '../lib/api'
import { formatInZone } from '../lib/time'
import type { ElectionResults } from '../lib/types'
import { Alert, Spinner, Stat, StatusBadge } from '../ui/primitives'

export function ResultsPanel({ electionId, onSignOut }: { electionId: string; onSignOut?: () => void }) {
  const [results, setResults] = useState<ElectionResults | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      const response = await electionApi.results(electionId)
      if (cancelled) return
      if (!response.ok) setError(response.error)
      else {
        setResults(response.value.results)
        setError(null)
      }
    }
    void load()
    const interval = setInterval(() => void load(), 10_000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [electionId])

  if (error) return <Alert tone="error">{error}</Alert>
  if (!results) return <Spinner label="Loading results…" />

  if (!results.visible) {
    return (
      <div className="results-hidden">
        <h2>Results are not published yet</h2>
        <p>{results.hidden_reason}</p>
        <StatusBadge status={results.status} effective={results.effective_status} />
      </div>
    )
  }

  const max = results.rows.reduce((best, row) => Math.max(best, row.votes), 0)

  return (
    <div className="results-view">
      <div className="results-header">
        <h2>Results</h2>
        <StatusBadge status={results.status} effective={results.effective_status} />
      </div>

      <div className="stats-grid">
        <Stat label="Votes cast" value={results.total_votes} sub={`of ${results.eligible_count} eligible`} />
        <Stat label="Turnout" value={`${results.turnout.toFixed(1)}%`} sub="distinct voters" />
        <Stat
          label="Leading option"
          value={results.winner ? results.winner.name : results.total_votes ? 'Tied' : '—'}
          sub={results.winner ? `${results.winner.votes} vote${results.winner.votes === 1 ? '' : 's'}` : 'no votes yet'}
        />
        {results.certified_at && (
          <Stat label="Certified" value={formatInZone(results.certified_at, 'UTC').split(',').pop()?.trim() ?? '—'} sub="final result" />
        )}
      </div>

      {results.rows.length === 0 ? (
        <Alert tone="info">No votes have been recorded yet.</Alert>
      ) : (
        <div className="tally-section">
          {results.rows.map((row) => (
            <div key={row.key} className="tally-card">
              <div className="tally-header">
                <span className="tally-name">
                  {row.name}
                  {row.kind !== 'candidate' && <span className="pill pill-inline">{row.kind === 'nota' ? 'NOTA' : 'Abstain'}</span>}
                </span>
                <span className="tally-percent">{row.percentage.toFixed(1)}%</span>
              </div>
              {row.organization && <div className="tally-party">{row.organization}</div>}
              <div className="tally-bar-track">
                <div
                  className={`tally-bar-fill${row.votes === max && max > 0 ? ' leading' : ''}`}
                  style={{ width: `${max ? (row.votes / max) * 100 : 0}%` }}
                />
              </div>
              <div className="tally-votes">
                {row.votes} vote{row.votes === 1 ? '' : 's'}
              </div>
            </div>
          ))}
        </div>
      )}

      {onSignOut && (
        <div className="confirmed-actions">
          <button type="button" className="btn-outline" onClick={onSignOut}>
            Sign out
          </button>
        </div>
      )}
    </div>
  )
}
