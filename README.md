# Ballot

A local election platform. Administrators create and run elections; voters authenticate and vote through a portal. One installation serves any number of concurrent elections — university, club, department, or a plain referendum. Nothing about a specific contest is hardcoded.

It runs entirely on your machine. There is no external service, no mail or SMS gateway, and no data leaves the host.

## Requirements

- Node.js 22.12 or newer
- npm

## Setup

```bash
npm ci
npm run dev
```

Open `http://127.0.0.1:8443`.

On first run the app creates `data/database.sqlite`, applies the schema, and seeds three demo elections. The first visit to `#/admin` asks you to create the administrator account that will own the server.

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Development server, with verification codes shown on screen |
| `npm run dev:secure` | Development server, with code disclosure off |
| `npm run start` | Serve the production build locally |
| `npm run build` | Create a production build |
| `npm test` | Run the tests |
| `npm run typecheck` | Run TypeScript checks |
| `npm run verify` | Typecheck, test and build |

There is no separate backend. Vite middleware serves the API and persists to SQLite via `sql.js`, in development and in preview alike.

## Interfaces

`#/` is the voter portal. `#/admin` is the administration console — a separate surface with its own navigation and session.

### Voter flow

1. Pick an election. Each card shows its type, live status and schedule in the election's own timezone.
2. Enter the identifier issued for that election.
3. Enter the one-time code sent to your contacts on file, when the election requires one.
4. Review and submit. You get a receipt code, shown once, which is the only way back to your ballot.

The portal always states whether voting has not opened, is open, is paused, or has closed, with a countdown to the next change. Countdowns use an offset derived from the server, so a wrong local clock still shows the truth.

### Administrative workflow

1. **Create** the election: title, type, timezone, schedule, opening rules.
2. **Configure** voting rules and eligibility requirements.
3. **Add** candidates or options, with position and status.
4. **Build** the voter roll, individually or by CSV import.
5. **Review** the ballot preview and clear any blockers.
6. **Publish**, then **open** voting when the schedule permits.
7. **Pause** or **resume** as needed. Pausing is the controlled window for candidate status changes.
8. **Close**, **certify**, **archive**.

Before voting opens you have full control of the schedule, rules, eligibility, candidates and roll. Once it opens the ballot is **frozen** — options cannot be added, removed or reordered, because that would change what voters have already seen. Pausing still allows candidate status changes (withdraw, disqualify, reinstate).

Elections move through one lifecycle, enforced by a single state machine in `src/lib/lifecycle.ts` that both the server and the console read:

```text
draft → scheduled → open ⇄ paused → closed → certified → archived
```

`closed` is final: a poll cannot be reopened and cannot skip certification.

## Ballot secrecy

The schema is arranged so no query can ever answer "who voted for what" — not one that a permission check blocks, but one the columns cannot express.

- `participation` knows **that** someone voted, and when. It holds no selections.
- `ballots` knows **what** was chosen. It holds no voter column and no participation reference.

The two share exactly one column, `election_id`, which is a partition key — joining on it produces a cross product, not a correspondence. One vote per voter is enforced by `UNIQUE (election_id, voter_record_id)` on `participation`, and turnout is counted from `participation`, never from `ballots`.

Each ballot stores an HMAC integrity digest keyed by a secret held outside the database, so a voter can check their receipt and be told whether the stored ballot still matches — tamper evidence without attribution.

Two honest limits: a single-voter election cannot be private by counting alone, and a secret ballot cannot be changed (replacing one would require the link this design removes).

## Authentication

**Voters** prove themselves with a one-time code the server generates, stores only as a salted HMAC, and discards. Codes are single-use, expire on a timer, and wrong guesses are bounded and counted with a lockout. `voter.begin` answers identically whether or not the identifier is on the roll.

**Administrators** sign in with a password (scrypt, per-account salt, constant-time compare, lockout on repeated failure) and optionally TOTP with single-use recovery codes. Closing a poll, certifying, restoring a backup or resetting the platform additionally requires a fresh password, a second factor, or a second administrator's approval.

Every session is an opaque token in an `HttpOnly`, `SameSite=Strict` cookie, stored on disk only as a SHA-256, and never returned in a response body.

### Roles

Defined in `src/lib/rbac.ts`, enforced server-side for every command from a closed table.

| Role | Can do |
| --- | --- |
| **Super Admin** | Everything, including accounts, backups, security settings and platform reset |
| **Election Administrator** | Creates and configures elections, runs the lifecycle through to certification |
| **Election Officer** | Day-to-day operation of an existing election. Cannot certify or administer accounts |
| **Auditor** | Read-only: results, audit trail, security events |
| **Read-Only Observer** | Election status and published results only |

## API

Four endpoints, all loopback-only and same-origin checked.

| Endpoint | Purpose |
| --- | --- |
| `GET /__api/state` | Bootstrap: server time, election summaries, current admin session |
| `GET /__api/session` | Current admin session and the second-factor requirement |
| `POST /__api/auth` | Sign-in, first-run bootstrap, second factor, step-up, password change |
| `POST /__api/command` | Everything else, through the authorisation table |

Both endpoints that mutate take `{ action, payload }`. `action` is the same string the audit trail records, so any log line traces back to a request and vice versa. Errors return a stable `code` alongside the message.

No endpoint reads or writes the database file. The data directory is not served — any path beginning `/data` returns 404.

## Data handling

The database is written atomically (write to a temp file, fsync, rename) through a single serialised queue, so a crash cannot leave it partial. Times are stored as ISO-8601 UTC alongside the election's IANA timezone, so every voter sees the same absolute moment and DST is handled by `Intl`.

`data/` holds the database, backups and the integrity key. It is ignored by Git, because it contains personal data.

## Project layout

```text
src/
├── lib/        shared: types, rbac, lifecycle, time, validation, totp, api client, seed
├── server/     http, db, authorise, commands, auth, otp, ballots, audit, backup
├── admin/      administration console
├── voter/      voter portal
└── ui/         shared components
vite.config.ts  Vite plus the election API
```

## Demo data

Three elections in three different states, all synthetic (`@example.com`, placeholder numbers).

| Election | State | Identifiers |
| --- | --- | --- |
| `UNI-2026-REPRESENTATIVE` — Faculty of Engineering representative | Open now, live results | `STU-2026-0001` … `STU-2026-0008` |
| `CLUB-2026-CHAIR` — Chess Society secretary | Scheduled, opens in two days | `CHB-014`, `CHB-027`, `CHB-031`, `CHB-044` |
| `DEPT-2026-REPRESENTATIVE` — Civil Engineering representative | Draft, not published | `CE-2026-01` … `CE-2026-03` |

`STU-2026-0009` is marked ineligible, to demonstrate eligibility enforcement.

## Verification codes in development

There is no SMS or mail gateway, so a code has nowhere to go and the voter flow could not be completed. `npm run dev` therefore sets `ELECTION_DEMO_OTP=1` and displays each code on the verification form.

This is opt-in, never inferred, off under `dev:secure` and `start`, printed as a warning at startup, and reported as degraded in system health. An unknown identifier still gets a code that will not work, so it does not become a way to discover who is on the roll.

**Never enable this where real voters are involved.**

## Security notes

This is a local, single-operator research and demonstration project, and it is explicit about its limits:

- The API is reachable only from the loopback interface. Exposing it requires real authentication, TLS and a network-reachable database, none of which are in scope.
- Authorisation is enforced server-side from a closed table. The console hides what an account cannot do, but nothing depends on it having done so.
- The voter roll is a separate permission-gated read, never part of a public response, and redacted field by field so a new column cannot leak by default.
- No command can return a ballot selection for a named voter, at any privilege. The schema has no column that could carry the link, and a test scans every command's response type to confirm none can name both a voter and a choice.
- Every value arriving over HTTP is validated before it reaches the database, and all queries bind parameters.
- Sessions, voting credentials, receipts and backup archives store digests only, so a copy of the database cannot be replayed as a set of live credentials.
- Lifecycle transitions, configuration edits, candidate and roll changes and vote casting are all recorded in `audit_events`. **Denials are recorded the same way successes are.**

## License

MIT — see [LICENSE](LICENSE).