/**
 * Nothing may animate that a reduced-motion reader would see animate.
 *
 * This exists because that has happened twice.
 *
 * The first time, an exclusion lost a specificity fight and left three animations
 * running for a reader who had asked for none. The second time was dumber: a whole
 * `prefers-reduced-motion` block was deleted while the sections below it were being
 * removed, because it sat immediately after them and nothing in the file said the
 * two were related. Six animations came back.
 *
 * Both failures are invisible to every other check here. The CSS parses, the build
 * passes, and every element's resting state is correct — the design *is* the resting
 * state, which is exactly why nothing looks broken. It only shows up by counting
 * `document.getAnimations()` in a browser with the media feature emulated, by hand.
 *
 * So this asserts it statically instead. It will not catch an animation added at
 * runtime by script; that still needs the browser probe. What it catches is the
 * failure that actually happened: a rule outliving the block meant to stop it.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/*
 * Anchored to the project root, not to this file.
 *
 * The test lived in `src/landing/` and read that directory's stylesheet, so it used
 * `__dirname`. Moved up a level, `__dirname` under vitest is not what a plain Node
 * module would give you, and the read silently went looking one directory too high.
 * `process.cwd()` is where vitest is invoked from, which is the one path this
 * project controls.
 */
const STYLESHEET = join(process.cwd(), 'src', 'index.css')

type Rule = { selector: string; body: string; reduced: boolean }

/** The index of the `}` matching the `{` at `open`. */
function matchBrace(css: string, open: number): number {
  let depth = 0
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1
    else if (css[i] === '}') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return css.length
}

/**
 * Flatten rules out of their at-rule blocks, remembering whether each sits inside a
 * reduced-motion query.
 *
 * A single left-to-right pass over brace pairs, recursing only into at-rules. Not a
 * CSS parser and does not try to be.
 *
 * The first version of this walked with a shared cursor and rewound it after each
 * at-rule, and it was wrong: an at-rule whose body ran to the end of the file made
 * the recursion return early with the cursor un-advanced, so the caller rewound and
 * re-walked the same text. It reported 131,546 rules in a 4,400-line file, and the
 * two assertions still passed — which is the part worth remembering. A test whose
 * parser is broken can still be green, and a "did you find anything?" assertion is
 * what is supposed to stop exactly that.
 */
function parse(css: string, reduced = false): Rule[] {
  const rules: Rule[] = []
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '')

  let i = 0
  while (i < stripped.length) {
    const open = stripped.indexOf('{', i)
    if (open === -1) break
    const close = matchBrace(stripped, open)
    const selector = stripped.slice(i, open).trim()
    const body = stripped.slice(open + 1, close)
    i = close + 1

    if (selector.startsWith('@')) {
      const inner = /prefers-reduced-motion\s*:\s*reduce/i.test(selector)
      rules.push(...parse(body, reduced || inner))
    } else if (selector) {
      rules.push({ selector, body, reduced })
    }
  }
  return rules
}

const classesOf = (selector: string) => [...selector.matchAll(/\.([A-Za-z_][\w-]*)/g)].map((m) => m[1])

const rules = parse(readFileSync(STYLESHEET, 'utf8'))
const animatedOutside = rules.filter(
  (r) => !r.reduced && /(?:^|[;{\s])animation(?:-name)?\s*:/.test(r.body),
)
const neutralised = new Set(rules.filter((r) => r.reduced).flatMap((r) => classesOf(r.selector)))
const killSwitch = rules.filter((r) => r.reduced && /animation\s*:\s*none\s*!important/.test(r.body))

describe('reduced motion', () => {
  it('finds the animations it is meant to police', () => {
    // A guard on the parser, and it earns its place: it is the assertion that would
    // have caught the 131,546-rule rewrite, which passed everything else.
    expect(rules.length).toBeGreaterThan(400)
    expect(rules.length).toBeLessThan(2000)
    expect(animatedOutside.length).toBeGreaterThan(3)
  })

  it('switches off every class that declares an animation', () => {
    const uncovered = [
      ...new Set(
        animatedOutside
          .flatMap((r) => classesOf(r.selector))
          .filter((c) => !neutralised.has(c)),
      ),
    ]
    expect(
      uncovered,
      `these classes animate and no reduced-motion rule mentions them: ${uncovered.join(', ') || 'none'}`,
    ).toEqual([])
  })

  it('has a kill switch rather than a suggestion', () => {
    // `!important`, because a reader who has asked for no motion should not depend on
    // every other selector in a 4,400-line stylesheet being less specific than this.
    const covered = killSwitch.flatMap((r) => classesOf(r.selector))
    expect(covered.length).toBeGreaterThan(0)
    for (const cls of covered) expect(neutralised.has(cls)).toBe(true)
  })

  it('covers every animated class with one block', () => {
    // One block, not a list of scattered overrides. Two blocks is how the two get
    // tangled and one of them gets deleted.
    const blocks = readFileSync(STYLESHEET, 'utf8').match(/prefers-reduced-motion/g) ?? []
    expect(blocks).toHaveLength(1)
  })
})