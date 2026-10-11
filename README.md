# Ballot

Ballot is a local election app for universities, clubs, departments, and other groups. It lets organizers set up elections, manage voters, and track results, while voters can verify their identity and cast their votes. Voter identities are stored separately from ballots.

## What it does

- Create elections, set schedules, and configure voting rules.
- Manage voter lists and ballot options.
- Verify voters and let them preview and cast their ballots.
- Track turnout, review results, certify outcomes, and view election history.

## Run locally

You'll need Node.js 22.12 or later and npm.

1. Install the dependencies:

   ```bash
   npm ci
   ```

2. Start Ballot:

   ```bash
   npm run dev
   ```

3. Open [http://127.0.0.1:8443](http://127.0.0.1:8443).

On first start, Ballot creates a database in the `data/` folder and loads sample elections.

The development server displays voter verification codes so you can test the full voting process. This is intended for local testing with sample data, not real elections.

To run the app without displaying verification codes, use:

```bash
npm run dev:secure
```

## Admin console

Open [http://127.0.0.1:8443/#/admin](http://127.0.0.1:8443/#/admin) and sign in with the demo account:

- **Username:** `leo.marchetti`
- **Password:** `Ballot-Demo-2026`