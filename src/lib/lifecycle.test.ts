import { describe, expect, it } from 'vitest'
import {
  allowsStructuralEdits,
  allowsControlledChanges,
  checkPublishable,
  controlledChangeGuard,
  effectiveStatus,
  hasScheduleDrift,
  isLocked,
  isTerminalStatus,
  isValidTransition,
  structuralEditGuard,
  transitionTarget,
  transitionGuard,
} from './lifecycle'
import { countdownParts, describeVotableState, formatInZone, schedulePhase, utcToWallTime, wallTimeToUtc } from './time'
import type { Election } from './types'

const HOUR = 3_600_000

/**
 * The reference instant for these fixtures.
 *
 * Relative to the moment the suite loads rather than a fixed date. The tests that
 * call `describeVotableState` hand it a window built from this value, but the
 * function compares that window against the real clock inside itself — so a
 * hard-coded date quietly turns every "this poll is open" fixture into a closed
 * one the day after it is written, and the failure looks like a product bug rather
 * than a stale test. The demo seed works the same way, for the same reason.
 */
const NOW = Date.now()

function election(overrides: Partial<Election>): Pick<Election, 'status' | 'starts_at' | 'ends_at'> {
  return {
    status: 'draft',
    starts_at: new Date(NOW - HOUR).toISOString(),
    ends_at: new Date(NOW + HOUR).toISOString(),
    ...overrides,
  }
}

describe('lifecycle state machine', () => {
  it('allows only the transitions declared for each state', () => {
    expect(transitionTarget('draft', 'publish')).toBe('scheduled')
    expect(transitionTarget('scheduled', 'open')).toBe('open')
    expect(transitionTarget('open', 'pause')).toBe('paused')
    expect(transitionTarget('paused', 'resume')).toBe('open')
    expect(transitionTarget('open', 'close')).toBe('closed')
    expect(transitionTarget('closed', 'certify')).toBe('certified')
    expect(transitionTarget('certified', 'archive')).toBe('archived')
  })

  it('refuses to skip certification when archiving', () => {
    expect(isValidTransition('closed', 'archive')).toBe(false)
    expect(transitionTarget('closed', 'archive')).toBeNull()
  })

  it('treats certified and archived as terminal', () => {
    expect(isTerminalStatus('certified')).toBe(true)
    expect(isTerminalStatus('archived')).toBe(true)
    for (const action of ['publish', 'open', 'pause', 'resume', 'close', 'certify', 'archive'] as const) {
      expect(isValidTransition('archived', action)).toBe(false)
    }
  })

  it('never reopens a closed poll', () => {
    expect(isValidTransition('closed', 'open')).toBe(false)
    expect(isValidTransition('closed', 'resume')).toBe(false)
  })

  it('treats an unrecognised action as invalid rather than throwing', () => {
    // The action arrives straight from the wire, so the state machine has to be
    // total. A made-up action must be refused, not crash the request handler.
    for (const status of ['draft', 'open', 'closed'] as const) {
      expect(transitionTarget(status, 'reopen' as never)).toBeNull()
      expect(transitionTarget(status, '' as never)).toBeNull()
      expect(transitionTarget(status, 'toString' as never)).toBeNull()
      expect(transitionTarget(status, '__proto__' as never)).toBeNull()
    }
  })
})

describe('effective status and the schedule clock', () => {
  it('keeps a draft as draft regardless of the window', () => {
    const row = election({ status: 'draft' })
    expect(effectiveStatus(row, NOW - 10 * HOUR)).toBe('draft')
    expect(effectiveStatus(row, NOW)).toBe('draft')
  })

  it('opens a scheduled poll once its start time passes', () => {
    const row = election({ status: 'scheduled' })
    expect(effectiveStatus(row, NOW - 2 * HOUR)).toBe('scheduled')
    expect(effectiveStatus(row, NOW)).toBe('open')
    expect(hasScheduleDrift(row, NOW)).toBe(true)
  })

  it('closes an open poll once its end time passes', () => {
    const row = election({ status: 'open' })
    expect(effectiveStatus(row, NOW)).toBe('open')
    expect(effectiveStatus(row, NOW + 2 * HOUR)).toBe('closed')
    expect(hasScheduleDrift(row, NOW + 2 * HOUR)).toBe(true)
  })

  it('closes a scheduled poll whose window elapsed without opening', () => {
    const row = election({ status: 'scheduled' })
    expect(effectiveStatus(row, NOW + 2 * HOUR)).toBe('closed')
  })

  it('does not let the clock move a terminal election', () => {
    for (const status of ['certified', 'archived'] as const) {
      expect(effectiveStatus(election({ status }), NOW + 100 * HOUR)).toBe(status)
    }
  })
})

describe('configuration locking', () => {
  it('permits structural edits only before the poll opens', () => {
    expect(allowsStructuralEdits('draft')).toBe(true)
    expect(allowsStructuralEdits('scheduled')).toBe(true)
    expect(allowsStructuralEdits('open')).toBe(false)
    expect(allowsStructuralEdits('paused')).toBe(false)
    expect(isLocked('open')).toBe(true)
  })

  it('requires a pause before changing a running election', () => {
    expect(structuralEditGuard('open')).toMatch(/Pause voting/)
    expect(controlledChangeGuard('open')).toMatch(/Pause voting/)
  })

  it('keeps the ballot frozen while paused but allows controlled changes', () => {
    expect(structuralEditGuard('paused')).toMatch(/frozen/)
    expect(controlledChangeGuard('paused')).toBeNull()
    expect(allowsControlledChanges('paused')).toBe(true)
  })

  it('makes terminal states read-only', () => {
    for (const status of ['closed', 'certified', 'archived'] as const) {
      expect(structuralEditGuard(status)).toMatch(/read-only/)
      expect(controlledChangeGuard(status)).toMatch(/read-only/)
    }
  })
})

describe('transition guards', () => {
  it('refuses to open before the scheduled start', () => {
    const row = election({ status: 'scheduled', starts_at: new Date(NOW + HOUR).toISOString() })
    expect(transitionGuard(row, 'open', NOW)).toMatch(/cannot open before/)
  })

  it('refuses to open when the end time has already passed', () => {
    const row = election({
      status: 'scheduled',
      starts_at: new Date(NOW - 2 * HOUR).toISOString(),
      ends_at: new Date(NOW - HOUR).toISOString(),
    })
    expect(transitionGuard(row, 'open', NOW)).toMatch(/already passed/)
  })

  it('refuses to resume once the window has elapsed', () => {
    const row = election({ status: 'paused', ends_at: new Date(NOW - HOUR).toISOString() })
    expect(transitionGuard(row, 'resume', NOW)).toMatch(/no longer be resumed/)
  })

  it('rejects any action from an invalid state', () => {
    expect(transitionGuard(election({ status: 'draft' }), 'open', NOW)).toMatch(/Cannot open/)
  })
})

describe('publish readiness', () => {
  const base = {
    title: 'Test election',
    description: 'A description',
    startsAt: new Date(NOW + HOUR).toISOString(),
    endsAt: new Date(NOW + 2 * HOUR).toISOString(),
    approvedCandidates: 3,
    eligibleVoters: 10,
    requireOtp: true,
    requirePhone: true,
    requireEmail: true,
    requireCompleteRoll: true,
    now: NOW,
  }

  it('passes a complete election', () => {
    const result = checkPublishable({ ...base, status: 'draft' })
    expect(result.blockers).toHaveLength(0)
  })

  it('blocks on too few candidates', () => {
    const result = checkPublishable({ ...base, status: 'draft', approvedCandidates: 1 })
    expect(result.blockers.join(' ')).toMatch(/At least 2 approved/)
  })

  it('blocks on an empty roll', () => {
    const result = checkPublishable({ ...base, status: 'draft', eligibleVoters: 0 })
    expect(result.blockers.join(' ')).toMatch(/voter roll is empty/)
  })

  it('blocks when the window has already ended', () => {
    const result = checkPublishable({ ...base, status: 'draft', endsAt: new Date(NOW - HOUR).toISOString() })
    expect(result.blockers.join(' ')).toMatch(/end time must be after|past/)
  })

  it('warns without blocking when the poll is wide open to fraud', () => {
    const result = checkPublishable({ ...base, status: 'draft', approvedCandidates: 2, requireOtp: false })
    expect(result.blockers).toHaveLength(0)
    expect(result.warnings.join(' ')).toMatch(/easy to guess/)
  })
})

describe('timezone handling', () => {
  it('round-trips wall clock time through UTC', () => {
    const utc = wallTimeToUtc('2026-09-26T14:30', 'Asia/Kolkata')
    expect(utc).toBe('2026-09-26T09:00:00.000Z')
    expect(utcToWallTime(utc!, 'Asia/Kolkata')).toBe('2026-09-26T14:30')
  })

  it('handles a half-hour offset zone', () => {
    expect(wallTimeToUtc('2026-09-26T14:30', 'Asia/Kolkata')).toBe('2026-09-26T09:00:00.000Z')
    expect(wallTimeToUtc('2026-09-26T14:30', 'Asia/Kathmandu')).toBe('2026-09-26T08:45:00.000Z')
  })

  it('handles a zone ahead of UTC', () => {
    expect(wallTimeToUtc('2026-09-26T14:30', 'Australia/Sydney')).toBe('2026-09-26T04:30:00.000Z')
  })

  it('rejects malformed input', () => {
    expect(wallTimeToUtc('not-a-time', 'UTC')).toBeNull()
  })

  it('formats an instant in the election zone without mixing Intl options', () => {
    const text = formatInZone('2026-09-26T09:00:00.000Z', 'Asia/Kolkata')
    expect(text).not.toMatch(/Z$/)
    expect(text).toMatch(/2026/)
    expect(text).toMatch(/14:30/)
  })
})

describe('countdowns and voter-facing state', () => {
  it('splits a duration into parts', () => {
    const parts = countdownParts(90 * 60_000 + 5000)
    expect(parts.hours).toBe(1)
    expect(parts.minutes).toBe(30)
    expect(parts.seconds).toBe(5)
  })

  it('never reports a negative countdown', () => {
    expect(countdownParts(-5000).total).toBe(0)
  })

  it('classifies the schedule phase', () => {
    const startsAt = new Date(NOW).toISOString()
    const endsAt = new Date(NOW + HOUR).toISOString()
    expect(schedulePhase(startsAt, endsAt, NOW - 1)).toBe('before')
    expect(schedulePhase(startsAt, endsAt, NOW)).toBe('open')
    expect(schedulePhase(startsAt, endsAt, NOW + HOUR)).toBe('ended')
  })

  it('lets a voter vote only when the server says the poll is open', () => {
    const open = describeVotableState({
      status: 'open',
      startsAt: new Date(NOW).toISOString(),
      endsAt: new Date(NOW + HOUR).toISOString(),
      serverOffsetMs: 0,
    })
    expect(open.canVote).toBe(true)
    expect(open.nextChangeAt).toBe(Date.parse(new Date(NOW + HOUR).toISOString()))
  })

  it('blocks voters for every non-open state', () => {
    const startsAt = new Date(NOW + HOUR).toISOString()
    const endsAt = new Date(NOW + 2 * HOUR).toISOString()
    for (const status of ['draft', 'scheduled', 'paused', 'closed', 'certified', 'archived'] as const) {
      const state = describeVotableState({ status, startsAt, endsAt, serverOffsetMs: 0 })
      expect(state.canVote, status).toBe(false)
    }
  })
})
