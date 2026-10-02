/**
 * Audit trail viewer.
 *
 * Every lifecycle transition and configuration change is recorded server side.
 * This panel is the read-only view of that log, which is what makes the
 * controlled-change policy verifiable after the fact.
 */

import { useEffect, useState } from 'react'
import { electionApi } from '../../lib/api'
import type { AuditEvent } from '../../lib/adminTypes'
import { formatInZone } from '../../lib/time'
import { Alert, EmptyState, Eyebrow, Spinner } from '../../ui/primitives'

const ACTION_LABELS: Record<string, string> = {
  election_publish: 'Published',
  election_unpublish: 'Returned to draft',
  election_open: 'Voting opened',
  election_pause: 'Voting paused',
  election_resume: 'Voting resumed',
  election_close: 'Voting closed',
  election_certify: 'Results certified',
  election_archive: 'Archived',
  auto_open: 'Opened automatically',
  auto_close: 'Closed automatically',
  election_created: 'Election created',
  election_updated: 'Settings updated',
  election_deleted: 'Draft deleted',
  rules_updated: 'Rules updated',
  eligibility_updated: 'Eligibility updated',
  candidate_added: 'Candidate added',
  candidate_updated: 'Candidate updated',
  candidate_removed: 'Candidate removed',
  candidate_status_changed: 'Candidate status changed',
  ballot_reordered: 'Ballot reordered',
  voters_added: 'Voters added',
  voters_removed: 'Voters removed',
  voter_eligibility_changed: 'Voter eligibility changed',
  vote_cast: 'Vote cast',
  vote_changed: 'Vote replaced',
  voter_verified: 'Voter verified',
  admin_login: 'Administrator signed in',
  admin_created: 'Administrator created',
}

export function AuditTrail({ electionId, timezone, refreshKey }: { electionId: string; timezone: string; refreshKey: number }) {
  const [events, setEvents] = useState<AuditEvent[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      const result = await electionApi.audit(electionId, 200)
      if (cancelled) return
      if (!result.ok) setError(result.error)
      else {
        setEvents(result.value.events)
        setError(null)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [electionId, refreshKey])

  if (error) return <Alert tone="error">{error}</Alert>
  if (!events) return <Spinner label="Loading audit trail…" />

  return (
    <div className="panel">
      <div className="panel-head">
        <div>
          <Eyebrow>Record</Eyebrow>
          <h2 style={{ marginTop: 9 }}>Election audit trail</h2>
          <p>Every state change and configuration edit, newest first. Recorded server side and not editable.</p>
        </div>
      </div>

      {events.length === 0 ? (
        <EmptyState title="No recorded activity" icon="audit">
          <p>Nothing has happened to this election yet. Every transition and edit will be written here as it occurs.</p>
        </EmptyState>
      ) : (
        <ol className="audit-list">
          {events.map((event) => (
            <li key={event.id} className={`audit-item audit-${event.actor_type}`}>
              <div className="audit-marker" aria-hidden="true" />
              <div className="audit-body">
                <div className="audit-head">
                  <span className="audit-action">{ACTION_LABELS[event.action] ?? event.action}</span>
                  <span className="audit-time">{formatInZone(event.created_at, timezone)}</span>
                </div>
                <p className="audit-summary">{event.summary}</p>
                <div className="audit-meta">
                  <span className={`pill pill-${event.actor_type === 'admin' ? 'admin' : event.actor_type === 'system' ? 'system' : 'voter'}`}>
                    {event.actor_type === 'admin' ? 'Administrator' : event.actor_type === 'system' ? 'System' : 'Voter'}
                  </span>
                  {event.actor_label && <span className="audit-actor">{event.actor_label}</span>}
                  {event.actor_role && <span className="cell-secondary">{event.actor_role.replace(/_/g, ' ')}</span>}
                  {event.result !== 'success' && (
                    <span className={`pill pill-${event.result === 'denied' ? 'disqualified' : 'withdrawn'}`}>
                      {event.result}
                    </span>
                  )}
                  {event.from_status && event.to_status && (
                    <span className="audit-transition">
                      {event.from_status} &rarr; {event.to_status}
                    </span>
                  )}
                  {event.resource && <span className="audit-transition">{event.resource}</span>}
                  {event.request_id && <span className="audit-transition" title="Correlates this record with the server log">{event.request_id}</span>}
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
