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
```

On first run it creates `data/database.sqlite`, applies the schema, and seeds
three demo elections in three different states: open, scheduled and draft. The
first visit to `#/admin` asks you to create the administrator account that owns
the server.

To try the voter flow, open the university election and sign in as
`STU-2026-0001`.

## Run

```bash
npm run dev
```

Open [http://127.0.0.1:8443](http://127.0.0.1:8443).

There's no mail or SMS gateway, so a voter has nowhere to receive a code. `npm
run dev` therefore shows each one-time code on the verification form. Never run
it that way where real voters are involved — use `npm run dev:secure`, which
keeps disclosure off.

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
| `npm test` | Run the tests |
| `npm run typecheck` | Check types only |
| `npm run verify` | Typecheck, test, then build |

## Ballot secrecy

Ballots are stored with no link to the voter. `participation` records that
someone voted and when; `ballots` records what was chosen. They share one
column, `election_id`, and joining on that gives a cross product rather than a
correspondence. One vote per voter is a unique constraint, and turnout is
counted from `participation`, never from `ballots`.

Every administrative action is recorded in an audit trail, including the ones
that were refused.

## Data

Everything lives in `data/`, which isn't committed. The database is the single
file `data/database.sqlite`; backups go in `data/backups/`.

The ballot integrity key is `ballot-integrity.key` beside it, unless you set
`BALLOT_INTEGRITY_KEY`. Back that up somewhere the database isn't — losing it
only means old digests can't be re-verified, but leaking it would let anyone
holding the database read a digest back into the option that was chosen.

## Layout

- `src/lib/` — shared types, roles, lifecycle, validation, TOTP
- `src/server/` — HTTP, database, authorisation, voting, audit, backups
- `src/admin/` — administration console
- `src/voter/` — voter portal
- `src/ui/` — shared components
- `data/` — local data, not committed