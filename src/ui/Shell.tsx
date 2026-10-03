/**
 * The page frames the product is built from.
 *
 * `SiteBar` is the dark band that opens every non-console surface: the voter
 * portal. It is deliberately not the console's header — an operator's screen and
 * a voter's screen should not be the same screen — but it uses the same brand,
 * the same type and the same icon set.
 *
 * `AuthFrame` is the sign-in page, and the only surface with no `SiteBar`: it is
 * a full-bleed 50/50 split instead, because that page is the product's first
 * impression and the photograph is half of it.
 */

import type { ReactNode } from 'react'
import { Icon } from './Icon'

/**
 * The wordmark.
 *
 * Pure text: no device, no tile, no mark. A logo is a claim about being a
 * product, and the one thing this product is arguing against is a ballot that
 * looks like a widget — so the name carries it on its own. Set in the sans with
 * a capital, because the serif display face is for things being said, not for
 * the thing saying them; the green full stop is the only ornament left.
 *
 * Used by the portal header, the sign-in frame and the console, all three, so the
 * lockup cannot differ between the pages a person moves between.
 */
export function Brand({ onNavigate, sub }: { onNavigate?: () => void; sub?: string }) {
  return (
    <button type="button" className="brand" onClick={onNavigate} aria-label="Ballot home">
      <span className="brand-name">
        Ballot<span className="brand-dot">.</span>
      </span>
      {sub && <span className="control-brand-sub">{sub}</span>}
    </button>
  )
}

export function SiteBar({ meta, children }: { meta?: ReactNode; children?: ReactNode }) {
  return (
    <header className="site-bar">
      {/* The row is a separate element so the bar itself can stay full-bleed while
          its contents line up with the page measure below. */}
      <div className="site-bar-inner">
        <Brand onNavigate={() => { window.location.hash = '#/' }} />
        {meta ?? (
          <span className="site-bar-meta">
            <Icon name="lock" />
            Local workspace
            <span className="site-bar-sep">·</span>
            {typeof window !== 'undefined' ? window.location.host : 'local'}
          </span>
        )}
        {children}
      </div>
    </header>
  )
}

/**
 * The page footer.
 *
 * Two zones and nothing else: the product's identity with the one sentence it
 * makes on its way out, and a line of fine print. That is deliberately short —
 * a footer that starts behaving like a second navigation has stopped being a
 * footer — but it is a *block*, not two labels pinned to opposite ends of a wide
 * bar. The statement is set in the display serif because it is the closing
 * remark rather than a label, and the fine print uses the letterspaced sans that
 * every other machine fact in the product uses.
 *
 * The wordmark is a figure here, not a link: the header already owns navigation,
 * and a second control labelled "Ballot home" is a duplicate landmark.
 */
export function SiteFoot({ left, right }: { left: ReactNode; right?: ReactNode }) {
  return (
    <footer className="site-foot">
      <div className="site-foot-inner">
        <div className="site-foot-identity">
          <span className="site-foot-brand" aria-hidden="true">
            <span className="brand-mark">
              <Icon name="ballot" strokeWidth={2} />
            </span>
            <span className="brand-name">
              Ballot<span className="brand-dot">.</span>
            </span>
          </span>
          <p className="site-foot-blurb">{left}</p>
        </div>
        {right && <p className="site-foot-meta">{right}</p>}
      </div>
    </footer>
  )
}

/**
 * The sign-in frame.
 *
 * Two equal halves: a photograph on one side, the work on the other. The split is
 * `1fr 1fr`, so it is exactly half the width at every size rather than
 * approximately half.
 *
 * The photograph is not a picture beside the form — it is half the page, which is
 * why the brand and the promise are set on top of it and the form gets an
 * uninterrupted half to itself. It also means this frame carries no top band and
 * no footer: both would eat into the two halves the composition is built on, and
 * everything they said is already here — the wordmark is reversed out of the
 * photograph, and the footer's promise is the statement beneath it.
 *
 * `children` is the working half: the hero and then the form.
 */
export function AuthFrame({
  children,
  statement,
  meta,
}: {
  children: ReactNode
  statement: string
  meta?: ReactNode
}) {
  return (
    <div className="auth-frame">
      <div className="auth-frame-media">
        <img
          className="auth-frame-image"
          src="/ballot.webp"
          /* The photograph carries the argument for the product, so it gets a real
             description rather than `alt=""`. The intrinsic size is declared so
             the browser reserves the box before the bytes arrive. */
          alt="Three hands putting folded ballots into the slot of a ballot box."
          width={1086}
          height={1448}
          /* Largest contentful paint on the most important page in the product:
             fetched eagerly and at high priority. */
          loading="eager"
          fetchPriority="high"
          decoding="async"
        />
        <div className="auth-frame-scrim" aria-hidden="true" />

        <div className="auth-frame-media-inner">
          <Brand onNavigate={() => { window.location.hash = '#/' }} />

          <div className="auth-frame-caption">
            <p className="auth-frame-statement">{statement}</p>
            {meta && <p className="auth-frame-meta">{meta}</p>}
          </div>
        </div>
      </div>

      <main className="auth-frame-panel">
        <div className="auth-frame-inner">{children}</div>
      </main>
    </div>
  )
}
