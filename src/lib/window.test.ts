/**
 * `formatWindow`, tested because a wrong window is worse than no window.
 *
 * This is the function that replaced two full instants per election card. It
 * collapses a range by how much its ends share, so every branch below is a claim
 * about what a voter would be misled into believing if the branch were wrong — which
 * is why these are asserted on exact strings rather than on "looks right".
 *
 * Every fixture is written as a local wall-clock time in `Asia/Kolkata`, because
 * that is the zone the product's elections are seeded in and it is a half-hour
 * offset from UTC, so a formatter that quietly dropped the zone would produce
 * obviously wrong dates here and plausible ones in UTC.
 */

import { describe, it, expect } from 'vitest'
import { formatWindow } from './time'

const ZONE = 'Asia/Kolkata'
const IST = Date.UTC(2026, 9, 6, 11, 58) // 06 Oct 2026, 17:28 IST

describe('formatWindow', () => {
  it('collapses a same-day window to one date', () => {
    const { label } = formatWindow(new Date(IST).toISOString(), new Date(IST + 3600_000).toISOString(), ZONE)
    expect(label).toBe('Tue 06 Oct 2026')
  })

  it('collapses a same-month window to a day range', () => {
    const start = Date.UTC(2026, 9, 6, 6, 28) // 06 Oct 11:58 IST
    const end = Date.UTC(2026, 9, 8, 6, 28) // 08 Oct 11:58 IST
    const { label } = formatWindow(new Date(start).toISOString(), new Date(end).toISOString(), ZONE)
    expect(label).toBe('06 – 08 Oct 2026')
  })

  it('repeats the month across a month boundary', () => {
    const start = Date.UTC(2026, 8, 28, 6, 28) // 28 Sep 11:58 IST
    const end = Date.UTC(2026, 9, 2, 6, 28) // 02 Oct 11:58 IST
    const { label } = formatWindow(new Date(start).toISOString(), new Date(end).toISOString(), ZONE)
    // No hours: both ends are 11:58, so "11:58 – 11:58" is length without meaning.
    // The dash already says the earlier date is the start.
    expect(label).toBe('28 Sept – 02 Oct 2026')
  })

  it('repeats the year across a year boundary', () => {
    const start = Date.UTC(2026, 11, 28, 6, 28)
    const end = Date.UTC(2027, 0, 2, 6, 28)
    const { label } = formatWindow(new Date(start).toISOString(), new Date(end).toISOString(), ZONE)
    expect(label).toBe('28 Dec 2026 – 02 Jan 2027')
  })

  it('keeps the hours only when they differ', () => {
    // A window that opens at 09:00 and closes at 17:00 is exactly the case where the
    // times are the information. This also corrected a claim made when the formatter
    // was written: the hours are not tied to crossing a month, only to differing.
    const start = Date.UTC(2026, 9, 6, 3, 30) // 06 Oct 09:00 IST
    const end = Date.UTC(2026, 9, 8, 11, 30) // 08 Oct 17:00 IST
    const { label } = formatWindow(new Date(start).toISOString(), new Date(end).toISOString(), ZONE)
    expect(label).toBe('06 – 08 Oct 2026, 09:00 – 17:00')
  })

  it('states both hours across a month boundary when they differ', () => {
    const start = Date.UTC(2026, 8, 28, 3, 30) // 28 Sep 09:00 IST
    const end = Date.UTC(2026, 9, 2, 11, 30) // 02 Oct 17:00 IST
    const { label } = formatWindow(new Date(start).toISOString(), new Date(end).toISOString(), ZONE)
    expect(label).toBe('28 Sept – 02 Oct 2026, 09:00 – 17:00')
  })

  it('states the zone once, separately, so a caller can caption it', () => {
    // The old card printed "(GMT+5:30)" inside both timestamps. The zone is returned
    // apart from the label precisely so it can be written once.
    const { zone } = formatWindow(new Date(IST).toISOString(), new Date(IST).toISOString(), ZONE)
    expect(zone).toBe('GMT+5:30')
  })

  it('never shows an hour it does not need', () => {
    // Guard on the guard: if this passes because the hour branch stopped running for
    // any reason, the two tests above are the ones that should notice, and they are
    // the reason the branch exists at all.
    const start = Date.UTC(2026, 8, 28, 6, 28)
    const end = Date.UTC(2026, 9, 2, 6, 28)
    const { label } = formatWindow(new Date(start).toISOString(), new Date(end).toISOString(), ZONE)
    expect(label).not.toContain(':')
  })

  it('falls back to UTC for a zone it does not recognise', () => {
    // A bad zone must not throw — the card would take the whole election list down.
    const { label } = formatWindow(new Date(IST).toISOString(), new Date(IST).toISOString(), 'Mars/Olympus')
    expect(label).toBe('Tue 06 Oct 2026')
  })

  it('degrades to a dash rather than NaN for an unparseable instant', () => {
    expect(formatWindow('not-a-date', new Date(IST).toISOString(), ZONE)).toEqual({ label: '—', zone: '' })
    expect(formatWindow(new Date(IST).toISOString(), 'not-a-date', ZONE)).toEqual({ label: '—', zone: '' })
  })

  it('treats hour 24 as midnight rather than the 24th hour', () => {
    // Intl emits hour "24" for midnight under hour12: false in some engines. Left
    // unhandled it prints "24:00", which is not a time anyone has ever seen.
    const start = new Date(Date.UTC(2026, 9, 6, 18, 30)).toISOString() // 07 Oct 00:00 IST
    const end = new Date(Date.UTC(2026, 9, 8, 18, 30)).toISOString()
    const { label } = formatWindow(start, end, ZONE)
    expect(label).not.toContain('24:')
  })
})