# Ballot

A local election platform for university, club, department and referendum votes.
Create and schedule elections, build the voter roll, run the poll, certify the
result. One installation serves any number of elections at once.

React + TypeScript on Vite, with SQLite via `sql.js`. The API is a Vite plugin,
so there's no separate backend to run. Data stays on your machine.

## Requirements

Node.js 22.12 or newer, and npm.

## Setup

```bash
npm ci
npm run dev
```

Open [http://127.0.0.1:8443](http://127.0.0.1:8443). On first run it creates
`data/database.sqlite`, applies the schema, and writes a full demonstration
workspace into it — nine elections covering every lifecycle state, election type,
results-visibility rule and ballot shape the product supports, with 307 voters,
166 cast ballots, a populated audit trail, a security log, archives and a
two-person approval waiting to be decided.

You do not have to create anything to use it. See
[The demonstration workspace](#the-demonstration-workspace) for what is in there
and [Administrator accounts](#administrator-accounts) for how to sign in.

There's no mail or SMS gateway, so a voter has nowhere to receive a code. `npm
run dev` therefore shows each one-time code on the verification form. Never run
it that way where real voters are involved — use `npm run dev:secure`, which
keeps disclosure off.

## Run

```bash
npm run dev            # voter codes shown on screen
npm run dev:secure     # voter codes never revealed
```

## Production

```bash
npm run build
npm start
```

It serves on `127.0.0.1` only. Putting it beyond localhost needs real
authentication, TLS and a network-reachable database, none of which are in
scope here.

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Start the dev server, with one-time codes shown on screen |
| `npm run dev:secure` | Start the dev server, with code disclosure off |
| `npm start` | Run the production server |
| `npm run build` | Build for production |
| `npm run demo:reset -- --force` | Delete the local database and archives so the demo workspace is rebuilt |
| `npm test` | Run the tests |
| `npm run typecheck` | Check types only |
| `npm run verify` | Typecheck, test, then build |

---

# The demonstration workspace

## Where it lives

Everything is in `data/`, which is gitignored and never committed:

| Path | What it is |
| --- | --- |
| `data/database.sqlite` | The whole workspace. One SQLite file. |
| `data/backups/*.sqlite` | Archive files behind the Backups screen. Real, restorable copies. |
| `data/ballot-integrity.key` | The key that makes ballot digests non-reversible. Kept across resets on purpose. |

The fixtures are two files:

- **`src/lib/seed.ts`** — the data. Pure, serialisable, no I/O. Safe to read and
  edit; it is the file to change if you want a different demo workspace.
- **`src/server/demoData.ts`** — the writing. Imports the real ballot, receipt and
  password writers, so every seeded record is produced by the same code path the
  running application uses.

The seed only runs when `elections` is empty, so it can never touch a workspace
that has history in it.

## Rebuilding it

Once you start clicking — opening a poll, certifying a result, restoring an
archive — there is no way back through the interface. Delete the database and the
next start rebuilds it:

```bash
npm run demo:reset -- --force
npm run dev
```

`--force` is required. Without it the script prints exactly what it would delete
and exits non-zero, so it cannot be triggered by a stray npm invocation. It keeps
`data/ballot-integrity.key`, so digests stay comparable across a rebuild.

Everything is generated from a fixed-seed generator, so two resets produce
identical data. A bug reported against "the demo workspace" is reproducible.

## Signing in

### Administrator accounts

All seven accounts share one password: **`Ballot-Demo-2026`**

| Username | Role | Extra state | What it's for |
| --- | --- | --- | --- |
| `hana.wexford` | Super Admin | Second factor enabled | The full console: every section, every destructive action |
| `leo.marchetti` | Election Administrator | — | Creating and configuring elections, certifiable results |
| `iris.nakamura` | Election Officer | Active session | Runs a poll; **cannot** certify, so good for testing a refusal |
| `gary.whitlock` | Auditor | — | Read-only, but *can* see the security log and voter roll |
| `mira.chatterjee` | Read-Only Observer | — | The most restricted role: four sections and nothing else |
| `tomas.velasco` | Election Officer | **Locked out** | Makes the "1 account locked" counter and the unlock action live |
| `dana.kovacs` | Auditor | **Disabled** | Makes the enable/disable action live |

The password satisfies the platform's own password policy — which is exactly why
it must not be reused anywhere real.

### Signing in with a second factor

`hana.wexford` has a second factor, so sign-in is two steps: password, then code.
You do not need an authenticator app. Any **one** of these unused recovery codes
works as the code:

```
H4NA-7KQR    2XDM-9WTP    P8VF-3JHZ    R5TN-QB6Y
W9CK-4LSM    Z2GX-7VDN    T6JY-8RPF    M3QB-5XHT
```

Each is single-use. If you would rather use an authenticator, the seeded TOTP
secret is `JBSWY3DPEHPK3PXP`.

## What is in it

### Elections

Nine elections, one per election type, covering all seven lifecycle states, all
four results-visibility rules and ballots of one, two and three selections.

| Id | Title | Type | State | Results | Votes/voter | Options | Eligible | Ballots | Turnout |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `UNI-2026-REPRESENTATIVE` | Faculty of Engineering — Student Representative | University | **open** | live | 1 | 5 + NOTA | 45 | 31 | 69% |
| `ORG-2026-PRESIDENT` | Students' Union — Three Executive Seats | Organizational | **open** | live | 3 | 5 + NOTA | 23 | 11 | 52% |
| `REF-2026-CURFEW` | Referendum — Morning Class Start Times | Referendum | **paused** | after close | 1 | 2 + NOTA + Abstain | 34 | 22 | 65% |
| `PRIM-2026-DEAN` | Faculty Dean — Final Ballot | Primary | **closed** | after close | 1 | 4 + NOTA | 30 | 27 | 90% |
| `BUD-2026-BOARD` | Foundation Board of Trustees — 2026 Slate | Board | **certified** | after certify | 1 | 5 | 40 | 34 | 85% |
| `GEN-2025-BUDGET` | General Meeting — Constitutional Amendments | General | **archived** | never | 1 | 4 + NOTA | 44 | 41 | 93% |
| `CLUB-2026-CHAIR` | Chess Society — Secretary | Club | **scheduled** | after close | 1 | 3 + NOTA | 17 | 0 | — |
| `MUNI-2026-ALDERMAN` | Ward 1 (Riverside) — Councillor | Municipal | **scheduled** | never | 1 | 6 | 52 | 0 | — |
| `DEPT-2026-REPRESENTATIVE` | Civil Engineering — Department Representative | Department | **draft** | after close | 2 | 3 + Abstain | 14 | 0 | — |

Each one is deliberately the *interesting* case of its state:

- **`UNI-2026-REPRESENTATIVE`** is the main voter journey. Open, results live,
  randomised ballot order, one vote, NOTA offered, one-time codes required, 69%
  turnout so there is something to look at.
- **`ORG-2026-PRESIDENT`** is the three-seat ballot. The widest in the workspace,
  so the "3 of 3 selected" counter and the rule that a fourth choice drops the
  oldest both have something to do.
- **`REF-2026-CURFEW`** is the paused poll, and the only place where stored state
  and clock disagree on purpose — its window is still running but an officer
  paused it. That is why its status badge carries the small `auto` marker. It is
  also the only ballot offering **both** NOTA and Abstain, and its abstain count
  is high enough to appear second on the results screen.
- **`PRIM-2026-DEAN`** is closed and *not yet certified*. It is the one to use for
  the certify workflow, including the re-authentication it demands.
- **`BUD-2026-BOARD`** is certified: the result is the official record and cannot
  be changed. Its results are also hidden from voters until certification, so it
  exercises the "published once certified" rule.
- **`GEN-2025-BUDGET`** is archived, and its results are never published. It is
  the only election whose tallies exist, are fully populated, and are still
  withheld by rule — visible in the console to an authorised administrator and
  invisible to any voter, since archived elections are also hidden from the
  picker.
- **`DEPT-2026-REPRESENTATIVE`** is the draft. Unpublished, so invisible to
  voters, and the only two-of-two ballot with an Abstain option and no NOTA.

### Ballot options

40 options across the nine elections, in all four states:

- **37 approved** — appear on ballots and can receive votes.
- **1 draft** — `Sameer Kulkarni` on the faculty election. On the ballot but not
  approved, so voters never see it and it cannot receive a vote. Use it to test
  the Approve action.
- **1 withdrawn** — `Introduce a quorum of 70 per cent` on the referendum. It
  already holds votes, which were cast before the proposers withdrew it. The
  history is kept and the option stops counting.
- **1 disqualified** — `Make all teaching optional` on the referendum.
  Disqualified during the poll for an insufficient proposer mandate. A
  disqualified option cannot receive a vote at all.

### Voter rolls

307 people across nine rolls. Names are generated from real given and family
name pools so the rolls read as real registers rather than as `Voter 1`,
`Voter 2`. Each roll has its own identifier scheme.

- **239 eligible voters can verify by both** a phone code and an email code.
- **21 eligible voters have a phone but no email**, so verification issues one
  code instead of two. `STU-2026-0028` on the faculty election is one.
- **39 have an email but no phone**, so verification issues one email code.
- **8 voters are excluded** from their election, each with a stated reason —
  postgraduate enrolment, withdrawal before the roll closed, unconfirmed
  enrolment, a conduct review, and so on. Excluded voters see an explicit
  refusal rather than a code they cannot use. One of the eight
  (`STU-2026-0005`) is also the only person on any roll with no phone and no
  email at all, so the *no contact* channel state is present even though that
  voter cannot be reached.

### Cast ballots and results

166 ballots across five elections, each with a receipt. Ballots are **not**
seeded against voters: the ballots and the participation records are generated
from separate inputs by separate loops, so there is no correspondence anywhere in
the database between who voted and what they chose. See
[Ballot secrecy](#ballot-secrecy).

Tallies are contested rather than clean sweeps, so the leading-option highlight,
the runner-up bars and the NOTA and Abstain rows all appear. Turnout ranges from
52% to 93%.

Every seeded ballot has a real keyed integrity digest, and all 166 verify against
the ballot's own contents. Every ballot has a receipt code of the form
`XXXX-XXXX-XXXX-XXXX-XXXX`, stored only as a digest.

### Audit trail

22 events spanning about a day, across every actor type and every outcome — so
the Outcome filter has all three values: 18 succeeded, 3 denied and 1 failed.

- **Administrators** across five roles, including one that changed a setting it
  had no permission to change.
- **The system**, opening and closing polls on schedule.
- **Voters**, casting ballots.
- **Success, denied and failed** — two denials and one failure are seeded on
  purpose, including an officer who tried to certify a result and a locked-out
  officer who tried to edit a frozen roll.

### Security log

19 events at all four severities, covering sign-in failures, a locked account, a
replayed revoked session token, an expired ballot credential, a spent one-time
code presented twice, a recovery code used, an account disabled, a cross-site
origin refused, rate limiting, a database restore and a platform reset.

Eleven are unacknowledged, so the **Acknowledge** button has real work to do.
Acknowledged rows show who acknowledged them and when; the events themselves are
never deleted.

### Sessions

Four seeded administrator sessions, so the Sessions tab is not empty:

- One **active** session for `iris.nakamura`.
- Three **revoked**, each with its own reason: `signed out` (twice) and
  `superseded by a new verification`.

No live session tokens are seeded. Every token digest is random and unknown to
anyone, so none of these rows can be turned into a working sign-in — they exist to
show the tab's states. Expired sessions are deliberately absent: the server purges
them on the next sign-in, so they would not survive long enough to be seen.

### Approvals

Three two-person requests, so the Approvals tab has a queue and a history:

| Request | Permission | Raised by | State |
| --- | --- | --- | --- |
| Reopen the dean ballot | `election.reopen` | `leo.marchetti` | **pending** |
| Restore from the nightly archive | `backup.restore` | `hana.wexford` | approved by `leo.marchetti` |
| Reset the platform | `system.reset` | `iris.nakamura` | rejected by `hana.wexford` |

The pending one is the live test: sign in as `hana.wexford` and approve it from
Security → Approvals. Self-approval is refused, which is why it has to be a
different person.

### Archives

Six archive records, each with a real file behind it in `data/backups/`:

| Label | Kind | Taken |
| --- | --- | --- |
| `nightly-automatic` | Scheduled | 3 hours ago |
| `before-council-vote` | Manual | 14 hours ago |
| `before-roll-import` | Manual | 26 hours ago |
| `pre-restore-snapshot` | Before a restore | ~3 hours ago |
| `nightly-automatic-2` | Scheduled | 27 hours ago |
| `start-of-term` | Manual | 8 days ago |

The files are genuine exports with correct SHA-256 checksums, so **Restore** is a
real workflow here rather than a button that always fails. The newest archive is
deliberately older than 24 hours, so the "your backups are stale" warning and the
Overview attention item are both populated.

### Platform settings

Written as a configured platform rather than an untouched default:

| Setting | Value | Why |
| --- | --- | --- |
| Archives kept | 14 | Above the default of 10, so pruning is visible |
| Idle session timeout | 720 min | Shows a configured value in the session countdown |
| Max sign-in attempts | 6 | Differs from the default of 5 |
| Voting credential lifetime | 1200 s | Long enough to read a long ballot |

Two settings are deliberately left at their safe defaults:

- **`requireMfa` is off.** Only one of the seven demo accounts has a second
  factor. Turning the requirement on would lock the other six out of the console
  and make the demo unusable.
- **`Reveal voter codes` is off.** Disclosure comes from the `ELECTION_DEMO_OTP`
  environment variable instead, so `npm run dev:secure` cannot be defeated by
  demo data.

## Test identities

Identifiers to type on the **Identify** step. Pick one that has *not* voted, or
you will land on the "You have already voted" card instead of a ballot.

| Election | Not yet voted | Notes |
| --- | --- | --- |
| `UNI-2026-REPRESENTATIVE` | `STU-2026-0007`, `STU-2026-0010`, `STU-2026-0011` | Single vote, NOTA offered |
| `UNI-2026-REPRESENTATIVE` | `STU-2026-0028` | Phone only — one code instead of two |
| `UNI-2026-REPRESENTATIVE` | `STU-2026-0001`, `STU-2026-0003` | **Have** voted — shows the already-voted card |
| `UNI-2026-REPRESENTATIVE` | `STU-2026-0002`, `STU-2026-0005`, `STU-2026-0008` | Excluded — shows the eligibility refusal |
| `ORG-2026-PRESIDENT` | `STU-2027-0006`, `STU-2027-0007`, `STU-2027-0010` | Three selections |
| `CLUB-2026-CHAIR` | `CHB-001`, `CHB-003` | Scheduled — shows the "opens in" countdown |
| `DEPT-2026-REPRESENTATIVE` | `CE-2026-01`, `CE-2026-03` | Draft — shows the "not yet published" refusal |
| `REF-2026-CURFEW` | `STU-2026-R-006`, `STU-2026-R-007` | Paused — shows the paused refusal |
| `MUNI-2026-ALDERMAN` | `WARD1-0001`, `WARD1-0002` | Results are never published |

An identifier that is not on any roll, such as `NOPE-0001`, is answered with the
same wording whether or not it exists — the screen never reveals roll membership.

## What is deliberately not seeded

- **Voter one-time codes.** They are generated per attempt and expire. Under
  `npm run dev` they appear on the verification form instead.
- **Voter challenges, sessions and credentials.** Nothing live, so no fixture can
  be used to skip verification.
- **Usable session tokens.** Covered above.
- **A one-person election.** The honest limits screen says a one-voter election
  is not private; the schema makes it so.

---

# The three surfaces

The server hosts three surfaces, and the root is the front door to all of them.

| Route | Surface |
|---|---|
| `#/` | The front door: the photograph, the argument, and the two ways in |
| `#/vote` | The voter portal |
| `#/admin` | The administration console |

The front door exists because the two destinations need different opening moves.
A voter needs an identifier and two codes; an operator needs a password and
possibly a second factor. Putting the sign-in form first would mean every voter
passes a password prompt to reach a ballot.

Every unauthenticated route shows the chooser first, `#/admin` included: the hero,
the two ways in, and a short paragraph on what the product is. Choosing **the
admin console** swaps the sign-in form into the right-hand half of the same page
rather than navigating, so the visitor can change their mind and go back. Choosing
**the voter portal** navigates, because the portal is a separate surface with its
own header and footer. Signing in hands over to `#/admin`.

The one case that skips the chooser is a server with no administrator accounts
yet: there is nothing to sign in to, so the bootstrap form is shown directly.

Anything that is neither `#/vote` nor `#/admin` resolves to the front door.

---

# Voter portal

The portal is at `#/vote`. It polls the server every 10 seconds and shows a
server-corrected clock, so a wrong local clock cannot make a closed poll look
open.

## The flow

Five stages, shown as a bar per stage with the label beneath. The bar is the
state: filled where the voter has been, flat where they have not.

`Choose → Identify → Code → Ballot → Receipt`

### Choose

The picker lists every election that is not archived, each with its type, status,
schedule and a live countdown to its next state change. Archived elections are
hidden. Clicking one starts the flow, unless the browser already holds a verified
session for that election — in which case the flow resumes at the ballot.

With no elections at all, the portal shows an empty state saying an administrator
needs to publish one first.

### Identify

The voter types the identifier for that election — labelled per election
("Student ID", "Membership ID", "Roll Number", "Elector ID", …). The
**Verify & continue** button is disabled while the election cannot accept votes,
and the reason is stated above it.

### Code

Where the election requires one-time codes, one field per required channel. The
wording is identical whatever happens, because the server does not say whether an
identifier is on the roll. Every wrong guess counts against the code, and the code
expires.

Under `npm run dev` the codes for this attempt are shown in an amber note on the
form. They are generated fresh each time.

### Ballot

Options with a radio control each; special options (NOTA, Abstain) are visually
distinct. Selecting more than the permitted number drops the **oldest** selection
rather than refusing the click. The submit button stays disabled until exactly the
required number is chosen, then a confirmation modal lists what will be submitted.

An image is shown for an option only if both the election and the option have one.

### Receipt

On submission: a check mark, the receipt code on a dashed amber card, a **Copy
code** button, and the integrity digest. The digest is shown shortened; the full
value is available through the API.

### Results

Polled every 10 seconds. Whether a tally is shown depends on the election's
visibility rule:

| Rule | Voters see the tally |
| --- | --- |
| `live` | Immediately, in every state |
| `after_close` | Once voting has closed |
| `after_certify` | Once the result has been certified |
| `never` | Never — the page says results are not published |

When a tally is withheld, turnout and the ballot count are still shown. That is
deliberate: an aggregate cannot be inverted into an individual ballot.

## States you can reach in the demo

| To see | Do this |
| --- | --- |
| Ballot, empty | Sign in with a not-yet-voted identifier on an open election |
| "You have already voted" | Sign in with `STU-2026-0001` on the faculty election |
| "Voting has not opened yet" | Open `CLUB-2026-CHAIR` |
| "Not yet published" | Open `DEPT-2026-REPRESENTATIVE` |
| "Voting is paused" | Open `REF-2026-CURFEW` |
| "Not eligible" | Use `STU-2026-0002` on the faculty election |
| Results withheld | Open `MUNI-2026-ALDERMAN` (never published), or `CLUB-2026-CHAIR` (published after close) |
| Live tally | Open `UNI-2026-REPRESENTATIVE` results |
| Multi-select ballot | Open `ORG-2026-PRESIDENT` with `STU-2027-0006` |
| Credential expired | Leave a verified ballot open past the 1200-second credential lifetime, then submit |
| Server unavailable | Stop the server; the portal shows a retry card |

## Receipt verification

Receipts can be checked against a code. There is no screen for it — the command
exists and is reachable from the API:

```bash
curl -s http://127.0.0.1:8443/__api/command \
  -H 'content-type: application/json' \
  -d '{"action":"voter.receipt","payload":{"electionId":"ORG-2026-PRESIDENT","receipt":"A91B-33F4-9F9C-0907-7F"}}'
```

It answers that a ballot exists, when it was cast, how many options it selected,
and whether its integrity digest still matches its contents. It cannot say who
cast it or what they chose, and the same code in the wrong election is refused.

## Testing notes

- **The voter session is a cookie scoped to one election.** Once you have
  verified for an election, returning to it resumes the session and you land on
  the ballot — not on the identify form. Use **Finish and sign out** on the
  receipt screen, or test a different election, or open a private window.
- **Voting is genuinely one-per-voter.** Once `STU-2026-0007` votes, that
  identifier cannot vote again in that election. There are enough not-yet-voted
  identifiers on each roll to repeat the test.
- **Choosing among candidates is not restricted.** Use
  `STU-2026-0007`, `0010`, `0011` in turn to cast three separate ballots.

---

# Administration console

The console is at `#/admin`. It is a separate surface with its own navigation and
identity strip, and does not share the portal's header or footer.

It has no URL routing: the section is component state, so a reload returns to
Overview.

## Sections at a glance

| Section | Needs | Super Admin | Election Admin | Officer | Auditor | Observer |
| --- | --- | :-: | :-: | :-: | :-: | :-: |
| Overview | `dashboard.view` | ● | ● | ● | ● | ● |
| Elections | `election.view` | ● | ● | ● | ● | ● |
| Candidates | `candidate.view` | ● | ● | ● | ● | ● |
| Voters | `voter.view` | ● | ● | ● | ● | — |
| Results | `results.view` | ● | ● | ● | ● | ● |
| Audit log | `audit.read` | ● | ● | ● | ● | — |
| Security | `security.read` | ● | — | — | ● | — |
| Backups | `backup.view` | ● | ● | ● | ● | — |
| Destructive ops | `system.reset` | ● | — | — | — | — |
| Settings | `settings.view` | ● | ● | ● | ● | — |

Roles are an explicit matrix, not a hierarchy: no role gains a permission by
accident. The sidebar only shows sections the signed-in role holds, and the server
refuses independently of what the interface shows.

## Overview

Four figures — active elections, registered voters, average turnout, open alerts —
then one card per election, a stream of the six most recent audit entries, and up
to four **needs attention** items.

The attention list is derived, in priority order, from: unacknowledged critical
alerts, locked accounts, administrators without a second factor, stale or missing
backups, the first non-informational health issue, and pending approvals. The demo
populates the first four, so all four appear.

There is also a Security summary, a Backups summary with health issues, and an
Approvals card when anything is queued.

## Elections

Every election including archived, as cards with status, a three-figure tally
(turnout, votes cast, eligible), a turnout bar and a live countdown.

- **Filters**: free text over title, id and type; and a status dropdown. The count
  line reads "N of M shown".
- **Overflow menu** per card: every available lifecycle transition, then *Open
  workspace*. Each entry's tooltip states whether you will be asked for a password
  or for a second administrator's approval.
- **Create election** opens a modal with title, description, type, timezone,
  window and the initial rules and eligibility.
- **Manage** opens the workspace.

Transitions available in the demo:

| Election | Try |
| --- | --- |
| `DEPT-2026-REPRESENTATIVE` (draft) | **Publish** → becomes scheduled |
| `CLUB-2026-CHAIR` (scheduled) | **Open voting** — blocked until the window opens |
| `UNI-2026-REPRESENTATIVE` (open) | **Pause**, then **Resume**, then **Close** |
| `REF-2026-CURFEW` (paused) | **Resume**, then **Close** |
| `PRIM-2026-DEAN` (closed) | **Certify results** — asks for your password |
| `BUD-2026-BOARD` (certified) | **Archive** |
| `GEN-2025-BUDGET` (archived) | Nothing — terminal |

## Election workspace

Opening an election replaces the console shell with a focused view. The tabs are
**Overview**, **Rules & eligibility**, **Ballot options**, **Voter roll**,
**Ballot preview**, **Results**, **Audit trail**.

- **Overview** — a lifecycle card with the current state, the timing, every
  available transition, then turnout, votes cast, a turnout-over-time chart, and a
  readiness checklist for publishing.
- **Rules & eligibility** — votes per voter, NOTA and Abstain, ballot ordering,
  results visibility, image display, code requirements, identifier and group
  labels, and the eligibility note voters read. Changing rules asks for a password
  and is refused once voting has begun.
- **Ballot options** — the roster for this election: add, edit, reorder, change
  status, remove. Adding is refused once the ballot is frozen.
- **Voter roll** — search, filters, bulk eligibility changes, add one, import a
  pasted CSV.
- **Ballot preview** — renders the voter's own frame from the same payload the
  voter portal receives, so you can see the ballot as a voter will.
- **Results** — summary figures, a turnout meter and the full tally.
- **Audit trail** — this election's events with a connecting line.

## Candidates

One table across every election that has options. Search over name, party and
election; filter by candidate status and by election; sortable; 25 per page.

Row actions depend on the ballot: **Edit** and **Remove** while it is still
editable, **Move to draft** / **Approve** / **Withdraw** / **Disqualify`
otherwise, and **view only** if your role cannot manage options.

Approving `Sameer Kulkarni` on the faculty election makes a sixth option appear
on the voter ballot. Withdrawing or disqualifying asks for a reason, which is
written to the audit trail, and warns that a change after voting has begun affects
the recorded tally. Removing asks you to type `REMOVE`.

## Voters

The roll for one election at a time. Search, three filters (eligibility, whether
they have voted, which channels they can verify by), sorting, 25 per page, and
checkbox selection for bulk actions.

Columns: identifier (labelled per election), name, group, contact, which channels
they can verify by, eligibility, and whether they have voted.

- **Withheld** appears in the name and contact columns when your role lacks
  `voter.view_pii` — sign in as `gary.whitlock` or `mira.chatterjee` to see it.
- **Can verify by** renders *phone + email*, *phone only*, *email only* or
  *no contact*. All four occur in the demo.
- Selecting rows reveals a bulk bar: mark eligible, mark ineligible, remove.
- **Add voter** and **Bulk import** are unavailable once the roll is frozen, and
  the card says so.
- **Bulk import** takes pasted CSV, header `voter_id, full_name, phone, email,
  external_ref`, up to 500 rows, and reports *every* problem line rather than
  stopping at the first.

Participation is shown as "Voted / Not yet". What was chosen is not retrievable by
identity, and the screen says so.

## Results

Every election except drafts and archived ones, with summary figures and a turnout
meter. **Show tally / Hide tally** per card; the leading option is highlighted.

Results taken from a running poll are labelled provisional. Certification happens
in the workspace, not here. Elections whose visibility rule withholds results show
the turnout but not the tally.

## Audit log

Server-paged at 50 rows, with search (debounced) and filters for outcome,
election, actor type and action. The action list comes from the server, so it
reflects what has actually happened.

Columns: when (UTC), who, action (with the raw command beside it), detail,
election, outcome, request id, source address.

**Denied and failed attempts are first-class rows.** The demo seeds two denials and
a failure so the Outcome filter has all three values. Column sorting is inert on
this table — it is server-paged.

## Security

Four tabs, loaded the first time each is opened.

**Security events** — when, severity, event, detail, acknowledged. Filter by
severity, acknowledged state and kind; searchable. With `security.manage` you can
**Acknowledge**, which records that a human saw it. The event is never deleted.
Twelve seeded events are unacknowledged.

**Sessions** — every session, with started, last seen, second factor, source and
state. Tokens are never sent to the browser, so revocation is offered per account
rather than per session: **Revoke all** signs that person out everywhere and takes
effect immediately. Revoked rows show the reason.

**Approvals** — the two-person queue. Each request names the operation, who asked,
why, and when it expires. You cannot approve your own request; the one you raised
says so instead of offering buttons. Approving unlocks the operation for the
requester — it does not perform it, and both names are recorded.

**Administrators** — every account with its role, second factor, last sign-in and
state. As Super Admin you can change a role, disable or enable an account, and
unlock a locked one; each is a two-person request. Your own account is marked and
not editable, and the last Super Admin's role is locked.

Use `tomas.velasco` to test **Unlock** and `dana.kovacs` to test **Enable**.

## Backups

Four figures — newest archive and its age, archives held, total size, and how many
ballots the newest contains. The demo's newest archive is over 24 hours old, so
the staleness warning shows.

**Create backup now** takes an archive with a label and a note. Creating one
prunes older archives beyond the retention setting.

The table lists each archive with its file, kind, size, contents, author and note;
searchable and filterable by kind.

**Restore** is the most dangerous operation in the product. It asks you to type
the archive's id, lists exactly what would be lost, takes an automatic snapshot of
the current database first, verifies the archive's checksum, and requires a second
administrator's approval. The demo's archives are real, so this works.

## Settings

Nine cards. Read-only unless you are a Super Admin, in which case every control
enables and **Save changes** appears.

1. **Your account** — enrol or remove a second factor (removal needs your password
   *and* a current code), and change your password.
2. **Voter verification codes** — code length, lifetime, wrong guesses, lockout,
   resend cooldown.
3. **Access control** — whether administrators may create accounts, idle timeout,
   max sign-in attempts, lockout duration.
4. **Second factor policy** — require a second factor for everyone.
5. **Rate limiting** — request budget and window.
6. **Results and voter experience** — default results visibility, maintenance mode.
7. **Backups** — how many archives to keep.
8. **Demonstration mode** — reveal voter codes on screen, with the warning.
9. **System** — read-only: status, uptime, database size, schema version, runtime,
   and any health issues.

## Destructive ops

Platform reset, behind a two-person approval and a typed confirmation. It takes a
snapshot first and can keep administrator accounts.

## Elevation: passwords and two-person control

Some actions are guarded. The pattern is the same everywhere: the action is
attempted optimistically, and only if the server demands elevation does a dialog
appear, then the action is retried unchanged.

**Re-authentication** asks for your password and lasts five minutes. It guards:
closing voting, certifying results, deleting an election, changing voting rules,
acknowledging a security event, and managing security settings.

**Two-person control** requires a *different* administrator to approve. It guards:
reopening an election, restoring a backup, resetting the platform, and any change
to an administrator account. You raise a request with a justification, and the
other person decides it in Security → Approvals.

The demo has one such request pending so you can complete the loop.

---

# Ballot secrecy

Ballots are stored with no link to the voter. `participation` records that someone
voted and when; `ballots` records what was chosen. They share one column,
`election_id`, and joining on that gives a cross product rather than a
correspondence. One vote per voter is a unique constraint in the database, and
turnout is counted from `participation`, never from `ballots`.

The separation is structural, not a query filter:

```
roll_voters         who somebody is            identity
eligibility         whether they may vote      eligibility
voter_sessions      that they proved it        authentication
voting_credentials  a single-use right to vote  credential
participation       that they have voted       participation
ballots             what was chosen             ballot
receipts            proof a ballot was counted receipt
```

`ballots` holds no voter column and no credential column, and none may be added.
Its primary key is a random value rather than a sequence on purpose: with an
autoincrement on both that table and `participation`, the first ballot and the
first participation row would both get id 1 and joining the two would pair every
voter with a ballot without any column ever being joined.

Each ballot carries an HMAC-SHA256 digest keyed with `ballot-integrity.key` over
its own contents. Keyed rather than plain, because a selection is a small integer
from a known set and an unkeyed digest could be brute-forced by anyone holding the
database. The digest answers "has this ballot been altered since it was written" —
a much weaker question than "whose ballot is it", and one answerable with no link
to a voter existing.

Every administrative action is recorded in the audit trail, including the ones
that were refused.

## Data

Everything lives in `data/`, which isn't committed. The database is the single
file `data/database.sqlite`; backups go in `data/backups/`.

The ballot integrity key is `ballot-integrity.key` beside it, unless you set
`BALLOT_INTEGRITY_KEY`. Back that up somewhere the database isn't — losing it
only means old digests can't be re-verified, but leaking it would let anyone
holding the database read a digest back into the option that was chosen.

## Layout

- `src/lib/` — shared types, roles, lifecycle, validation, TOTP, demo fixtures
- `src/server/` — HTTP, database, authorisation, voting, audit, backups, demo writer
- `src/admin/` — administration console
- `src/voter/` — voter portal
- `src/ui/` — shared components and the design system
- `src/index.css` — the design system: tokens, type scale, components
- `data/` — local data, not committed

## Troubleshooting the demo

| Symptom | Cause |
| --- | --- |
| Every election is gone | The database was reset. `npm run dev` rebuilds it. |
| "No elections are available" | Nothing is published. Open `UNI-2026-REPRESENTATIVE` in the console. |
| A code does not appear | You are on `npm run dev:secure`. Codes are only revealed by `npm run dev`. |
| "You have already voted" for an identifier you expected to work | That voter is among the seeded participants. Pick another from the table above. |
| The identify form is skipped on an election | The browser holds a verified session cookie for it. Sign out, or use another election. |
| The Backups table is empty | The archive files were removed from `data/backups/`. Rows are pruned when their file is gone. |
| Sign-in says the account is locked | `tomas.velasco` is seeded locked. Unlock them in Security → Administrators. |
| Sign-in demands a second factor | That is `hana.wexford`. Use one of the recovery codes above. |