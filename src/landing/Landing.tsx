/**
 * The landing page.
 *
 * A separate surface from the front door, deliberately. The door at `#/enter` is
 * two questions and a photograph: it exists to get an officer to a password and
 * a voter to a ballot, and every pixel of it is in the way of that. This page
 * exists to answer a different question — *what is this thing, and can I trust
 * it* — and it is allowed to take a minute, scroll, and use motion, because
 * nothing here is standing in front of anybody's vote.
 *
 * The premise the whole page is built on: **an election is a record, and the
 * record is the product.** So the page is not organised as a feature list. It is
 * an argument, in the order somebody who does not yet trust an election platform
 * would ask it:
 *
 *   1. Cold open.       The photograph, one claim, the door.
 *   2. Secrecy.         The central promise, and the artifact that keeps it —
 *                       a receipt the voter can check and the server cannot read.
 *   3. The lifecycle.   The real transition graph, scrubbed by scrolling. Not a
 *                       row of status pills: the actual states and the actual
 *                       edges, including the branch nobody's marketing page draws.
 *   4. Coverage.        What one installation covers. Dense, typographic, small.
 *   5. This workspace.  Real figures, read from the running server. Never
 *                       invented — if the server is empty the section says so.
 *   6. The two doors.   The same two destinations the front door offers.
 *
 * Two rules held throughout:
 *
 *   · **No decorative data.** Every number on this page is computed from the
 *     elections the server actually returned. There are no testimonials, no
 *     customer logos, no invented adoption figures — for a product whose entire
 *     argument is that its claims are checkable, a fabricated metric on the front
 *     page would be the one thing that could sink it.
 *   · **Motion explains, it does not decorate.** The one scroll-driven sequence
 *     is the lifecycle, because watching an election advance is the thing worth
 *     watching. Everything else is arrival and emphasis.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { fetchState, type Bootstrap } from '../lib/api'
import {
  ELECTION_STATUSES,
  ELECTION_TYPE_LABELS,
  ELECTION_TYPES,
  RESULTS_VISIBILITIES,
  type ElectionStatus,
  type ResultsVisibility,
} from '../lib/types'
import { STATUS_DESCRIPTIONS, STATUS_LABELS } from '../lib/lifecycle'
import { ADMIN_ROLES, ROLE_DESCRIPTIONS, ROLE_LABELS } from '../lib/rbac'
import { Icon } from '../ui/Icon'
import './landing.css'

/* ========================================
   Copy
   ======================================== */

/**
 * The opening.
 *
 * The claim and the lede are the same words the front door uses, deliberately. A
 * landing page that says something different from the page you land on when you
 * click through is a landing page that is selling a different product, and the
 * only way to check that claim is to click.
 */
const OPEN = {
  /*
   * The claim, and nothing above it.
   *
   * There used to be an "Election workspace" eyebrow here. It went because the claim
   * is two lines of display serif at up to 168px with a photograph behind it, and
   * an eyebrow above it is a third horizontal element competing with the only two
   * that matter — and because the photograph already says what this is. A ballot
   * box with a hand above it is the product's subject, not its caption.
   */
  claim: ['Run elections', 'with confidence.'],
  lede:
    'Ballot runs the whole election from one machine. Five roles decide who may open the poll, certify the result or only read, and every administrative action is written down.',
}

/**
 * Section two: the product's central claim, and the mechanism that keeps it.
 *
 * The receipt is the artifact the entire design is pointed at. A voter leaves
 * with a code they can check; the server keeps only a keyed digest of it. Those
 * two facts cannot both be true unless the stored value is one-way, which is
 * what makes "your vote is secret" a property of the system rather than a promise
 * about how careful the people running it are.
 */
const SECRECY = {
  eyebrow: 'Ballot secrecy',
  headline: 'A ballot is never stored against the person who cast it.',
  detail:
    'The roll, the one-time codes and the audit trail live on this machine and nowhere else. What a voter takes away is a receipt — the only record that a ballot was cast, and one that can be checked later without revealing the choice.',
  /**
   * A schematic of the two records, not a screenshot and not a sample from the
   * workspace. The receipt code is the format the server issues, shown as a
   * placeholder because an invented code would be a real-looking value that
   * verifies against nothing.
   */
  receipt: {
    eyebrow: 'What the voter takes away',
    code: 'XXXX-XXXX-XXXX-XXXX-XXXX',
    caption: 'Shown once, at the moment of voting. The voter can check it later.',
  },
  stored: {
    eyebrow: 'What the server keeps',
    digest: '4f2a9c1e7b3d0a58',
    caption: 'A keyed digest of the code. It answers yes or no, and cannot be run backwards.',
  },
}

/**
 * Section three: the lifecycle, as the graph it actually is.
 *
 * `paused` is a branch off `open`, not a link in a chain — a poll can pause and
 * resume and end up exactly where it was. Lining the seven states up in a row,
 * which is what every election product's feature table does, would say a thing
 * this product does not do. So the spine is the six states that only move
 * forward, and the branch hangs below it.
 *
 * The rail is scrubbed by scrolling rather than by hovering or by a timer. The
 * section is worth the scroll height precisely because an election advancing is
 * the thing nobody can show you in a static diagram.
 */
const SPINE: ElectionStatus[] = ['draft', 'scheduled', 'open', 'closed', 'certified', 'archived']
const BRANCH: ElectionStatus = 'paused'

/** What moves an election along the spine, named the way the console names it. */
const SPINE_EDGES: { from: ElectionStatus; to: ElectionStatus; action: string }[] = [
  { from: 'draft', to: 'scheduled', action: 'Publish' },
  { from: 'scheduled', to: 'open', action: 'Open voting' },
  { from: 'open', to: 'closed', action: 'Close voting' },
  { from: 'closed', to: 'certified', action: 'Certify' },
  { from: 'certified', to: 'archived', action: 'Archive' },
]

/** Section four: what one installation covers. Capabilities, all checkable. */
const VISIBILITY_LABELS: Record<ResultsVisibility, string> = {
  live: 'Live during the poll',
  after_close: 'After voting closes',
  after_certify: 'Once certified',
  never: 'Never published',
}

const COVERAGE = {
  types: {
    eyebrow: 'Nine kinds of election',
    detail:
      'The same installation serves a department, a society, a faculty, a union, a council and a constitutional referendum at once. Nothing is configured per deployment.',
  },
  roles: {
    eyebrow: 'Five roles',
    detail:
      'Who may do what is decided by the server on every request, not by hiding buttons. An officer who runs the poll cannot certify the result they ran.',
  },
  visibility: {
    eyebrow: 'Four result rules',
    detail:
      'Which totals a voter is allowed to see is a property of the election. An archived election can have a complete tally and still show a voter nothing at all.',
  },
  ballots: {
    eyebrow: 'One, two or three selections',
    detail:
      'A single-transfer ballot, a three-seat executive ballot, and everything between, each with the one-vote rule enforced against the server rather than the form.',
  },
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
 * Scroll progress through the lifecycle section, as a state index.
 *
 * The section is tall and its content is sticky, so the amount scrolled past is
 * a direct measure of how far through the election the reader is. That number is
 * the state index — which is the whole reason this section exists. Nothing here
 * animates for its own sake.
 *
 * Read on a rAF, coalesced to one measurement per frame, rather than on `scroll`:
 * a scroll listener fires faster than the compositor can paint and ends up doing
 * layout-thrash nobody asked for.
 *
 * Under reduced motion, and on any viewport too narrow to have the sticky rail,
 * this returns 0 and the section renders as an ordinary annotated list.
 */
function useLifecycleProgress<T extends HTMLElement>(enabled: boolean) {
  const ref = useRef<T>(null)
  const [step, setStep] = useState(0)

  useEffect(() => {
    if (!enabled) {
      setStep(0)
      return
    }
    let frame = 0

    const measure = () => {
      frame = 0
      const el = ref.current
      if (!el) return
      // How far the reader has travelled through the pinned section, 0 to 1.
      const travel = el.offsetHeight - window.innerHeight
      if (travel <= 0) return
      const passed = -el.getBoundingClientRect().top
      const progress = Math.min(1, Math.max(0, passed / travel))
      // Rounded to the nearest state, so each one holds for the stretch of scroll
      // that is roughly its own rather than sliding continuously past.
      const next = Math.round(progress * (SPINE.length - 1))
      setStep((current) => (current === next ? current : next))
    }

    const onScroll = () => {
      if (frame) return
      frame = requestAnimationFrame(measure)
    }

    measure()
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll)
    return () => {
      if (frame) cancelAnimationFrame(frame)
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
    }
  }, [enabled])

  return { ref, step }
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

/* ========================================
   The page
   ======================================== */

export function Landing() {
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null)
  useReveal()
  useRegisterDrift()

  // The same call the front door makes, for the same reason: these figures have
  // to be the workspace's real contents. Failing to reach the server is not an
  // error state here — it just means section five says it has nothing to report.
  useEffect(() => {
    let live = true
    void fetchState()
      .then((state) => { if (live) setBootstrap(state) })
      .catch(() => { if (live) setBootstrap(null) })
    return () => { live = false }
  }, [])

  /*
   * The rail is pinned only where pinning makes sense, and "makes sense" is set by
   * the diagram rather than by the device.
   *
   * Below 1180px the horizontal rail cannot hold six nodes and their action labels
   * without the labels colliding — at 1024 the columns come out at 157px and "CLOSE
   * VOTING" runs through "CERTIFY" — so the stylesheet turns the rail into a
   * vertical list there. Pinning must switch off at exactly the same width, or the
   * page either pins a vertical list inside a 340vh section or scrubs a rail that
   * is not on screen.
   *
   * The height half of the query is the other way round: a short window cannot give
   * a sticky block room, so the section is a list there too.
   *
   * These two numbers have to match the media query in `landing.css`. That is the
   * one thing in this page stated in two places, and it is worth saying so in both.
   */
  const [pinned, setPinned] = useState(false)
  useEffect(() => {
    const query = window.matchMedia('(min-width: 1180px) and (min-height: 620px)')
    const apply = () => setPinned(query.matches)
    apply()
    query.addEventListener('change', apply)
    return () => query.removeEventListener('change', apply)
  }, [])

  const scrubbed = pinned && !window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const { ref: lifeRef, step } = useLifecycleProgress<HTMLElement>(scrubbed)

  const figures = useMemo(() => liveFigures(bootstrap), [bootstrap])

  const go = (hash: string) => { window.location.hash = hash }

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

      <header className="land-bar">
        <button type="button" className="brand" onClick={() => window.scrollTo({ top: 0 })} aria-label="Ballot, back to the top">
          <span className="brand-name">Ballot<span className="brand-dot">.</span></span>
        </button>
        <nav className="land-bar-nav" aria-label="Sections">
          <a href="#land-life">Lifecycle</a>
          <a href="#land-coverage">Coverage</a>
          <a href="#land-docs">Documents</a>
          <button type="button" className="btn-outline" onClick={() => go('#/enter')}>
            Sign in
            <Icon name="arrow-right" />
          </button>
        </nav>
      </header>

      <main id="land-body">
        {/* ---- 1. The cold open -------------------------------------------
            A title card, not a sales panel: the photograph owns the frame, the
            type sits in the lower third where a title card sits, and the only
            motion is the light building. It plays once, on load, over about two
            and a half seconds — long enough to feel like a frame being
            developed rather than a component being mounted. */}
        <section className="land-open">
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
            <div className="land-open-rake" />
          </div>
          <div className="land-open-scrim" aria-hidden="true" />

          <div className="land-open-body">
            <h1 className="land-claim">
              <span className="land-claim-line land-open-item" data-open="1">{OPEN.claim[0]}</span>
              {/*
                No `land-open-item` on the accent. It arrives by being written on
                rather than by rising, and the shared arrival rule was silently
                winning on source order — the accent did a plain fade-up for as long
                as that class was on it. It is excluded in the stylesheet too, so
                the two cannot disagree again.
              */}
              <span className="land-claim-line land-claim-accent" data-open="2">{OPEN.claim[1]}</span>
            </h1>
            <p className="land-open-lede land-open-item" data-open="3">{OPEN.lede}</p>
            <div className="land-open-actions land-open-item" data-open="4">
              <button type="button" className="btn-primary btn-lg" onClick={() => go('#/enter')}>
                Enter the workspace
                <Icon name="arrow-right" />
              </button>
              <button type="button" className="btn-outline btn-lg" onClick={() => go('#/vote')}>
                <Icon name="vote" />
                Cast a ballot
              </button>
            </div>
          </div>

          <div className="land-cue" aria-hidden="true">
            <span className="land-cue-label">Scroll</span>
            <span className="land-cue-rail"><span className="land-cue-travel" /></span>
          </div>
        </section>

        {/* ---- 2. Secrecy --------------------------------------------------
            The widest measure on the page and the largest type after the opening,
            because this is the claim the product actually rests on. The artifact
            sits beside it rather than under it: the claim on the left, the two
            records it is kept on the right, so the argument and its mechanism are
            read together rather than in sequence. */}
        <section className="land-band land-secrecy" aria-labelledby="land-secrecy-h">
          <div className="land-wrap land-split">
            <div className="land-split-text">
              <span className="eyebrow eyebrow-blue land-reveal" data-reveal>{SECRECY.eyebrow}</span>
              <h2 className="land-headline land-reveal" id="land-secrecy-h" data-reveal>
                {SECRECY.headline}
              </h2>
              <p className="land-detail land-reveal" data-reveal>{SECRECY.detail}</p>
            </div>

            <div className="land-records land-reveal" data-reveal>
              <div className="land-record">
                <span className="eyebrow">{SECRECY.receipt.eyebrow}</span>
                <code className="land-record-value">{SECRECY.receipt.code}</code>
                <p className="land-record-caption">{SECRECY.receipt.caption}</p>
              </div>

              <div className="land-record-rule" aria-hidden="true" />

              <div className="land-record">
                <span className="eyebrow">{SECRECY.stored.eyebrow}</span>
                <code className="land-record-value land-record-digest">{SECRECY.stored.digest}</code>
                <p className="land-record-caption">{SECRECY.stored.caption}</p>
              </div>
            </div>
          </div>
        </section>

        {/* ---- 3. The lifecycle ---------------------------------------------
            Pinned and scrubbed on a wide viewport, a plain annotated list
            anywhere else. The diagram is the point: six states that only move
            forward, and the branch off `open` that a row of status pills would
            hide. */}
        <section
          className={scrubbed ? 'land-band land-life land-life-pinned' : 'land-band land-life'}
          id="land-life"
          ref={lifeRef}
          aria-labelledby="land-life-h"
        >
          <div className="land-wrap land-life-sticky">
            <div className="land-life-head">
              <span className="eyebrow eyebrow-blue land-reveal" data-reveal>The lifecycle</span>
              <h2 className="land-headline land-headline-sm land-reveal" id="land-life-h" data-reveal>
                Seven states, and the poll can go back.
              </h2>
              <p className="land-detail land-detail-sm land-reveal" data-reveal>
                Six states only move forward. One does not: a poll can be paused and resumed and
                arrive exactly where it started. Certification is not optional on the way to the
                archive — a finished poll cannot be filed away uncertified.
              </p>
            </div>

            {/*
              The rail is one list, because it is one graph: six stops on the
              spine and a seventh hanging off the third. The description of the
              current state lives outside the list, in the readout below, so the
              rail itself stays a single short row — putting it inside a stop made
              the whole rail as tall as the tallest description and pushed the
              branch a long way below the spine it branches from.
            */}
            <ul className="land-rail">
              {SPINE.map((status, i) => {
                const reached = i <= step
                const current = i === step
                // The edge belongs to the state it leaves, not the one it arrives
                // at, so it is drawn to the right of this stop. Indexing by i-1
                // put every connector half a cell out of place.
                const edge = SPINE_EDGES[i]
                const state = (
                  <span
                    className={
                      current ? 'land-node land-node-current'
                        : reached ? 'land-node land-node-on'
                          : 'land-node'
                    }
                  >
                    <span className="land-node-dot" aria-hidden="true" />
                    <span className="land-node-label">{STATUS_LABELS[status]}</span>
                  </span>
                )
                return (
                  <li className="land-rail-stop" key={status}>
                    {state}
                    {/* Unpinned only. With no scrub to drive a single readout,
                        every state has to carry its own description, or the
                        section loses the half of the argument that says what
                        each state actually means. */}
                    <p className="land-rail-detail land-rail-detail-static">
                      {STATUS_DESCRIPTIONS[status]}
                    </p>
                    {edge && (
                      <span
                        className={reached ? 'land-rail-edge land-rail-edge-on' : 'land-rail-edge'}
                        aria-hidden="true"
                      >
                        <span className="land-rail-action">{reached ? edge.action : ''}</span>
                      </span>
                    )}
                  </li>
                )
              })}

              {/* The branch. Placed on row 2 of column 3 — under `open`, which is
                  where it hangs from. */}
              <li className="land-rail-branch">
                <span className="land-rail-stem" aria-hidden="true" />
                <span className="land-node land-node-branch">
                  <span className="land-node-dot" aria-hidden="true" />
                  <span className="land-node-label">{STATUS_LABELS[BRANCH]}</span>
                </span>
                <span className="land-rail-branch-action">Pause · Resume</span>
                {/* Always in the DOM, not only when pinned: with the scrub off this
                    is the only place a reader sees what a pause actually is, so
                    dropping it would quietly lose half the argument. */}
                <p className="land-rail-detail land-rail-branch-detail">
                  {STATUS_DESCRIPTIONS[BRANCH]}
                </p>
              </li>
            </ul>

            {/*
              The readout: what the current state means, and where in the graph
              the reader has got to. Not a live region — a scroll-driven value
              announced on every state change would talk over a screen-reader
              user who is simply scrolling, and the six state names are already
              in the list above for anyone reading it linearly.
            */}
            <div className="land-rail-readout">
              <span className="land-rail-count" aria-hidden="true">
                {String(step + 1).padStart(2, '0')}<span className="land-rail-of"> / {SPINE.length}</span>
              </span>
              <p className="land-rail-detail" key={SPINE[step]}>
                {STATUS_DESCRIPTIONS[SPINE[step]]}
              </p>
            </div>
          </div>
        </section>

        {/* ---- 4. Coverage --------------------------------------------------
            The densest section on the page, and deliberately the quietest: four
            small-type columns, no images, no cards. It is the part of the
            argument that is a list, so it is set as a list. */}
        <section className="land-band land-coverage" id="land-coverage" aria-labelledby="land-coverage-h">
          <div className="land-wrap">
            <h2 className="land-headline land-headline-sm land-reveal" id="land-coverage-h" data-reveal>
              One installation. Every kind of vote.
            </h2>

            <div className="land-coverage-grid">
              <div className="land-coverage-cell land-reveal" data-reveal>
                <span className="eyebrow eyebrow-blue">{COVERAGE.types.eyebrow}</span>
                <p className="land-detail land-detail-sm">{COVERAGE.types.detail}</p>
                <ul className="land-tags">
                  {ELECTION_TYPES.map((type) => (
                    <li key={type}>{ELECTION_TYPE_LABELS[type]}</li>
                  ))}
                </ul>
              </div>

              <div className="land-coverage-cell land-reveal" data-reveal>
                <span className="eyebrow eyebrow-blue">{COVERAGE.visibility.eyebrow}</span>
                <p className="land-detail land-detail-sm">{COVERAGE.visibility.detail}</p>
                <ul className="land-tags">
                  {RESULTS_VISIBILITIES.map((rule) => (
                    <li key={rule}>{VISIBILITY_LABELS[rule]}</li>
                  ))}
                </ul>
              </div>

              <div className="land-coverage-cell land-reveal" data-reveal>
                <span className="eyebrow eyebrow-blue">{COVERAGE.ballots.eyebrow}</span>
                <p className="land-detail land-detail-sm">{COVERAGE.ballots.detail}</p>
                <ul className="land-tags">
                  <li>NOTA offered or withheld</li>
                  <li>Abstain counted separately</li>
                  <li>Ballot order randomised</li>
                  <li>One-time codes required</li>
                </ul>
              </div>
            </div>

            {/*
              The roles, in their own band rather than as a fourth column.
              Five role descriptions stacked in one column of a four-column grid
              made that column twice the height of the other three and left the
              section bottom-heavy and lopsided. Across the full measure they are
              five short entries on one line of rule, which is what they are: a
              permission model, read across rather than down.
            */}
            <div className="land-roles-band land-reveal" data-reveal>
              <div className="land-roles-band-head">
                <span className="eyebrow eyebrow-blue">{COVERAGE.roles.eyebrow}</span>
                <p className="land-detail land-detail-sm">{COVERAGE.roles.detail}</p>
              </div>
              <ul className="land-roles">
                {ADMIN_ROLES.map((role) => (
                  <li key={role}>
                    <span className="land-role-name">{ROLE_LABELS[role]}</span>
                    <span className="land-role-detail">{ROLE_DESCRIPTIONS[role]}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        {/* ---- 5. This workspace ---------------------------------------------
            Real figures, from the elections the server returned. The whole
            section is conditional on there being something to report: an
            election platform's landing page inventing adoption numbers is the
            fastest way to lose an audience that has spent its life watching
            people invent them. */}
        <section className="land-band land-figures" aria-labelledby="land-figures-h">
          <div className="land-wrap">
            <div className="land-figures-head">
              <span className="eyebrow eyebrow-blue land-reveal" data-reveal>This workspace</span>
              <h2 className="land-headline land-headline-sm land-reveal" id="land-figures-h" data-reveal>
                What is on this server right now.
              </h2>
              <p className="land-detail land-detail-sm land-reveal" data-reveal>
                Read from the election database behind this page — not an example, not a
                screenshot. It updates with the workspace.
              </p>
            </div>

            {figures ? (
              <dl className="land-figure-row land-reveal" data-reveal>
                {figures.map((figure) => (
                  <div className="land-figure" key={figure.label}>
                    <dt className="land-figure-label">{figure.label}</dt>
                    <dd className="land-figure-value">{figure.value}</dd>
                    <dd className="land-figure-note">{figure.note}</dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p className="land-figures-empty land-reveal" data-reveal>
                Nothing to report — the workspace is empty, or this server could not be reached.
                Start one and the figures appear here.
              </p>
            )}
          </div>
        </section>

        {/* ---- 6. The two doors ---------------------------------------------
            Back where the page started, at the bottom, which is where a reader
            who has just been convinced actually wants to be. The same two
            destinations, the same order, and the same one-click behaviour as the
            front door: the operator is more likely to be the one who arrived. */}
        <section className="land-band land-close">
          <div className="land-wrap">
            <h2 className="land-headline land-headline-sm land-reveal" data-reveal>
              Two ways in.
            </h2>

            <nav className="land-doors land-reveal" data-reveal aria-label="Choose where to go next">
              <button type="button" className="entry-way land-door" onClick={() => go('#/enter')}>
                <span className="entry-way-text">
                  <span className="entry-way-label">Continue to the admin console</span>
                  <span className="entry-way-detail">Sign in with your administrator credentials.</span>
                </span>
                <span className="entry-way-arrow" aria-hidden="true"><Icon name="arrow-right" /></span>
              </button>
              <button type="button" className="entry-way land-door" onClick={() => go('#/vote')}>
                <span className="entry-way-text">
                  <span className="entry-way-label">Continue to the voter portal</span>
                  <span className="entry-way-detail">Cast your ballot. No account and no password needed.</span>
                </span>
                <span className="entry-way-arrow" aria-hidden="true"><Icon name="arrow-right" /></span>
              </button>
            </nav>

            {/* The three documents, on the landing page rather than buried in a
                footer nobody reaches. For a product that argues its claims are
                checkable, they belong where the argument is made. */}
            <div className="land-close-foot land-reveal" data-reveal>
              <p className="land-close-sub">Ballot secrecy is structural, not a promise.</p>
              <nav className="land-close-docs" id="land-docs" aria-label="Legal and policy">
                <a href="#/legal">Legal notices</a>
                <a href="#/terms">Terms</a>
                <a href="#/privacy">Privacy</a>
              </nav>
            </div>
          </div>
        </section>
      </main>
    </div>
  )
}

/* ========================================
   The real figures
   ======================================== */

type Figure = { label: string; value: string; note?: string }

/**
 * Section five's numbers, counted from the elections the server returned.
 *
 * Turnout is computed from `participant_count` and never from `ballot_count`.
 * Those are kept apart in the domain model for exactly this reason: the number
 * of ballots is not the number of people who voted when a ballot carries several
 * selections, so deriving a headcount from the table that holds what people chose
 * is how a turnout figure quietly starts implying something about individual
 * choices. This is the same rule the console follows, for the same reason, and it
 * is worth the reader knowing that this page got it right.
 */
function liveFigures(bootstrap: Bootstrap | null): Figure[] | null {
  const elections = bootstrap?.elections ?? []
  if (elections.length === 0) return null

  let ballots = 0
  let eligible = 0
  let participants = 0
  const states = new Set<ElectionStatus>()

  for (const election of elections) {
    ballots += election.ballot_count
    eligible += election.eligible_count
    participants += election.participant_count
    states.add(election.effective_status)
  }

  const turnout = eligible > 0 ? Math.round((participants / eligible) * 100) : 0
  const labels = ELECTION_STATUSES.filter((status) => states.has(status))

  return [
    { label: 'Elections', value: String(elections.length), note: 'on this server at once' },
    { label: 'Ballots cast', value: String(ballots), note: 'anonymous, receipted' },
    { label: 'On the rolls', value: String(eligible), note: 'across every roll' },
    { label: 'Turnout', value: `${turnout}%`, note: 'of those eligible' },
    {
      label: 'States in use',
      value: `${labels.length} of 7`,
      note: labels.map((s) => STATUS_LABELS[s].toLowerCase()).join(', '),
    },
  ]
}