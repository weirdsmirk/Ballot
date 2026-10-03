/**
 * The three documents the footer links to.
 *
 * They exist because the product makes specific, checkable claims — the ballot is
 * not stored against the voter, the roll never leaves the machine, one vote per
 * eligible voter is enforced on the server — and a claim that is never written
 * down is indistinguishable from marketing. Each page below describes what the
 * software actually does in this repository. Where a limit exists, it says so.
 *
 * They are deliberately specific and short. A policy nobody reads protects
 * nobody, and this product has nothing to hide behind vagueness about: the
 * database is one SQLite file in `data/`, and a reader can open it.
 */

import { SiteBar, SiteFoot, BackLink } from './Shell'

export type LegalPageId = 'legal' | 'terms' | 'privacy'

type Block =
  | { kind: 'p'; text: string }
  | { kind: 'h2'; text: string }
  | { kind: 'ul'; items: string[] }

/** A single document. `title` is the heading; the `<title>` is left to the shell. */
const PAGES: Record<LegalPageId, { title: string; standfirst: string; blocks: Block[] }> = {
  legal: {
    title: 'Legal notices',
    standfirst:
      'What this software is, what it is not, and the one thing you should check before trusting it with a real election.',
    blocks: [
      {
        kind: 'h2',
        text: 'What this is',
      },
      {
        kind: 'p',
        text: 'Ballot is a self-hosted election application for clubs, faculties, departments, student unions and local referendums. It runs on a machine you control, keeps everything in a single SQLite database beside the application, and sends nothing about your election to anyone.',
      },
      {
        kind: 'h2',
        text: 'No warranty',
      },
      {
        kind: 'p',
        text: 'This software is provided as-is, without warranty of any kind, express or implied. Nobody involved in writing it accepts liability for the outcome of an election run on it, for the loss of any record, or for any claim made by a candidate.',
      },
      {
        kind: 'h2',
        text: 'Your statutory duties are yours',
      },
      {
        kind: 'p',
        text: 'If your election is governed by a constitution, a statute or a returning officer, this software does not discharge any of those obligations. Eligibility rules, notice periods, quorum, dispute procedures and the certification of a result all remain the responsibility of whoever is legally required to perform them. Run the demonstration workspace as a rehearsal, not as evidence.',
      },
      {
        kind: 'h2',
        text: 'What this is not',
      },
      {
        kind: 'ul',
        items: [
          'Not a cryptographic guarantee of anonymity. It removes the link between a ballot and a voter by construction — there is no column joining them — but it cannot stop a determined observer watching the room.',
          'Not a replacement for a verified, secret ballot when one is required by law.',
          'Not audited to any formal standard, and it makes no claim to be.',
        ],
      },
      {
        kind: 'h2',
        text: 'Licence',
      },
      {
        kind: 'p',
        text: 'Distributed under the MIT licence. The full text is in the LICENSE file at the root of the repository.',
      },
    ],
  },

  terms: {
    title: 'Terms of use',
    standfirst:
      'Rules for running an election on this software, and for using it as a voter. Both are short because both are enforced by the server.',
    blocks: [
      {
        kind: 'h2',
        text: 'For administrators',
      },
      {
        kind: 'ul',
        items: [
          'You are responsible for the integrity of the machine it runs on. Anyone with filesystem access to the data directory can read the voter roll and edit the database; anyone who can reach the server over the network can attempt to sign in.',
          'Do not expose this to the public internet without putting it behind a reverse proxy with TLS and access control. It binds to 127.0.0.1 by default for that reason.',
          'Account creation, role changes and password resets are yours to perform and yours to audit. The software records them; it cannot prevent an administrator from misusing them.',
          'Grant the narrowest role that lets someone do their job. The request cannot raise its own privilege, but whoever issues the account sets what that account can do.',
          'Back up before you need one, not after. The built-in archive is verifiable; test restoring from it as part of your rehearsal.',
        ],
      },
      {
        kind: 'h2',
        text: 'For voters',
      },
      {
        kind: 'ul',
        items: [
          'One vote per eligible voter is enforced by the server, not by this page. It is a database constraint, so two simultaneous requests cannot both succeed — the loser is told they have already voted.',
          'Keep your receipt. It is the only record that your ballot was cast, and it can be checked later without revealing what you chose.',
          'This build has no SMS or mail gateway, so a voter who cannot be reached at the contact on the roll cannot be reached at all. Nobody can recover those contacts for you, and that is deliberate.',
        ],
      },
      {
        kind: 'h2',
        text: 'Acceptable use',
      },
      {
        kind: 'p',
        text: 'Do not attempt to vote in an election you are not on the roll for, do not attempt to vote twice, and do not attempt to read, alter or delete anyone else\'s ballot or receipt. A failed verification is written to the security log with the time, the identifier claimed and the real reason — the person is told only that it did not succeed, because telling them which part was wrong would confirm whether an identifier is on the roll.',
      },
    ],
  },

  privacy: {
    title: 'Privacy',
    standfirst:
      'What is stored, where it is stored, and what is never collected. Everything below is verifiable by opening the database file.',
    blocks: [
      {
        kind: 'h2',
        text: 'What leaves this machine',
      },
      {
        kind: 'p',
        text: 'No election data, no credential, no identifier and no keystroke leaves the machine this runs on. The browser talks to one origin — the election server — and the Content-Security-Policy forbids it connecting anywhere else. There is no telemetry, no analytics, no error reporting and no account.',
      },
      {
        kind: 'p',
        text: 'One exception, stated plainly because a notice that hides it is worthless: the typefaces are fetched from Google Fonts when the page loads, which tells Google your IP address and that you are loading this page. It carries nothing about the election — the request is made before you arrive at a form, and it contains no voter data. If that trade is not acceptable for your election, delete the font import at the top of the stylesheet; the type falls back to a serif already on the machine and nothing else changes.',
      },
      {
        kind: 'h2',
        text: 'What is stored',
      },
      {
        kind: 'ul',
        items: [
          'The voter roll for each election: the identifier issued to each person, and the contact used to deliver one-time codes.',
          'Ballots and receipts: the selections cast, and a receipt digest per ballot.',
          'Administrator accounts, role grants, password hashes and second-factor secrets.',
          'An audit trail of administrative actions, and a security log of sign-in attempts.',
          'Signed archives of the database, with their hashes.',
        ],
      },
      {
        kind: 'h2',
        text: 'What is not stored',
      },
      {
        kind: 'p',
        text: 'A ballot is not stored against the voter who cast it. The ballots table has no voter column and no credential column; a separate participation table records who has voted so that the one-vote rule can be enforced, and it holds no selections. There is no join available in the database that turns a ballot back into a person, which is why there is nothing to subpoena, request or leak.',
      },
      {
        kind: 'h2',
        text: 'Who can see what',
      },
      {
        kind: 'ul',
        items: [
          'A voter sees their own receipt and nothing about anyone else\'s ballot.',
          'An administrator can see turnout, the roll and every audit entry. No role can read individual selections against a voter, because no such record exists.',
          'Reading the personal data on the roll — the contact details one-time codes are delivered to — takes a separate permission from merely seeing the roll. A role without it gets every name with the contact withheld.',
        ],
      },
      {
        kind: 'h2',
        text: 'Retention',
      },
      {
        kind: 'p',
        text: 'Records are kept until you delete them. Ballot has no automatic expiry and no third party to send anything to, so the retention schedule is whatever your own policy says it is — set one, and delete the database when an election is past its appeal window.',
      },
    ],
  },
}

export function isLegalPage(hash: string): LegalPageId | null {
  const route = hash.replace('#/', '')
  if (route.startsWith('legal')) return 'legal'
  if (route.startsWith('terms')) return 'terms'
  if (route.startsWith('privacy')) return 'privacy'
  return null
}

/**
 * One document, rendered in the ordinary page frame.
 *
 * The header and footer are shared rather than bespoke: a policy page that looks
 * like a different product is a policy page nobody trusts.
 *
 * `backTo` and `backLabel` come from App, which remembers the surface the reader
 * was on when they opened this. Defaulting them to the front door would send a
 * voter who clicked through from an open election back to a sign-in form.
 */
export function LegalPage({
  id,
  backTo = '#/',
  backLabel = 'Back to the front door',
}: {
  id: LegalPageId
  backTo?: string
  backLabel?: string
}) {
  const page = PAGES[id]
  const other = (Object.keys(PAGES) as LegalPageId[]).filter((key) => key !== id)

  return (
    <div className="page-shell">
      <SiteBar
        meta={
          <span className="site-bar-meta">
            <BackLink to={backTo} label={backLabel} />
            <span className="site-bar-sep">·</span>
            {page.title}
          </span>
        }
      />

      <main className="legal-body">
        <div className="legal-inner">
          <div className="legal-prose">
            <p className="eyebrow">Ballot</p>
            <h1>{page.title}</h1>
            <p className="legal-standfirst">{page.standfirst}</p>

            {page.blocks.map((block, index) => {
              if (block.kind === 'h2') return <h2 key={index}>{block.text}</h2>
              if (block.kind === 'ul') {
                return (
                  <ul key={index}>
                    {block.items.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                )
              }
              return <p key={index}>{block.text}</p>
            })}

            <nav className="legal-switch" aria-label="Other documents">
              {other.map((key) => (
                <a key={key} href={`#/${key}`}>
                  {PAGES[key].title}
                </a>
              ))}
            </nav>
          </div>
        </div>
      </main>

      <SiteFoot sub="No credentials leave this server." />
    </div>
  )
}
