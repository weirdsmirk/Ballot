/**
 * Whether this reader has asked for a particular theme, and how to apply one.
 *
 * Three answers rather than two, because "no answer" is a real state and it is not
 * the same as dark: a reader who has never chosen is following their operating
 * system, and a reader who has chosen is not. Collapsing those two into one boolean
 * is how a preference ends up being ignored — the reader sets light, changes their
 * OS to dark for something else, and the app silently reverts.
 *
 * `system` is the default and is stored as the absence of a key rather than as a
 * value, so a reader who has never touched the control is indistinguishable from a
 * reader who explicitly chose to follow the system. There is no difference between
 * them to preserve.
 *
 * The key is versioned. A theme is a set of design decisions, and when the light
 * palette is next revised there is no way to tell a stored `light` from a stale one,
 * so the value is suffixed and an unrecognised one falls back rather than applying
 * a palette this build no longer has.
 */

const KEY = 'ballot.theme.v1'
export type Theme = 'system' | 'dark' | 'light'

/**
 * Apply a theme to the document.
 *
 * `data-theme` is only ever written for an explicit choice. For `system` the
 * attribute is removed rather than set to `'system'`, because the CSS keys off the
 * attribute's *presence* and a `[data-theme]` selector that also matched the word
 * `'system'` would need the light block to exclude it by name — one more thing to get
 * wrong the next time a theme is added.
 */
function apply(theme: Theme): void {
  const root = document.documentElement
  if (theme === 'system') {
    root.removeAttribute('data-theme')
    return
  }
  root.setAttribute('data-theme', theme)
}

function stored(): Theme {
  try {
    const raw = window.localStorage.getItem(KEY)
    return raw === 'dark' || raw === 'light' ? raw : 'system'
  } catch {
    // A browser with storage disabled is a browser that cannot remember a
    // preference. It still gets this session's theme; it just starts from the
    // system again next time, which is the correct degradation.
    return 'system'
  }
}

/**
 * The theme in force right now, resolved.
 *
 * `system` resolves through `matchMedia`, so this is the *effective* theme rather
 * than the stored one. The control needs both: the label says what is happening, and
 * the label is only true if the system preference is consulted here rather than in
 * the CSS.
 */
export function resolved(theme: Theme): 'dark' | 'light' {
  if (theme !== 'system') return theme
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

export function current(): Theme {
  return stored()
}

/**
 * Read the stored choice and put it on the document before the first paint.
 *
 * Called from the inline script in `index.html` as well as from the app, so the
 * module is the single definition of the key and both callers agree. The inline copy
 * duplicates three lines deliberately: a module import here would be a network
 * round trip, and a flash of the wrong theme on every load is worse than three lines
 * of duplication.
 */
export function boot(): void {
  apply(stored())
}

/** Store a choice and apply it. Returns nothing; the document is the source of truth. */
export function set(theme: Theme): void {
  try {
    if (theme === 'system') window.localStorage.removeItem(KEY)
    else window.localStorage.setItem(KEY, theme)
  } catch {
    // Nothing to do. The theme still applies for this page view, which is strictly
    // better than refusing to switch because the browser would not store it.
  }
  apply(theme)
}

/**
 * Called once, so a reader following the system sees the app follow it when the OS
 * changes at sunset.
 *
 * This only fires for `system`. Someone who has explicitly chosen a theme has said
 * what they want, and an operating-system change is not a reason to overrule them.
 */
export function watchSystem(onChange: () => void): () => void {
  const query = window.matchMedia('(prefers-color-scheme: light)')
  const handler = () => {
    if (stored() === 'system') {
      onChange()
    }
  }
  query.addEventListener('change', handler)
  return () => query.removeEventListener('change', handler)
}