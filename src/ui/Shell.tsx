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
    </header>
  )
}

export function SiteFoot({ left, right }: { left: ReactNode; right?: ReactNode }) {
  return (
    <footer className="site-foot">
      <span>
        <Icon name="lock" />
        {left}
      </span>
      {right && <span>{right}</span>}
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
