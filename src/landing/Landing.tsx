/**
 * The landing page.
 *
 * A separate surface from the front door, deliberately. The door at `#/enter` is
 * two questions and a photograph: it exists to get an officer to a password and
 * a voter to a ballot, and every pixel of it is in the way of that. This page is
 * allowed to take a minute, scroll, and use motion, because nothing here is
 * standing in front of anybody's vote.
 *
 * It is two screens and both are the same thing at different depths:
 *
 *   1. Cold open.      The photograph, one claim, and the way in.
 *   2. The selection.  What is actually on this server, as a list you can pick
 *                      from. Read from the elections the server returned, never
 *                      invented.
 *
 * It used to be six sections — secrecy, the lifecycle graph, coverage, live
 * figures, and two doors at the foot — and the argument it made was that an
 * election is a record and the record is the product. That argument was true and
 * it was also four screens of reading in front of the one thing a visitor came
 * for, which is a ballot. The record is still the product; it is now the thing
 * you pick from rather than the thing you scroll past.
 *
 * Two rules held throughout:
 *
 *   · **No decorative data.** Everything on the second screen is computed from the
 *     elections the server actually returned. There are no testimonials, no
 *     customer logos, no invented adoption figures — for a product whose entire
 *     argument is that its claims are checkable, a fabricated metric on the front
 *     page would be the one thing that could sink it.
 *   · **Motion explains, it does not decorate.** The opening is the only thing
 *     that moves on its own, and it moves once. The second screen arrives because
 *     the reader scrolled to it, like everything else on the page.
 */

import { useEffect } from 'react'
import { ChooseDoorway } from '../ui/Doorway'
import { Icon } from '../ui/Icon'
import './landing.css'

/* ========================================
   Copy
   ======================================== */

/* The opening. */
const OPEN = {
  /*
   * The claim, and nothing above it.
   *
   * There used to be an "Election workspace" eyebrow here. It went because the claim
   * is display type at up to 124px with a photograph behind it, and an eyebrow above
   * it is a third horizontal element competing with the only two that matter — and
   * because the photograph already says what this is. A ballot box with a hand above
   * it is the product's subject, not its caption.
   *
   * One string, not two. It was split across a line break for two revisions, which
   * put the verb over the noun and gave a two-word headline the width of a
   * sixteen-word sentence. It reads as one line now, which is how it is written.
   *
   * The full stop is a separate span. A period is punctuation and this is a title,
   * and separating it costs nothing.
   */
  claim: 'Make Count',
  /*
   * The lede, and why it no longer matches the front door.
   *
   * It used to open "Ballot runs the whole election from one machine" — the same
   * sentence the front door shows, deliberately, so that a reader who clicks through
   * finds the landing page and the page they land on saying the same thing. That
   * parity is broken here on purpose: this lede no longer names Ballot, because the
   * claim directly above it already does, and a line that repeats the wordmark is
   * spending its one sentence on nothing.
   *
   * It is also 98 characters against 171, which is the reason the opening's
   * measurement cap could come down. The lede is now a comfortable measure rather
   * than a 171-character line, and the comment on the cap records the old number so
   * the next person to widen it knows what it was.
   */
  lede:
    'Run elections from one place, with controlled roles and a complete record of every action.',
}

/* ========================================
   Motion
   ======================================== */

/**
 * The reveal observer.
 *
 * One observer for the page, not one per element: an observer per element means
 * the same intersection maths several hundred times over. Elements declare
 * themselves with `data-reveal` and are marked once and never unmarked — an
 * element that has arrived does not need to un-arrive when it leaves the screen,
 * and re-running the animation on the way back is the single most common way a
 * scroll-reveal page ends up feeling broken rather than calm.
 *
 * The root margin pulls the trigger line well above the bottom edge so a section
 * has usually finished arriving before it is read. A reveal that fires as the
 * element touches the fold is a reveal that is always late.
 */
function useReveal() {
  useEffect(() => {
    const targets = Array.from(
      document.querySelectorAll<HTMLElement>('[data-reveal]'),
    )

    // Reduced motion means the page is already in its resting state. Marking
    // everything revealed up front is the whole treatment — no CSS override
    // needed, and no way for the two to disagree about what "settled" looks like.
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      for (const el of targets) el.dataset.revealed = 'true'
      return
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          (entry.target as HTMLElement).dataset.revealed = 'true'
          observer.unobserve(entry.target)
        }
      },
      { rootMargin: '0px 0px -18% 0px', threshold: 0.05 },
    )
    for (const el of targets) observer.observe(el)
    return () => observer.disconnect()
  }, [])
}

/**
 * The register's drift.
 *
 * The measured grid behind the page moves a fraction of the scroll distance, which
 * is the difference between a grid that is part of the page and one that is
 * bolted to the screen. A tenth — so a 6000px scroll moves it 600px, roughly one
 * and a quarter screens over the length of the whole page. Any more and it stops
 * being a texture and starts being parallax, which is a trick; any less and it is
 * not worth the frame.
 *
 * One `transform` on one fixed layer, coalesced to a single write per frame, and
 * it never touches layout. This is the only continuous work the page does, and it
 * is skipped entirely under reduced motion.
 */
function useRegisterDrift() {
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const layer = document.querySelector<HTMLElement>('.land-register')
    if (!layer) return

    let frame = 0
    const write = () => {
      frame = 0
      layer.style.transform = `translate3d(0, ${window.scrollY * 0.1}px, 0)`
    }
    const onScroll = () => {
      if (frame) return
      frame = requestAnimationFrame(write)
    }

    window.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      if (frame) cancelAnimationFrame(frame)
      window.removeEventListener('scroll', onScroll)
      layer.style.transform = ''
    }
  }, [])
}

/**
 * The curtain: the hero lifting off the selection screen.
 *
 * The hero is a curtain being raised. The selection screen is pinned behind it and
 * the hero is translated up by exactly the distance the reader has scrolled, so the
 * two move as one: the photograph and the claim go up and out, and the doors are
 * already there underneath.
 *
 * Driven by scroll rather than by a timer, which is the whole reason it is worth
 * having as a mechanism at all. A timed reveal cannot be reversed, and this one can:
 * scroll back and the curtain comes down. It also means the hero's button, which
 * scrolls to this screen, opens the same curtain rather than setting off a second
 * animation that would then have to be kept in step with this one.
 *
 * A `transform`, and nothing else. One element, one property, coalesced to a single
 * write per frame. `translate3d` rather than `translateY` so the lift is composited
 * and never touches layout — the same argument as the register's drift, and the same
 * code shape.
 *
 * Under reduced motion the hero is not lifted at all: the stylesheet stops pinning
 * and the two screens go back to being two screens in flow, and this writes nothing.
 * A curtain that a reader asked not to see must not be a curtain they are stuck
 * behind.
 */
function useCurtain() {
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return

    const stage = document.querySelector<HTMLElement>('.land-stage')
    const hero = document.querySelector<HTMLElement>('.land-open')
    if (!stage || !hero) return

    let frame = 0
    let last = -1
    const write = () => {
      frame = 0
      const travel = stage.offsetHeight - window.innerHeight
      if (travel <= 0) return
      const passed = -stage.getBoundingClientRect().top
      const progress = Math.min(1, Math.max(0, passed / travel))
      // Written only when it moved. A scroll that does not change the progress — the
      // trackpad jitter at the end of the page, a momentum tail on a phone — must not
      // cost a style recalculation.
      const next = Math.round(progress * 1000) / 1000
      if (next === last) return
      last = next
      hero.style.transform = `translate3d(0, ${-next * travel}px, 0)`
    }
    const onScroll = () => {
      if (frame) return
      frame = requestAnimationFrame(write)
    }

    write()
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll)
    return () => {
      if (frame) cancelAnimationFrame(frame)
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
      hero.style.transform = ''
    }
  }, [])
}

export function Landing() {
  useReveal()
  useRegisterDrift()
  useCurtain()

  const go = (hash: string) => { window.location.hash = hash }

  /*
    The primary button, and what it does.

    It scrolls to the end of the stage, which is the selection screen, and the same
    lift the reader's own scroll produces follows it.

    A measured distance rather than `scrollIntoView` on the selection screen, because
    that screen is `position: sticky` and a sticky element's bounding box is always
    inside the viewport — `scrollIntoView` reads that as "already there" and does
    nothing at all. The button looked wired up and did nothing, which is the worst
    failure mode a primary button has. The distance is the stage's height less the
    viewport, which is the same number the lift is measured against, so the two cannot
    disagree.

    `smooth`, because the alternative is an instant jump of a full viewport with the
    curtain not part way up.
  */
  const goToDoor = () => {
    const stage = document.querySelector<HTMLElement>('.land-stage')
    if (!stage) return
    window.scrollTo({ top: stage.offsetHeight - window.innerHeight, behavior: 'smooth' })
  }

  
  return (
    <div className="land">
      <a className="land-skip" href="#land-body">Skip to content</a>

      {/* The frame. Three layers over the whole page: a vignette that holds the
          edges, grain that makes the near-black read as a photographed surface
          rather than as an empty div, and the measured register drifting behind
          everything. All static except the register's parallax. */}
      <div className="land-vignette" aria-hidden="true" />
      <div className="land-register" aria-hidden="true" />
      <div className="land-grain" aria-hidden="true" />

      <main id="land-body">
        {/*
          The stage: two screens, one gesture.

          The selection screen is pinned and the hero is lifted off it, so the hero
          rises like a curtain with the next scene already set behind it. The
          alternative — two screens in ordinary flow — slides the hero away and then
          brings the second one up through the gap, which is two movements where the
          gesture only needs one.

          The hero comes first in the document and is on top by `z-index`, not the other
          way round. Document order is what a screen reader and the Tab key follow, and
          what a reader who asked for no motion follows once the stylesheet puts both
          screens back into flow — in all three of those the hero is the first screen
          and has to be first in the source too.
        */}
        <div className="land-stage">
          {/* ---- 1. The cold open -----------------------------------------
              A title card, not a sales panel: the photograph owns the frame, the
              type sits in the lower third where a title card sits, and the only
              motion is the light building. It plays once, on load, over about two
              and a half seconds — long enough to feel like a frame being
              developed rather than a component being mounted.

              The bar is inside this section so it lifts off with it. It was a
              sibling, positioned against the page, which meant it stayed put while
              the hero left — leaving the bar floating over the selection screen,
              which has a wordmark of its own in the corner of its photograph. */}
          <section className="land-open">
            <header className="land-bar">
              <button type="button" className="brand" onClick={() => window.scrollTo({ top: 0 })} aria-label="Ballot, back to the top">
                <span className="brand-name">Ballot<span className="brand-dot">.</span></span>
              </button>
              {/*
                The bar has one control now.

                It had three links — Lifecycle, Coverage, Documents — and all three
                pointed at sections that are gone. Nothing is lost: the three legal
                pages are on the front door's own screen, and "Sign in" is the one
                destination on this page that goes somewhere else.
              */}
              <nav className="land-bar-nav" aria-label="Sections">
                <button type="button" className="btn-outline" onClick={() => go('#/enter')}>
                  Sign in
                  <Icon name="arrow-right" />
                </button>
              </nav>
            </header>
            {/*
              The plate. `alt=""` because the opening carries the claim in type and
              this is a decorative bed under it — the same photograph is described
              properly on the front door, where it is the argument rather than the
              background.

              The 16:9 frame, not the portrait one. Covering a wide viewport with the
              portrait crop put the ballot box in the middle of the frame and cropped
              the hand — the one part of the photograph the product is about — off
              the top. This composition holds the hand, the ballot and the slot, and
              puts the box on the left where the empty half of the frame is.

              WebP with no fallback, the same as `ballot.webp` on the front door. A
              `<picture>` with a PNG source was here and has been removed: the source
              file is gone from `public/`, and a fallback pointing at a missing file
              is worse than no fallback — it turns a format the browser does not
              support into a broken image instead of a photograph.
            */}
            <div className="land-open-plate" aria-hidden="true">
              <img
                className="land-open-image"
                src="/ballot16x9.webp"
                alt=""
                width={1672}
                height={941}
                loading="eager"
                fetchPriority="high"
                decoding="async"
              />
            </div>
            <div className="land-open-scrim" aria-hidden="true" />

            <div className="land-open-body">
            <h1 className="land-claim">
              {/*
                One line. It was split across a break for two revisions, which gave a
                two-word headline the width of a sixteen-word sentence.
              */}
              <span className="land-claim-line land-open-item" data-open="1">
                {OPEN.claim}
                <span className="land-claim-stop">.</span>
              </span>
            </h1>
            <p className="land-open-lede land-open-item" data-open="2">{OPEN.lede}</p>
            {/*
              The one button, and it opens the curtain.

              It pointed at `#/enter` — the front door — until the landing page became
              two screens with the front door as the second of them. It scrolls now, so
              the reader gets the same gesture either way rather than being taken off
              this page and onto a second copy of the thing one scroll below.
            */}
            <div className="land-open-actions land-open-item" data-open="3">
              <button type="button" className="btn-primary btn-lg" onClick={goToDoor}>
                Enter Workspace
              </button>
            </div>
          </div>

          <div className="land-cue" aria-hidden="true">
              <span className="land-cue-label">Scroll</span>
              <svg className="land-cue-arrow" viewBox="0 0 12 7" aria-hidden="true" focusable="false">
                <path
                  d="M1 1l5 5 5-5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              </div>
          </section>

        {/*
          ---- 2. The selection ----------------------------------------------

          The front door, as the second screen of this page.

          It is not a restatement of the front door and not a copy of it — it *is* the
          front door, `ChooseDoorway`, the same component `#/enter` renders. A visitor
          who scrolls here and a visitor who types the hash must see the same two
          choices, and one component is the only way that stays true.

          It carries no reveal of its own. It is simply set, and the hero above it is
          what moves; anything that also animated here would be two effects chasing one
          gesture.
        */}
        <section className="land-door" id="land-door" aria-label="Choose where to go next">
          <ChooseDoorway onAdmin={() => go('#/enter')} />
        </section>
        </div>
      </main>
    </div>
  )
}
