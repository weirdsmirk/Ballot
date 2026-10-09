# Ballot

Ballot is a local election app for universities, clubs, departments, and other
groups. Organizers set up elections and manage voter rolls. Voters verify their
identity, preview the ballot, and vote. Ballots are stored separately from voter
identities.

## What it does

- Create and schedule elections, and set voting rules.
- Manage voter rolls and ballot options.
- Let voters verify, preview a ballot, and cast a vote.
- Review turnout and results, certify outcomes, and view an audit history.

## Run locally

You need Node.js 22.12 or newer and npm.

```bash
npm ci
npm run dev
```

Open [http://127.0.0.1:8443](http://127.0.0.1:8443). On first start, Ballot
creates a local database in `data/` and loads sample elections.

The development server displays voter verification codes in the app so you can
try the full voting flow. Use sample data for local testing; don't use this mode
with real voters. To run locally without displaying codes, use:

```bash
npm run dev:secure
```

To open the admin console, go to
[http://127.0.0.1:8443/#/admin](http://127.0.0.1:8443/#/admin) and sign in with
the demo account `leo.marchetti` and password `Ballot-Demo-2026`.
