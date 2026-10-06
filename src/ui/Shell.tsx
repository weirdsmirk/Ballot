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
 * looks like a widget — so the name carries it on its own.
 *
 * Set in Inter, the interface face, at weight 500 and tracked in tight, rather
 * than the serif it used to be. Instrument Serif is what this product uses for
 * things being *announced* — headlines, results, receipts — so putting the name in
 * it made the mark claim to be an argument rather than a name. A neutral sans says
 * "this is the thing" and nothing more. The green full stop is the only ornament
 * left.
 *
 * Used by the portal header, the sign-in frame, the console and the miniature
 * ballot preview, all four, so the lockup cannot differ between the pages a
 * person moves between.
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

/**
 * The way back, for pages that are somewhere other than home.
 *
 * A document opened from the footer leaves the reader stranded: they scroll to
 * the bottom and there is no control, because the footer they came in through is
 * the only navigation on the page and it only goes sideways. The browser's back
 * button works, but requiring someone to know that is not a navigation scheme.
 *
 * So the document says where it goes, and goes there. `to` is the surface they
 * arrived from, tracked in App, because "back" on the privacy notice should
 * return a voter to the portal they were voting in rather than dumping them on
 * the sign-in.
 */
export function BackLink({ to, label }: { to: string; label: string }) {
  return (
    <a className="back-link" href={to}>
      <Icon name="arrow-left" />
      {label}
    </a>
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
 * Three things and nothing else: the product at a size that reads as a
 * signature, one honest sentence about the page you are on, and the three
 * documents nobody should have to hunt for.
 *
 * The signature is the same condensed wordmark as the header, not the serif it
 * used to be. A footer wordmark in the display face was the same argument made
 * twice on one screen, and at 46px the second one was louder.
 *
 * The mark is gone. The wordmark is the logo now, and at this scale a 26px tile
 * beside it was a postage stamp.
 *
 * `sub` is one honest sentence, and it varies by surface because the claim is not
 * the same on each: "No credentials leave this server" is something a sign-in can
 * back and the portal cannot say. It is deliberately small and sans. At the old
 * 18px serif it sat under a 19px wordmark and the two competed as peers; scaled
 * up under the 46px wordmark it would be a second signature trying to sign the
 * same page. At 13px muted sans it is the caption to the name, which is the
 * thing you read after you already have the name.
 *
 * The links are real routes, not decoration. Every one of them opens a document
 * that says what the software does rather than what it promises.
 */
export function SiteFoot({ sub }: { sub: ReactNode }) {
  return (
    <footer className="site-foot">
      <div className="site-foot-inner">
        <div className="site-foot-identity">
          <p className="site-foot-wordmark">
            Ballot<span className="brand-dot">.</span>
          </p>
          <p className="site-foot-sub">{sub}</p>
        </div>

        <nav className="site-foot-nav" aria-label="Legal and policy">
          <a href="#/legal">Legal notices</a>
          <a href="#/terms">Terms</a>
          <a href="#/privacy">Privacy</a>
        </nav>
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
/**
 * Home.
 *
 * `#/`, which is the root and resolves to the front door. From anywhere else in the
 * product that is a navigation, so setting the hash is enough.
 *
 * From the front door itself it is a no-op, and that is correct rather than broken:
 * the wordmark on this screen is the wordmark of the page you are already on, and a
 * control that does nothing is the right control for "you are here". It used to also
 * scroll to the top, because the front door used to be the second screen of a landing
 * page that reached it by scrolling, and a reader standing on that screen could be a
 * full viewport down a document they had already been sent past.
 */
function goHome() {
  window.location.hash = '#/'
}

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
          <Brand onNavigate={goHome} />

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
