/**
 * The selection: two doors and one statement of what this is.
 *
 * This is the whole of the front door at `#/enter` and `#/` in its first state.
 *
 * It used to have two callers: the front door, and the second screen of a landing
 * page that argued its way down to these same two choices over four screens of
 * thesis first. Two copies of a claim about the same two doors will drift, and they
 * were one component for that reason. The landing page is gone, so this is now the
 * front door and nothing else, and it has been renamed from `ChooseDoorway` —
 * "choose" described what a screen below a claim made you do; here it is simply the
 * door.
 *
 * It is still a component rather than inlined, because it is long enough to be worth
 * naming and because `AdminLogin` uses the same hero in its other two stages.
 */

import { Icon } from './Icon'
import { AuthFrame } from './Shell'

const YEAR = new Date().getFullYear()

export const DOOR_HERO = {
  /*
   * The eyebrow is about the product, not about signing in. It used to say
   * "Administrator access", which was wrong the moment this page became the way in
   * for a voter as well — the headline below is the product's argument and the two
   * destinations under it are its entry points.
   */
  eyebrow: 'Election workspace',
  headline: 'Run elections',
  accent: 'with confidence.',
  /*
   * The lede, in plain words and a little longer.
   *
   * It was "Secure operations for every election, with clear roles and an
   * audit-ready workspace", which was three adjectives doing the work of three
   * facts. "Secure operations" names nothing an operator could check. "Audit-ready
   * workspace" is the noun phrase you write when you do not want to say what the
   * audit is. A voter or an officer reading it learns nothing about what will
   * happen to them.
   *
   * It says the three things that are actually true and checkable: the whole
   * election runs in one place, the roles decide who may do what, and the actions
   * get written down. "Five" is `ADMIN_ROLES.length` today; if a role is ever added,
   * this number is what has to change with it.
   */
  lede: 'Ballot runs the whole election from one machine. Five roles decide who may open the poll, certify the result or only read, and every administrative action is written down.',
  /*
   * The hero's old "Privacy-first by design" note said authentication is scoped to
   * this workspace. The statement on the photograph says the same thing in four
   * words, so carrying both was repetition rather than emphasis.
   */
  statement: 'No credentials leave this server.',
  /*
   * The line reversed out of the photograph, bottom-left.
   *
   * It was "Ballot administrator access · 2026 cycle", which named the surface
   * twice — once here and once in the wordmark above — and then spent its second
   * line on the word "cycle". What is worth saying here is which product this is
   * and how old it is; the rest was the line talking about itself.
   */
  meta: `Ballot administrator ${YEAR}`,
}

/**
 * What the product is, in one paragraph.
 *
 * On the chooser, because a visitor who has just been offered two doors is deciding
 * whether to care about either, and the answer is the same either way. Every claim
 * here is one the server actually enforces; nothing on this page is a promise the
 * product does not keep.
 */
const ABOUT = {
  eyebrow: 'About Ballot',
  headline: 'A ballot is never stored against the person who cast it.',
  detail:
    'The roll, the one-time codes and the audit trail live on this machine and nowhere else. What a voter takes away is a receipt — the only record that a ballot was cast, and one that can be checked later without revealing the choice.',
}

/**
 * The two ways in.
 *
 * Order is deliberate: an operator arriving at a bare host is looking for the
 * console, and a voter is looking for their ballot. Both are one click, so the order
 * only has to be the more likely intent first.
 *
 * Each description is one line by design. They used to run to two, which made the
 * doors twice as tall as they needed to be and read as paragraphs rather than as
 * captions under a title. Trimming them lost nothing: the second factor is announced
 * on the form itself, live, once the server says the account has one — which is more
 * use than a line promising it in advance.
 */
export const DESTINATIONS: {
  id: 'admin' | 'vote'
  label: string
  detail: string
}[] = [
  {
    id: 'admin',
    label: 'Continue to the admin console',
    detail: 'Sign in with your administrator credentials.',
  },
  {
    id: 'vote',
    label: 'Continue to the voter portal',
    detail: 'Cast your ballot. No account and no password needed.',
  },
]

export function Doorway({ onAdmin }: { onAdmin: () => void }) {
  return (
    <AuthFrame statement={DOOR_HERO.statement} meta={DOOR_HERO.meta}>
      <DoorHero />

      <div className="auth-frame-work">
        <nav className="entry-ways" aria-label="Choose where to go next">
          {DESTINATIONS.map((destination) => (
            <button
              key={destination.id}
              type="button"
              className="entry-way"
              onClick={() => {
                if (destination.id === 'admin') {
                  onAdmin()
                  return
                }
                window.location.hash = '#/vote'
              }}
            >
              <span className="entry-way-text">
                <span className="entry-way-label">{destination.label}</span>
                <span className="entry-way-detail">{destination.detail}</span>
              </span>
              <span className="entry-way-arrow" aria-hidden="true">
                <Icon name="arrow-right" />
              </span>
            </button>
          ))}
        </nav>

        {/*
          What the product is, below the two doors. It earns its place by being the
          same answer whichever door someone is about to walk through, and by being
          the one thing a first-time visitor cannot get from either.
        */}
        <div className="entry-about">
          <span className="eyebrow">{ABOUT.eyebrow}</span>
          <p className="entry-about-headline">{ABOUT.headline}</p>
          <p className="entry-about-detail">{ABOUT.detail}</p>
        </div>
      </div>
    </AuthFrame>
  )
}

/**
 * The hero, above the doors.
 *
 * Short on purpose: an eyebrow, the headline in two lines, one sentence of lede, and
 * an accent rule that closes the block. The promise that used to sit here as a
 * fourth block now runs under the photograph, where there is room for it and it does
 * not compete with the work.
 */
export function DoorHero() {
  return (
    <div className="auth-hero">
      <span className="eyebrow eyebrow-blue">{DOOR_HERO.eyebrow}</span>
      <h1>
        {DOOR_HERO.headline}
        <span className="accent">{DOOR_HERO.accent}</span>
      </h1>
      <p className="auth-hero-lede">{DOOR_HERO.lede}</p>
      <div className="auth-hero-rule" />
    </div>
  )
}