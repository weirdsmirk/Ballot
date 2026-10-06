# Working on Ballot

## Commit and push

**Commit after a verified change. Push only when explicitly asked to.**

Do not push as a matter of course, not at the end of a task, and not because the
branch looks tidy. "Push", "push it", "send it" are the only things that authorise a
push. If a task ends without one of them, the work stays local and gets reported as
pushed: no.

Committing is a different thing and stays the default. A local commit is cheap to
undo, keeps the tree clean, and leaves the work reviewable with `git log`. So: edit,
verify, commit, report. Then wait.

Before every commit, `npm run verify` — typecheck, tests, build. Verify measures
the change rather than describing it; see below.

## The dev server

`npm run dev` on `http://127.0.0.1:8443`. OTP codes are shown on screen, so no mail
is needed. Admin demo: `gary.whitlock` / `Ballot-Demo-2026`, at `#/admin` → the first
`.entry-way` → `#admin-username` / `#admin-password`.

## Verifying

`npm run verify` is the gate. It is not a substitute for looking at the thing.

Layout and type bugs in this codebase have passed every automated check and been
obvious the moment the page was screenshotted. Two that shipped to a green build:

  · `max-width: 20ch` on a headline resolved against the *inherited* 14px body size,
    because `font-size` was declared on the child. A 20ch cap came out 129px wide on
    a 158px headline and wrapped it to four lines. Nothing in the stylesheet shows
    this — `ch` is an ordinary unit.

  · A `:not()` exclusion lost a specificity fight to a same-specificity rule on
    source order, leaving three animations running for readers who had asked for
    reduced motion. Invisible except by counting `document.getAnimations()`.

So: measure the rendered box against what the copy needs, screenshot the result, and
count the animations under `prefers-reduced-motion`. Do not trust a comment, a
computed `font-family`, or a passing test as evidence that something renders the way
it reads.

`document.fonts` does not enumerate cross-origin `@import` faces, so it cannot
confirm a webfont loaded. Measure instead — render a probe string in the named face
and in a fallback and compare widths. Equal widths mean the fallback was reached.

## Routes

There are three surfaces and `#/` is the front door.

`#/` and `#/enter` both render the front door: the photograph, the two ways in, and
the administrator form swapping into the same screen rather than navigating away.
`#/vote` is the voter portal, `#/admin` the console, and anything unrecognised falls
back to the front door.

There is no landing page. There was one — a long scrolling argument about why the
product could be trusted — and it was deleted along with `src/landing/`. Do not add
one back without being asked.

The front door does not move. Every animation in the product is switched off under
`prefers-reduced-motion` by one block at the foot of `index.css`, and
`src/motion.test.ts` fails if any rule in that file declares an animation without
being named in it.

## Data

Figures come from the live election database via `fetchState()`. Nothing on the
landing page is invented. Turnout is `participant_count`, never `ballot_count`.