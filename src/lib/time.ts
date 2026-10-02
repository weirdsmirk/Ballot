/**
 * Timezone and countdown helpers.
 *
 * Schedule times are always stored as ISO-8601 UTC instants so that they are
 * unambiguous. The election's IANA timezone is stored alongside purely for
 * display, which means a voter in another country still sees the poll open and
 * close at the same absolute moment.
 *
 * No date library is used: `Intl.DateTimeFormat` is enough to convert between
 * wall-clock time in an arbitrary zone and a UTC instant.
 */

import type { ElectionStatus } from './types'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

const statusZoneCache = new Map<string, boolean>()

export function isValidTimeZone(timeZone: string): boolean {
  if (!timeZone || typeof timeZone !== 'string') return false
  const cached = statusZoneCache.get(timeZone)
  if (cached !== undefined) return cached
  let valid = false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone })
    valid = true
  } catch {
    valid = false
  }
  statusZoneCache.set(timeZone, valid)
  return valid
}

export function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

/** A short, useful selection of zones for the admin dropdown. */
export function commonTimeZones(): string[] {
  return [
    'UTC',
    'Africa/Lagos',
    'Africa/Nairobi',
    'America/Chicago',
    'America/Denver',
    'America/Los_Angeles',
    'America/Mexico_City',
    'America/New_York',
    'America/Sao_Paulo',
    'Asia/Dubai',
    'Asia/Hong_Kong',
    'Asia/Jakarta',
    'Asia/Karachi',
    'Asia/Kolkata',
    'Asia/Manila',
    'Asia/Seoul',
    'Asia/Shanghai',
    'Asia/Singapore',
    'Asia/Tokyo',
    'Australia/Melbourne',
    'Australia/Perth',
    'Australia/Sydney',
    'Europe/Amsterdam',
    'Europe/Berlin',
    'Europe/Dublin',
    'Europe/Lisbon',
    'Europe/London',
    'Europe/Madrid',
    'Europe/Moscow',
    'Europe/Paris',
    'Pacific/Auckland',
  ]
}

/** Offset of `timeZone` from UTC, in milliseconds, at the given instant. */
function zoneOffsetMs(instant: number, timeZone: string): number {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  const parts: Record<string, string> = {}
  for (const part of formatter.formatToParts(new Date(instant))) parts[part.type] = part.value
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second),
  )
  return asUtc - instant
}

/**
 * Convert a wall-clock time in `timeZone` to a UTC ISO instant.
 *
 * @param wallTime `YYYY-MM-DDTHH:mm` as typed in a datetime-local input.
 */
export function wallTimeToUtc(wallTime: string, timeZone: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(wallTime.trim())
  if (!match) return null
  const [, year, month, day, hour, minute, second = '00'] = match
  const naive = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second))
  if (!Number.isFinite(naive)) return null
  const zone = isValidTimeZone(timeZone) ? timeZone : 'UTC'
  // Two refinement passes converge for every real-world offset, including
  // half-hour zones and DST transitions.
  let instant = naive
  for (let pass = 0; pass < 2; pass += 1) {
    instant = naive - zoneOffsetMs(instant, zone)
  }
  return new Date(instant).toISOString()
}

/** Render a UTC instant as a wall-clock string in `timeZone`, for datetime-local inputs. */
export function utcToWallTime(instant: string, timeZone: string): string {
  const timestamp = Date.parse(instant)
  if (!Number.isFinite(timestamp)) return ''
  const zone = isValidTimeZone(timeZone) ? timeZone : 'UTC'
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
  const parts: Record<string, string> = {}
  for (const part of formatter.formatToParts(new Date(timestamp))) parts[part.type] = part.value
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour === '24' ? '00' : parts.hour}:${parts.minute}`
}

/** Human readable instant in the election's own timezone, e.g. "26 Sept 2026, 14:30 (IST)". */
export function formatInZone(instant: string, timeZone: string): string {
  const timestamp = Date.parse(instant)
  if (!Number.isFinite(timestamp)) return '—'
  const zone = isValidTimeZone(timeZone) ? timeZone : 'UTC'
  const date = new Date(timestamp)
  try {
    // `dateStyle`/`timeStyle` cannot be combined with `timeZoneName`, so the
    // zone abbreviation is resolved separately.
    const formatted = new Intl.DateTimeFormat('en-GB', {
      timeZone: zone,
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(date)
    const abbreviation = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'short' })
      .formatToParts(date)
      .find((part) => part.type === 'timeZoneName')?.value
    return abbreviation ? `${formatted} (${abbreviation})` : formatted
  } catch {
    return date.toISOString()
  }
}

/** Compact variant without the zone abbreviation, for dense table cells. */
export function formatInZoneShort(instant: string, timeZone: string): string {
  const timestamp = Date.parse(instant)
  if (!Number.isFinite(timestamp)) return '—'
  const zone = isValidTimeZone(timeZone) ? timeZone : 'UTC'
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: zone,
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(timestamp))
  } catch {
    return new Date(timestamp).toISOString()
  }
}

export type CountdownParts = {
  days: number
  hours: number
  minutes: number
  seconds: number
  total: number
}

export function countdownParts(milliseconds: number): CountdownParts {
  const clamped = Math.max(0, Math.floor(milliseconds))
  return {
    days: Math.floor(clamped / DAY),
    hours: Math.floor((clamped % DAY) / HOUR),
    minutes: Math.floor((clamped % HOUR) / MINUTE),
    seconds: Math.floor((clamped % MINUTE) / 1000),
    total: clamped,
  }
}

export function formatDuration(milliseconds: number): string {
  const { days, hours, minutes, seconds } = countdownParts(milliseconds)
  if (days > 0) return `${days}d ${hours}h ${minutes}m`
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

export function formatCountdown(milliseconds: number): string {
  const { days, hours, minutes, seconds } = countdownParts(milliseconds)
  const pad = (value: number) => String(value).padStart(2, '0')
  if (days > 0) return `${days}d ${pad(hours)}:${pad(minutes)}:${pad(seconds)}`
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`
}

export type Phase = 'before' | 'open' | 'ended'

export function schedulePhase(startsAt: string, endsAt: string, now: number): Phase {
  const start = Date.parse(startsAt)
  const end = Date.parse(endsAt)
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 'before'
  if (now < start) return 'before'
  if (now >= end) return 'ended'
  return 'open'
}

export type VotableState = {
  /** Whether votes are accepted right now. */
  canVote: boolean
  status: ElectionStatus
  phase: Phase
  headline: string
  detail: string
  /** Epoch ms of the next scheduled state change, or null when static. */
  nextChangeAt: number | null
  nextChangeLabel: string | null
}

/**
 * Describe the voting state for the voter interface, combining the persisted
 * lifecycle status with the schedule clock.
 *
 * The client only ever renders this; enforcement happens on the server, so a
 * tampered clock here cannot let anyone vote early or late.
 */
export function describeVotableState(input: {
  status: ElectionStatus
  startsAt: string
  endsAt: string
  serverOffsetMs: number
}): VotableState {
  const { status, startsAt, endsAt, serverOffsetMs } = input
  const now = Date.now() + serverOffsetMs
  const phase = schedulePhase(startsAt, endsAt, now)
  const startInstant = Date.parse(startsAt)
  const endInstant = Date.parse(endsAt)

  if (status === 'archived' || status === 'certified') {
    return {
      canVote: false,
      status,
      phase,
      headline: status === 'archived' ? 'This election is archived' : 'Results have been certified',
      detail:
        status === 'archived'
          ? 'This election has been archived and is retained for the record only.'
          : 'Voting has ended and the final result has been certified.',
      nextChangeAt: null,
      nextChangeLabel: null,
    }
  }

  if (status === 'closed') {
    return {
      canVote: false,
      status,
      phase,
      headline: 'Voting has closed',
      detail: 'This election is no longer accepting votes.',
      nextChangeAt: null,
      nextChangeLabel: null,
    }
  }

  if (status === 'paused') {
    return {
      canVote: false,
      status,
      phase,
      headline: 'Voting is paused',
      detail: 'An administrator has temporarily suspended voting. Your ballot is not available right now.',
      nextChangeAt: phase === 'open' ? endInstant : null,
      nextChangeLabel: phase === 'open' ? 'Voting window ends in' : null,
    }
  }

  if (status === 'draft') {
    return {
      canVote: false,
      status,
      phase,
      headline: 'Not yet published',
      detail: 'This election is still being prepared by an administrator.',
      nextChangeAt: null,
      nextChangeLabel: null,
    }
  }

  if (status === 'scheduled' && phase === 'before') {
    return {
      canVote: false,
      status,
      phase,
      headline: 'Voting has not opened yet',
      detail: 'The ballot becomes available when the scheduled start time is reached.',
      nextChangeAt: startInstant,
      nextChangeLabel: 'Voting opens in',
    }
  }

  if (status === 'scheduled' && phase === 'ended') {
    return {
      canVote: false,
      status,
      phase,
      headline: 'Voting has closed',
      detail: 'The scheduled voting window passed without the poll being opened.',
      nextChangeAt: null,
      nextChangeLabel: null,
    }
  }

  if (phase === 'ended') {
    return {
      canVote: false,
      status,
      phase: 'ended',
      headline: 'Voting has closed',
      detail: 'The scheduled end time has passed. Votes are no longer accepted.',
      nextChangeAt: null,
      nextChangeLabel: null,
    }
  }

  return {
    canVote: true,
    status: 'open',
    phase: 'open',
    headline: 'Voting is open',
    detail: 'Cast your vote before the scheduled end time.',
    nextChangeAt: endInstant,
    nextChangeLabel: 'Voting closes in',
  }
}
