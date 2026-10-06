/**
 * The theme preference, tested where it can fail.
 *
 * This is the one piece of the theme system that is pure logic and therefore worth
 * asserting rather than eyeballing: the palette is CSS and the only way to judge that
 * is to look at it, but the *preference* — what gets stored, what gets put on the
 * document, and what a system preference resolves to — is decidable, and getting it
 * wrong is silent. A reader who chose light and gets dark back has no error to look
 * at; they just have a page they did not ask for.
 *
 * The one thing this file cannot cover is the flash. That the theme is correct on the
 * first painted frame is a property of an inline script in `index.html` running before
 * React, and asserting it from here would assert the wrong thing — the app applies
 * the theme from `boot()` in `main.tsx`, which by construction runs after the first
 * paint. The no-flash behaviour is verified in a browser, by sampling `body`'s
 * background on frame 0 of a cold load, and that is recorded in `index.html` where the
 * script lives.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as theme from './theme'

/**
 * A controllable `matchMedia`.
 *
 * jsdom implements `matchMedia` but reports `matches: false` for everything and cannot
 * be asked to change, so `resolved('system')` would resolve to dark under every
 * condition and the test would pass without ever testing the system branch.
 */
let systemPrefersLight = false
const listeners = new Set<() => void>()

function stubMatchMedia() {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      get matches() {
        return query.includes('prefers-color-scheme: light') ? systemPrefersLight : false
      },
      media: query,
      addEventListener: (_: string, fn: () => void) => void listeners.add(fn),
      removeEventListener: (_: string, fn: () => void) => void listeners.delete(fn),
      dispatchEvent: () => false,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
    }),
  })
}

const attr = () => document.documentElement.getAttribute('data-theme')
const stored = () => window.localStorage.getItem('ballot.theme.v1')

beforeEach(() => {
  systemPrefersLight = false
  listeners.clear()
  document.documentElement.removeAttribute('data-theme')
  stubMatchMedia()
})

afterEach(() => {
  document.documentElement.removeAttribute('data-theme')
})

describe('the stored preference', () => {
  it('is system when nothing has been chosen', () => {
    // The absence of a key and an explicit choice to follow the system are the same
    // thing, which is why `system` is stored by removing rather than by writing.
    expect(theme.current()).toBe('system')
    expect(stored()).toBeNull()
  })

  it('round-trips a choice', () => {
    theme.set('light')
    expect(theme.current()).toBe('light')
    expect(stored()).toBe('light')
    theme.set('dark')
    expect(theme.current()).toBe('dark')
  })

  it('clears the key on the way back to system', () => {
    // Not cosmetic: `current()` reads the key, so a leftover 'dark' behind a
    // 'system' choice would make the app ignore the very setting just requested.
    theme.set('dark')
    theme.set('system')
    expect(theme.current()).toBe('system')
    expect(stored()).toBeNull()
  })

  it('falls back to system for a value it does not recognise', () => {
    // A theme is a set of design decisions. When the palette is revised there is no
    // way to tell a stored 'light' from a stale one, so an unrecognised value is
    // ignored rather than applied — the reader gets this build's default instead of
    // a palette that no longer exists.
    window.localStorage.setItem('ballot.theme.v1', 'solarized-lagoon')
    expect(theme.current()).toBe('system')
  })

  it('falls back to system when storage throws', () => {
    // Storage can be denied — private windows, disabled cookies, a sandboxed frame.
    // A preference that cannot be remembered is still a preference for this page view.
    const getItem = vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    expect(theme.current()).toBe('system')
    getItem.mockRestore()
  })
})

describe('applying a theme', () => {
  it('writes an explicit choice and removes it for system', () => {
    theme.set('light')
    expect(attr()).toBe('light')
    // The CSS keys off the attribute's presence. Setting it to the string 'system'
    // would need the light block to exclude that value by name, which is one more
    // thing to get wrong the next time a theme is added.
    theme.set('system')
    expect(attr()).toBeNull()
  })

  it('applies the theme on boot', () => {
    window.localStorage.setItem('ballot.theme.v1', 'light')
    theme.boot()
    expect(attr()).toBe('light')
  })
})

describe('resolving the system preference', () => {
  it('follows the system when asked to', () => {
    expect(theme.resolved('system')).toBe('dark')
    systemPrefersLight = true
    expect(theme.resolved('system')).toBe('light')
  })

  it('ignores the system when a theme was chosen', () => {
    systemPrefersLight = true
    expect(theme.resolved('dark')).toBe('dark')
    expect(theme.resolved('light')).toBe('light')
  })
})

describe('following the system as it changes', () => {
  it('notifies only while following it', () => {
    let fired = 0
    const stop = theme.watchSystem(() => { fired += 1 })

    theme.set('system')
    systemPrefersLight = true
    for (const fn of listeners) fn()
    expect(fired).toBe(1)

    // Someone who has explicitly chosen a theme has said what they want, and an
    // operating-system change is not a reason to overrule them.
    theme.set('light')
    systemPrefersLight = false
    for (const fn of listeners) fn()
    expect(fired).toBe(1)

    stop()
    theme.set('system')
    systemPrefersLight = true
    for (const fn of listeners) fn()
    expect(fired).toBe(1)
  })
})