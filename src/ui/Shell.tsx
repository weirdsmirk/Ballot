/**
 * The two page frames the product is built from.
 *
 * `SiteBar` is the dark band that opens every non-console surface: the voter
 * portal and both sign-in screens. It is deliberately not the console's header
 * — an operator's screen and a voter's screen should not be the same screen —
 * but it uses the same brand, the same type and the same icon set.
 *
 * `AuthSplit` is the two-column sign-in frame. The left column states what the
 * product is for; the right column does the work. The columns are independent of
 * each other so that a longer form never pushes the message off the page.
 */

import type { ReactNode } from 'react'
import { Icon, type IconName } from './Icon'

export function Brand({ onNavigate, sub }: { onNavigate?: () => void; sub?: string }) {
  return (
    <button type="button" className="brand" onClick={onNavigate} aria-label="Ballot home">
      <span className="brand-mark" aria-hidden="true">
        <Icon name="ballot" strokeWidth={2} />
      </span>
      <span className="brand-name">
        ballot<span className="brand-dot">.</span>
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
              ballot<span className="brand-dot">.</span>
            </span>
          </span>
          <p className="site-foot-blurb">{left}</p>
        </div>
        {right && <p className="site-foot-meta">{right}</p>}
      </div>
    </footer>
  )
}

export function AuthSplit({
  eyebrow,
  headline,
  accent,
  lede,
  note,
  noteIcon = 'shield-check',
  children,
}: {
  eyebrow: string
  headline: string
  accent?: string
  lede: string
  note?: { title: string; detail: string; icon?: IconName }
  noteIcon?: IconName
  children: ReactNode
}) {
  return (
    <div className="auth-split">
      <SiteBar />
      <div className="auth-split-body">
        <div className="auth-hero">
          <span className="eyebrow eyebrow-blue">{eyebrow}</span>
          <h1>
            {headline}
            {accent && <span className="accent">{accent}</span>}
          </h1>
          <p className="auth-hero-lede">{lede}</p>
          {note && (
            <>
              <div className="auth-hero-rule" />
              <div className="auth-hero-note">
                <Icon name={note.icon ?? noteIcon} />
                <div>
                  <strong>{note.title}</strong>
                  <span>{note.detail}</span>
                </div>
              </div>
            </>
          )}
        </div>
        <div className="auth-panel">{children}</div>
      </div>
    </div>
  )
}
