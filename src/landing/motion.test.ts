/**
 * Nothing may animate that a reduced-motion reader would see animate.
 *
 * This exists because that has now happened twice.
 *
 * The first time, an exclusion lost a specificity fight and left three animations
 * running for a reader who had asked for none. The second time was dumber: the whole
 * `prefers-reduced-motion` block was deleted while the sections below the opening
 * were being removed, because it sat immediately after them and nothing in the file
 * said the two were related. Six animations came back.
 *
 * Both failures are invisible to every other check here. The CSS parses, the build
 * passes, and every element's resting state is correct — the design *is* the resting
 * state, which is exactly why nothing looks broken. It only shows up by counting
 * `document.getAnimations()` in a browser with the media feature emulated, by hand.
 *
 * So this asserts it statically instead. It will not catch an animation added at
 * runtime by script; that still needs the browser probe. What it catches is the
 * failure that has actually happened twice: a stylesheet rule outliving the block
 * meant to stop it.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '..', '..')
const STYLESHEETS = ['src/index.css', 'src/landing/landing.css']

type Rule = {
  file: string
  selector: string
  body: string
  reduced: boolean
}

/**
 * Flatten rules out of their at-rule blocks, remembering whether each one sits inside
 * a reduced-motion query.
 *
 * Deliberately small and tolerant: strip comments, walk brace pairs, and record the
 * body so `!important` is inspectable. It is not a CSS parser and does not try to be.
 */
function parse(css: string, file: string): Rule[] {
  const rules: Rule[] = []
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '')

  let i = 0
  const walk = (reduced: boolean) => {
    while (i < stripped.length) {
      const brace = stripped.indexOf('{', i)
      if (brace === -1) return
      const selector = stripped.slice(i, brace).trim()

      // Find the matching close brace, tracking nesting.
      let depth = 1
      let j = brace + 1
      while (j < stripped.length && depth > 0) {
        if (stripped[j] === '{') depth += 1
        else if (stripped[j] === '}') depth -= 1
        j += 1
      }
      const body = stripped.slice(brace + 1, j - 1)
      i = j

      if (selector.startsWith('@')) {
        const isReduced = /prefers-reduced-motion\s*:\s*reduce/i.test(selector)
        // Re-enter the body at the same cursor so nested rules are seen as rules.
        const restart = i
        i = brace + 1
        walk(reduced || isReduced)
        i = restart
        continue
      }
      if (selector) rules.push({ file, selector, body, reduced })
    }
  }

  walk(false)
  return rules
}

const classesOf = (selector: string) => [...selector.matchAll(/\.([A-Za-z_][\w-]*)/g)].map((m) => m[1])

/**
 * Animations that are knowingly not covered, and why.
 *
 * These are all pre-existing and none of them is about type. They are listed rather
 * than left for the next person to rediscover, because "the test has an allowlist"
 * is only honest if the allowlist says what it is excusing.
 *
 *   status-open, status-dot,   an infinite 2.4s opacity pulse marking a poll that is
 *   live-badge, live-dot       currently open. The badge's colour and its label
 *                              already carry that; the pulse only draws the eye.
 *
 *   menu-panel,                a 140–200ms fade-and-rise on a dropdown and on a modal.
 *   modal-overlay, modal-content  It is an entrance, not a state: nothing is
 *                              concealed without it and nothing is lost without it.
 *
 *   loading-spinner,           a rotation while a command is in flight. The button it
 *   approval-waiting-spinner   sits in already reads "Working…" and the panel shows a
 *                              written status, so stopping the rotation would lose
 *                              nothing — but that is a judgement about how busy the
 *                              product should feel while it works, and it is not one to
 *                              make silently as part of a change to a font.
 *
 * Fixing these is a small change and is worth doing; it is a decision, not a chore,
 * and it was not asked for here.
 */
const KNOWN_UNCOVERED = new Set([
  'status-open',
  'status-dot',
  'live-badge',
  'live-dot',
  'menu-panel',
  'modal-overlay',
  'modal-content',
  'loading-spinner',
  'approval-waiting-spinner',
])

const all = STYLESHEETS.flatMap((file) => parse(readFileSync(join(ROOT, file), 'utf8'), file))
const animatedOutside = all.filter((r) => !r.reduced && /(?:^|[;{\s])animation(?:-name)?\s*:/.test(r.body))
const neutralisedClasses = new Set(
  all.filter((r) => r.reduced).flatMap((r) => classesOf(r.selector)),
)
const killSwitchRules = all.filter((r) => r.reduced && /animation\s*:\s*none\s*!important/.test(r.body))

describe('reduced motion', () => {
  it('finds the animations it is meant to police', () => {
    // If the parser ever stops matching, the assertion below goes vacuously true.
    // This is what notices.
    expect(animatedOutside.length).toBeGreaterThan(5)
    expect(neutralisedClasses.size).toBeGreaterThan(3)
  })

  it('switches off every class that declares an animation', () => {
    const uncovered = [
      ...new Set(
        animatedOutside
          .flatMap((r) => classesOf(r.selector))
          .filter((c) => !neutralisedClasses.has(c) && !KNOWN_UNCOVERED.has(c)),
      ),
    ]
    expect(
      uncovered,
      `these classes animate and no reduced-motion rule mentions them: ${uncovered.join(', ') || 'none'}`,
    ).toEqual([])
  })

  it('has not grown its allowlist', () => {
    // The allowlist above is a record of what is known, not a place to put the next
    // thing that turns up. Anyone adding to it owes a sentence in the comment.
    const stale = [...KNOWN_UNCOVERED].filter(
      (c) => !animatedOutside.some((r) => classesOf(r.selector).includes(c)),
    )
    expect(stale, `allowlisted but no longer animating: ${stale.join(', ') || 'none'}`).toEqual([])
  })

  it('still has its kill switch', () => {
    // `!important` and not a suggestion: a reader who asked for no motion should not
    // depend on every other selector in the file being less specific than this one.
    // It has been deleted twice; this is the alarm.
    expect(killSwitchRules.length).toBeGreaterThan(0)
    const covered = killSwitchRules.flatMap((r) => classesOf(r.selector))
    expect(covered).toContain('land-open-item')
    expect(covered).toContain('land-cue')
    expect(covered).toContain('land-bar')
  })
})