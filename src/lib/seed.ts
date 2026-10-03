/**
 * The demonstration dataset.
 *
 * Everything in this module is a *fixture*: plain, serialisable data describing
 * a workspace that has been running for a term. Nothing here writes to the
 * database and nothing here is read at runtime by the application — the writer
 * lives in `src/server/demoData.ts`, which imports the real server helpers so
 * that seeded records are produced by exactly the same code paths the app uses.
 *
 * ## Why a dataset and not three fixtures
 *
 * The original seed created three elections so a fresh install had something to
 * look at. That is enough to prove the app renders and not enough to *use* it:
 * almost every screen in this product is a view over history — tallies, turnout
 * curves, audit trails, security logs, approval queues — and a workspace with no
 * history shows only the empty state of each one.
 *
 * So the dataset below is built around coverage rather than volume. It is
 * organised so that between them the elections exercise:
 *
 *   · every one of the seven lifecycle states, including the two that are hard
 *     to reach by hand (a *paused* poll, and a *certified* one with a signature);
 *   · every one of the nine election types;
 *   · every results-visibility rule, so the "not published yet" and "never
 *     published" screens both have something to say;
 *   · ballots of one, two and three selections, so the multi-select ballot, the
 *     "oldest selection is dropped" rule and the abstain option are all live;
 *   · all four candidate states, including a withdrawn option that already holds
 *     votes and a disqualified one that cannot receive any;
 *   · voters who are excluded, voters with no phone, voters with no email, and
 *     voters with neither, so every "can verify by" combination renders.
 *
 * ## Ballot secrecy is not simulated, it is structural
 *
 * The seeded ballots and the seeded participation rows are generated
 * *independently* of one another, exactly as they are in production: the ballot
 * generator is never given the voter list and the participation generator is
 * never given the selections. That is not decoration. If the seed paired them,
 * the demo database would contain a table joining a person to a choice, and the
 * one property this product exists to provide would be false in the very file
 * used to demonstrate it. See `src/server/demoData.ts` for the write order that
 * preserves this.
 *
 * ## Determinism
 *
 * All variation is generated from a fixed-seed LCG rather than `Math.random`, so
 * two people who run `npm run demo:reset` get byte-identical data and a bug
 * reported against "the demo workspace" is reproducible.
 */

import {
  type CandidateStatus,
  type ElectionStatus,
  type ElectionType,
  type EligibilityRules,
  type ElectionRules,
} from './types'
import { defaultEligibility, defaultRules } from './validate'
import { DEFAULT_SETTINGS, type PlatformSettings } from './adminTypes'
import type { AdminRole } from './rbac'

/* ------------------------------------------------------------------ types --- */

/** A ballot option as it appears on a ballot. */
export type DemoOption = {
  /** Stable handle used by the ballot plan to name a selection. Never stored. */
  ref: string
  name: string
  organization: string
  abbreviation: string
  description: string
  image_url: string
  symbol: string
  position: number
  status: CandidateStatus
  /** Present only on withdrawn/disqualified options, which the UI asks for. */
  statusReason?: string
}

/** One person on one election's roll. */
export type DemoVoter = {
  voter_id: string
  full_name: string
  phone: string
  email: string
  external_ref: string
  is_eligible: 0 | 1
  /** Why not, when `is_eligible` is 0. Shown on the Voters screen. */
  eligibility_reason?: string
}

/**
 * One cast ballot, expressed in option `ref`s rather than database ids.
 *
 * The writer resolves refs to ids after the options are inserted, because the ids
 * are assigned by SQLite and are not known while this file is being evaluated.
 * `-1`/`-2` are not used here; the special options are named `'NOTA'`/`'ABSTAIN'`
 * so that a typo cannot silently become a valid candidate id.
 */
export type DemoBallot = {
  /** Which eligible roll members are recorded as having voted. Length may differ. */
  ref: string
  offsets: number[]
}

/** How many ballots to cast, and with what shape of spread. */
export type DemoBallotPlan = {
  /** Ballots to generate for this election. */
  count: number
  /**
   * Weighted preference per option ref. Higher weight wins more often. The
   * generator normalises them, so absolute values do not matter — only order and
   * rough magnitude. Omitting a ref gives it zero.
   */
  weights: Record<string, number>
  /**
   * When true the winning option sometimes appears second, and NOTA/abstain draw
   * a realistic share of the vote, so the results screen is not a clean sweep.
   */
  noisy?: boolean
}

export type DemoElection = {
  id: string
  title: string
  description: string
  election_type: ElectionType
  timezone: string
  /** Offsets in milliseconds from "now" at seed time. */
  startsInMs: number
  endsInMs: number
  status: ElectionStatus
  rules: ElectionRules
  eligibility: EligibilityRules
  ever_opened: 0 | 1
  /** `null` leaves `published_at` empty, which is what a draft should look like. */
  publishedInMs: number | null
  certifiedInMs?: number | null
  archivedInMs?: number | null
  options: DemoOption[]
  voters: DemoVoter[]
  ballots: DemoBallotPlan | null
}

/* ----------------------------------------------------------------- timing --- */

const MINUTE = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000

/**
 * Offsets from seed time, expressed so a reader can check them against a clock.
 *
 * A stored status and the schedule are kept in agreement on purpose: an election
 * whose stored state disagrees with its window is displayed with an "auto" chip,
 * which is a real state worth having in the demo, but it is confusing if it is the
 * *default*. `REF-2026-CURFEW` is the one deliberate exception.
 */
const T = {
  /** Voting started two hours ago, closes in three days. */
  openStart: -2 * HOUR,
  openEnd: 3 * DAY,
  /** Opens in two days, closes in four. */
  futureStart: 2 * DAY,
  futureEnd: 4 * DAY,
  /** Ran for five days and was closed by an administrator two days ago. */
  pastStart: -5 * DAY,
  pastEnd: -2 * DAY,
  /** Certified a week ago, well clear of its window. */
  certifiedStart: -12 * DAY,
  certifiedEnd: -9 * DAY,
  /** Archived a month ago. */
  archivedStart: -44 * DAY,
  archivedEnd: -42 * DAY,
  /** Never opened; scheduled for next week. */
  draftStart: 7 * DAY,
  draftEnd: 8 * DAY,
} as const

const ZONE = 'Asia/Kolkata'

/* ------------------------------------------------------------------- rules --- */

function rules(overrides: Partial<ElectionRules>): ElectionRules {
  return { ...defaultRules(), ...overrides }
}

function eligibility(overrides: Partial<EligibilityRules>): EligibilityRules {
  return { ...defaultEligibility(), ...overrides }
}

/* ------------------------------------------------------------ name pools --- */

/**
 * Name pools for generated roll members.
 *
 * A demo roll needs to be big enough to make turnout and pagination meaningful —
 * a handful of names cannot show a 62% turnout or a second page of results — and
 * hand-writing three hundred people would be noise pretending to be data. Real
 * given names and family names combined read as a real roll; a roll is exactly
 * this, unremarkable, and long.
 */
const GIVEN = [
  'Aarav', 'Isha', 'Rohan', 'Meera', 'Vikram', 'Ananya', 'Kabir', 'Priya', 'Fatima', 'Devika',
  'Arjun', 'Sara', 'Marcus', 'Zoya', 'Harpreet', 'Anil', 'Sneha', 'Ravi', 'Nikhil', 'Tara',
  'Yusuf', 'Leah', 'Aditya', 'Kavya', 'Rohan', 'Nisha', 'Sameer', 'Divya', 'Karthik', 'Ishita',
  'Farhan', 'Neha', 'Aditi', 'Varun', 'Shruti', 'Imran', 'Pooja', 'Gaurav', 'Ritika', 'Siddharth',
  'Ananya', 'Tanvi', 'Abhishek', 'Kiran', 'Lakshmi', 'Manav', 'Rekha', 'Suresh', 'Bhavna', 'Omkar',
] as const

const FAMILY = [
  'Sharma', 'Patel', 'Gupta', 'Nair', 'Singh', 'Das', 'Rao', 'Iyer', 'Bose', 'Qureshi',
  'Fernandes', 'Ali', 'Kapoor', 'Joshi', 'Pillai', 'Verma', 'Menon', 'Khan', 'Reddy', 'Chatterjee',
  'Banerjee', 'Mukherjee', 'Deshpande', 'Kulkarni', 'Shetty', 'Rathore', 'Saxena', 'Bhatt', 'Trivedi', 'Chauhan',
  'Rastogi', 'Sethi', 'Agarwal', 'Malhotra', 'Bhardwaj', 'Chopra', 'Dubey', 'Gill', 'Kaur', 'Seth',
] as const

/**
 * A tiny deterministic generator.
 *
 * `Math.random` would make every reset produce a different workspace, which
 * makes a bug report impossible to reproduce and a screenshot impossible to
 * compare. Fixed seed, same data, every time.
 */
function lcg(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 4_294_967_296
  }
}

/** Pick from a pool. */
function pick<T>(random: () => number, pool: readonly T[]): T {
  return pool[Math.floor(random() * pool.length) % pool.length]
}

/**
 * A roll of `count` people whose names are unique within the election.
 *
 * Uniqueness is enforced by widening to a middle initial rather than by retrying,
 * so the generator cannot loop: with a fixed seed it terminates on every input.
 */
function roll(
  random: () => number,
  count: number,
  options: { prefix: string; width: number; groups: readonly string[] },
): DemoVoter[] {
  const seen = new Set<string>()
  const people: DemoVoter[] = []
  for (let index = 0; index < count; index += 1) {
    const given = pick(random, GIVEN)
    const family = pick(random, FAMILY)
    let fullName = `${given} ${family}`
    if (seen.has(fullName)) fullName = `${given} ${String.fromCharCode(65 + (index % 26))}. ${family}`
    // A duplicate that survived widening is given a numeral rather than looping.
    let suffix = 2
    while (seen.has(fullName)) fullName = `${given} ${family} ${suffix++}`
    seen.add(fullName)

    const serial = String(index + 1).padStart(options.width, '0')
    const group = pick(random, options.groups)
    // A tenth of the roll has no phone and a fifteenth has no email, so the
    // "can verify by" column renders all four combinations rather than one.
    const noPhone = random() < 0.1
    const noEmail = random() < 0.067
    people.push({
      voter_id: `${options.prefix}${serial}`,
      full_name: fullName,
      phone: noPhone ? '' : `9${String(Math.floor(random() * 1_000_000_000)).padStart(9, '0')}`,
      email: noEmail ? '' : `${given.toLowerCase()}.${family.toLowerCase()}${index + 1}@example.edu`,
      external_ref: group,
      is_eligible: 1,
    })
  }
  return people
}

/** Exclude some voters, with a reason that explains each exclusion. */
function exclude(voters: DemoVoter[], reasons: string[]): DemoVoter[] {
  const out = [...voters]
  for (let index = 0; index < reasons.length; index += 1) {
    const target = out[index * 3 + 1]
    if (!target) break
    target.is_eligible = 0
    target.eligibility_reason = reasons[index]
  }
  return out
}

function option(
  ref: string,
  name: string,
  organization: string,
  abbreviation: string,
  description: string,
  position: number,
  status: CandidateStatus = 'approved',
  statusReason?: string,
): DemoOption {
  return {
    ref,
    name,
    organization,
    abbreviation,
    description,
    image_url: '',
    symbol: abbreviation,
    position,
    status,
    ...(statusReason ? { statusReason } : {}),
  }
}

/* --------------------------------------------------------------- elections --- */

function universityElection(): DemoElection {
  const random = lcg(0x5eed_1001)
  const options = [
    option('SUF', 'Ananya Deshmukh', 'Student Unity Front', 'SUF',
      'Third-year engineering student. Platform: a published attendance policy, a 24-hour library extension, and a budget published every semester.', 1),
    option('IND', 'Rohan Mehta', 'Independent', 'IND',
      'Final-year computer science student. Platform: funded hackathons, a mentoring programme for second-years, and free career clinics.', 2),
    option('GCC', 'Fatima Sheikh', 'Green Campus Collective', 'GCC',
      'Second-year environmental science student. Platform: a campus recycling programme, a rooftop solar feasibility study, and a student environment fund.', 3),
    option('SU', 'Kabir Rao', 'Sports Union', 'SU',
      'Third-year student and athletics captain. Platform: extended gym hours, an inter-faculty tournament, and equipment grants for every department.', 4),
    option('AF', 'Priya Nair', 'Academic Forum', 'AF',
      'Final-year mathematics student. Platform: a peer tutoring centre, revision sessions before every examination, and a research mentoring scheme.', 5),
    // A draft option is on the ballot but has not been approved, so it must not
    // appear to voters. Its presence is what makes the Candidates screen's
    // "Approve" action meaningful.
    option('IND2', 'Sameer Kulkarni', 'Independent', 'IND2',
      'Third-year mechanical student. Nomination papers still being verified before the ballot is certified.', 6, 'draft'),
  ]

  const voters = exclude(
    roll(random, 48, {
      prefix: 'STU-2026-',
      width: 4,
      groups: ['Computer Science', 'Mechanical', 'Environmental Science', 'Mathematics', 'Civil Engineering'],
    }),
    [
      'Postgraduate enrolment — this seat represents undergraduates only.',
      'Withdrew from the faculty before the roll closed.',
      'Enrolment could not be confirmed against the faculty register.',
    ],
  )

  return {
    id: 'UNI-2026-REPRESENTATIVE',
    title: 'Faculty of Engineering — Student Representative',
    description:
      'Election for the single undergraduate student representative seat on the faculty council. The representative sits on the faculty board for the 2026-27 academic year and chairs the student affairs subcommittee.',
    election_type: 'university',
    timezone: ZONE,
    startsInMs: T.openStart,
    endsInMs: T.openEnd,
    status: 'open',
    rules: rules({
      votesPerVoter: 1,
      allowNotA: true,
      resultsVisibility: 'live',
      randomizeBallotOrder: true,
      requireOtp: true,
    }),
    eligibility: eligibility({
      identifierLabel: 'Student ID',
      groupLabel: 'Department',
      notes:
        'Only students on the current enrolment register for the faculty of Engineering may vote. Postgraduate students are not eligible for the undergraduate representation seat.',
    }),
    ever_opened: 1,
    publishedInMs: -3 * DAY,
    options,
    voters,
    ballots: { count: 31, weights: { SUF: 30, IND: 24, GCC: 18, SU: 12, AF: 9, NOTA: 7 } },
  }
}

function organisationElection(): DemoElection {
  const random = lcg(0x5eed_1002)
  const options = [
    option('NEST', 'Leah Fernandes', 'New Students Union', 'NEST',
      'Platform: a Welcome Week with no paywall, a functioning common room, and a hardship fund students can apply to without a committee.', 1),
    option('QUAD', 'Imran Qureshi', 'Quadrennial', 'QUAD',
      'Platform: one representative per faculty rather than per year group, and a published register of what each seat achieved.', 2),
    option('APEX', 'Divya Krishnan', 'Apex Council', 'APEX',
      'Platform: three seats, a rotating chair, and a termly open forum that students can attend without registering.', 3),
    option('SOLO', 'Manav Sethi', 'Independent', 'IND',
      'Platform: fewer committees and more money spent on the building. Stands alone with no party behind the seat.', 4),
    option('VETO', 'Neha Bhatt', 'Referendum Group', 'VETO',
      'Platform: a binding student veto over any fee increase above a set threshold.', 5),
  ]

  const voters = exclude(
    roll(random, 24, {
      prefix: 'STU-2027-',
      width: 4,
      groups: ['Computer Science', 'Mechanical', 'Environmental Science', 'Mathematics'],
    }),
    ['Enrolment for the incoming year has not opened yet.'],
  )

  return {
    id: 'ORG-2026-PRESIDENT',
    title: "Students' Union — Three Executive Seats",
    description:
      'Election for the three executive seats of the students’ union. Every seat is filled by preferential ballot: voters rank up to three candidates, and seats are allocated by single transferable vote.',
    election_type: 'organization',
    timezone: ZONE,
    startsInMs: T.openStart - 4 * HOUR,
    endsInMs: T.openEnd + DAY,
    status: 'open',
    rules: rules({
      votesPerVoter: 3,
      allowNotA: true,
      resultsVisibility: 'live',
      randomizeBallotOrder: false,
      requireOtp: true,
    }),
    eligibility: eligibility({
      identifierLabel: 'Student ID',
      groupLabel: 'Faculty',
      notes: 'All students enrolled in the faculty may vote in up to three seats.',
    }),
    ever_opened: 1,
    publishedInMs: -4 * DAY,
    options,
    voters,
    // Three selections per ballot — the widest ballot in the workspace, so the
    // "oldest selection is dropped" rule and the multi-select counter both have
    // something to do.
    ballots: { count: 11, weights: { NEST: 22, QUAD: 19, APEX: 16, SOLO: 9, VETO: 7, NOTA: 5 } },
  }
}

function referendumElection(): DemoElection {
  const random = lcg(0x5eed_1003)
  const options = [
    option('KEEP', 'Keep the existing schedule', 'Keep Campus Open', 'KEEP',
      'Retain the present two-sessional timetable. No change to timetables or to the 8:30 start.', 1),
    option('SHIFT', 'Move to a single 8:30 start', 'Earlier Start', 'SHIFT',
      'Move every class to an 8:30 start for five days a week, and free the later afternoon for laboratories and the library.', 2),
    // Withdrawn after votes were already cast against it. This is the case that
    // proves a withdrawal is recorded rather than silently deleted: the option
    // keeps its history and stops counting.
    option('QUORUM', 'Introduce a quorum of 70 per cent', 'Quorum Group', 'QUORUM',
      'A vote needs 70 per cent of the roll to be valid. Withdrawn by the proposers during the poll.', 3, 'withdrawn',
      'Withdrawn by the proposers after the poll opened. Votes already cast against this option are retained for the record but are not counted toward the result.'),
    // Disqualified: cannot receive a vote at all.
    option('FREE', 'Make all teaching optional', 'Free Lecture Movement', 'FREE',
      'Lecture attendance becomes optional for all taught modules. Disqualified during the poll for an insufficient proposer mandate.', 4, 'disqualified',
      'Disqualified during the poll: the proposition was circulated without the proposer mandate required by the standing orders.'),
  ]

  const voters = exclude(
    roll(random, 36, {
      prefix: 'STU-2026-R-',
      width: 3,
      groups: ['All faculties', 'Postgraduate cohort', 'Residential colleges'],
    }),
    [
      'Voting rights suspended pending a conduct review.',
      'Not on the electoral register at the close of the roll.',
    ],
  )

  return {
    id: 'REF-2026-CURFEW',
    title: 'Referendum — Morning Class Start Times',
    description:
      'A binding referendum on whether the 8:30 start should be kept or moved across the faculty. This poll is currently paused by an election officer and voting will not be accepted while it is paused.',
    election_type: 'referendum',
    timezone: ZONE,
    // Deliberate drift: the window is still running but the officer paused the
    // poll, so the stored state and the clock disagree. This is the one election
    // whose StatusBadge shows the "auto" marker, and it is the reason that marker
    // exists.
    startsInMs: -1 * DAY,
    endsInMs: T.openEnd,
    status: 'paused',
    rules: rules({
      votesPerVoter: 1,
      allowNotA: true,
      allowAbstain: true,
      resultsVisibility: 'after_close',
      randomizeBallotOrder: true,
      requireOtp: true,
    }),
    eligibility: eligibility({
      identifierLabel: 'Voter ID',
      groupLabel: 'Register',
      notes: 'Everyone on the electoral register, including postgraduate and residential members, may vote.',
    }),
    ever_opened: 1,
    publishedInMs: -6 * DAY,
    options,
    voters,
    // Abstain draws a real share here, because the abstention clause is exactly
    // the part of this poll people disagree about.
    ballots: { count: 22, weights: { KEEP: 26, SHIFT: 21, QUORUM: 6, FREE: 1, NOTA: 9, ABSTAIN: 12 }, noisy: true },
  }
}

function primaryElection(): DemoElection {
  const random = lcg(0x5eed_1004)
  const options = [
    option('A', 'Dr Anita Krishnan', 'Faculty of Engineering', 'ANITA',
      'Professor of structural engineering, twenty-one years at the faculty. Standing on continuity of the research assessment scheme.', 1),
    option('B', 'Dr Samuel Otieno', 'Faculty of Engineering', 'SAMUEL',
      'Associate professor in environmental systems. Standing on undergraduate lab access and a doubling of the fieldwork budget.', 2),
    option('C', 'Dr Farah Siddiqui', 'Faculty of Engineering', 'FARAH',
      'Senior lecturer in computer science. Standing on industry placement numbers and a first-year programming course for every stream.', 3),
    option('D', 'Dr Peter Kolar', 'Faculty of Engineering', 'PETER',
      'Reader in applied mathematics. Standing on fewer compulsory modules and a published course catalogue.', 4),
  ]

  const voters = roll(random, 30, {
    prefix: 'FAC-2026-',
    width: 3,
    groups: ['Senior faculty', 'Associate faculty', 'Reader and above', 'Adjunct faculty'],
  })

  return {
    id: 'PRIM-2026-DEAN',
    title: 'Faculty Dean — Final Ballot',
    description:
      'The deciding ballot for the faculty deanship. Voting closed two days ago and the result has not yet been certified; certifying it is the last step before the outcome becomes the official record.',
    election_type: 'primary',
    timezone: ZONE,
    startsInMs: T.pastStart,
    endsInMs: T.pastEnd,
    status: 'closed',
    rules: rules({
      votesPerVoter: 1,
      allowNotA: true,
      resultsVisibility: 'after_close',
      randomizeBallotOrder: false,
      requireOtp: true,
    }),
    eligibility: eligibility({
      identifierLabel: 'Staff ID',
      groupLabel: 'Grade',
      notes: 'All faculty members on the payroll at the close of the roll.',
    }),
    ever_opened: 1,
    publishedInMs: -9 * DAY,
    options,
    voters,
    // Near-full turnout, because a closed ballot that has not been certified is
    // the one an officer is most likely to be looking at.
    ballots: { count: 27, weights: { A: 28, B: 22, C: 18, D: 9, NOTA: 5 } },
  }
}

function boardElection(): DemoElection {
  const random = lcg(0x5eed_1005)
  const options = [
    option('DUTY', 'Board of Trustees — Independent Member', 'Foundation nominee', 'DUTY',
      'Nominated by the foundation council to sit as a non-executive trustee with a four-year term.', 1),
    option('TREAS', 'Board of Trustees — Treasurer Seat', 'Foundation nominee', 'TREAS',
      'Nominated to the treasurer seat, responsible for the reserve policy and the annual accounts.', 2),
    option('ALUMNI', 'Board of Trustees — Alumni Representative', 'Alumni association', 'ALUMNI',
      'Nominated by the alumni association to represent graduates on the board.', 3),
    option('COOP', 'Board of Trustees — Staff Representative', 'Staff association', 'COOP',
      'Nominated by the staff association, the first seat reserved for a serving employee.', 4),
    option('STUD', 'Board of Trustees — Student Representative', 'Students’ union', 'STUD',
      'Nominated by the students’ union for a two-year term in attendance.', 5),
  ]

  const voters = roll(random, 40, {
    prefix: 'MEM-2026-',
    width: 3,
    groups: ['Foundation council', 'Alumni', 'Staff', 'Students', 'Patrons'],
  })

  return {
    id: 'BUD-2026-BOARD',
    title: 'Foundation Board of Trustees — 2026 Slate',
    description:
      'Five trustee seats filled in a single ballot. Voting closed a week ago and the outcome has been certified, so the result below is the official record and cannot be changed.',
    election_type: 'board',
    timezone: ZONE,
    startsInMs: T.certifiedStart,
    endsInMs: T.certifiedEnd,
    status: 'certified',
    rules: rules({
      votesPerVoter: 1,
      allowNotA: false,
      resultsVisibility: 'after_certify',
      randomizeBallotOrder: false,
    }),
    eligibility: eligibility({
      identifierLabel: 'Member ID',
      groupLabel: 'Membership class',
      notes: 'Members in good standing at the date the roll closed. Associate members are not eligible.',
    }),
    ever_opened: 1,
    publishedInMs: -16 * DAY,
    certifiedInMs: -8 * DAY,
    options,
    voters,
    ballots: { count: 34, weights: { DUTY: 30, TREAS: 24, ALUMNI: 19, COOP: 14, STUD: 8 }, noisy: true },
  }
}

function clubElection(): DemoElection {
  const random = lcg(0x5eed_1006)
  const options = [
    option('CS', 'Devika Iyer', 'Chess Society', 'CS',
      'Rating 2100, two-time inter-college champion. Plans an open ladder tournament and a coaching clinic for complete beginners.', 1),
    option('AB', 'Arjun Bose', 'Chess Society', 'CS',
      'Organiser of last year’s novice workshop. Plans a rated simulacrum evening and a rating ladder on the noticeboard.', 2),
    option('SQ', 'Sara Qureshi', 'Independent', 'IND',
      'Second-year mathematics student. Plans a blitz night series and outreach sessions with the school next door.', 3),
  ]

  const voters = exclude(
    roll(random, 18, {
      prefix: 'CHB-',
      width: 3,
      groups: ['Chess Society', 'Chess Society', 'Chess Society'],
    }),
    ['Society membership lapsed at the start of term.'],
  )

  return {
    id: 'CLUB-2026-CHAIR',
    title: 'Chess Society — Secretary',
    description:
      'Annual election for the secretary of the Chess Society. The secretary organises tournaments, maintains the rating ladder and manages society finances. Voting opens in two days.',
    election_type: 'club',
    timezone: ZONE,
    startsInMs: T.futureStart,
    endsInMs: T.futureEnd,
    status: 'scheduled',
    rules: rules({
      votesPerVoter: 1,
      allowNotA: true,
      resultsVisibility: 'after_close',
      randomizeBallotOrder: false,
      requireOtp: true,
    }),
    eligibility: eligibility({
      identifierLabel: 'Membership ID',
      groupLabel: 'Society',
      notes: 'Membership must be current at the time of the poll. Life members are eligible.',
    }),
    ever_opened: 0,
    publishedInMs: -20 * HOUR,
    options,
    voters,
    // Nothing cast yet: this is the election the "opens in…" countdown is for.
    ballots: null,
  }
}

function departmentElection(): DemoElection {
  const random = lcg(0x5eed_1007)
  const options = [
    option('CE', 'Marcus Fernandes', 'Civil Engineering', 'CE',
      'Final-year student. Platform: a new structural lab booking system and a site-visit fund.', 1),
    option('ZA', 'Zoya Ali', 'Civil Engineering', 'CE',
      'Third-year student. Platform: free Revit licences for the department and a weekly design critique.', 2),
    option('HS', 'Harpreet Singh', 'Civil Engineering', 'CE',
      'Final-year student. Platform: an alumni mentorship panel and a competition fund for site teams.', 3),
  ]

  const voters = exclude(
    roll(random, 15, {
      prefix: 'CE-2026-',
      width: 2,
      groups: ['Batch 2023', 'Batch 2024', 'Postgraduate cohort'],
    }),
    ['First-year students are not eligible for the department representative seat.'],
  )

  return {
    id: 'DEPT-2026-REPRESENTATIVE',
    title: 'Civil Engineering — Department Representative',
    description:
      'Departmental election for the student representative who coordinates lab access, industry visits and the department calendar. This record is still a draft: nothing is visible to voters and no votes are accepted until it is published and opened.',
    election_type: 'department',
    timezone: ZONE,
    startsInMs: T.draftStart,
    endsInMs: T.draftEnd,
    status: 'draft',
    rules: rules({
      // Two selections and an abstention: this is the multi-select ballot with a
      // special option, which no other election in the workspace combines.
      votesPerVoter: 2,
      allowAbstain: true,
      resultsVisibility: 'after_close',
      requireOtp: true,
    }),
    eligibility: eligibility({
      identifierLabel: 'Roll Number',
      groupLabel: 'Batch',
      notes: 'Only students in the third and fourth year batches are eligible.',
    }),
    ever_opened: 0,
    publishedInMs: null,
    options,
    voters,
    ballots: null,
  }
}

function municipalElection(): DemoElection {
  const random = lcg(0x5eed_1008)
  const options = [
    option('R1', 'Grace Fernandes', "Ward 1 — Riverside", 'RIV',
      'Riverside ward candidate. Platform: flood defences and a repair fund for the terrace houses.', 1),
    option('R2', 'Joseph Mathew', "Ward 1 — Riverside", 'RIV',
      'Riverside ward candidate. Platform: evening bus service and a second market entrance.', 2),
    option('R3', 'Aisha Begum', "Ward 1 — Riverside", 'RIV',
      'Riverside ward candidate. Platform: a community clinic opening four hours earlier each day.', 3),
    option('R4', 'Daniel Pereira', "Ward 1 — Riverside", 'RIV',
      'Riverside ward candidate. Platform: resurfacing the two worst stretches of road.', 4),
    option('R5', 'Lakshmi Raman', "Ward 1 — Riverside", 'RIV',
      'Riverside ward candidate. Platform: a ward development plan published each quarter.', 5),
    option('R6', 'Tom Whitfield', "Ward 1 — Riverside", 'RIV',
      'Riverside ward candidate. Platform: street lighting on every footpath before the monsoon.', 6),
  ]

  const voters = roll(random, 52, {
    prefix: 'WARD1-',
    width: 4,
    groups: ['Riverside ward', 'Riverside ward', 'Riverside ward', 'Out-of-ward resident'],
  })

  return {
    id: 'MUNI-2026-ALDERMAN',
    title: 'Ward 1 (Riverside) — Councillor',
    description:
      'Ward election for the Riverside councillor seat. This poll is under the standing order that ward results are never published: the tally is counted but stays inside the returning officer’s office.',
    election_type: 'municipal',
    timezone: ZONE,
    startsInMs: T.futureStart + DAY,
    endsInMs: T.futureEnd + DAY,
    status: 'scheduled',
    rules: rules({
      votesPerVoter: 1,
      allowNotA: false,
      resultsVisibility: 'never',
      randomizeBallotOrder: false,
    }),
    eligibility: eligibility({
      identifierLabel: 'Elector ID',
      groupLabel: 'Ward',
      notes: 'Electors registered in Ward 1 on the published roll date.',
    }),
    ever_opened: 0,
    publishedInMs: -2 * DAY,
    options,
    voters,
    ballots: null,
  }
}

function generalElection(): DemoElection {
  const random = lcg(0x5eed_1009)
  const options = [
    option('GA', 'Amendments to the Constitution', 'General', 'AMEND',
      'Adopt the constitutional amendments published in the notice paper of the last council meeting.', 1),
    option('GB', 'No change', 'General', 'NOCHANGE',
      'Reject the amendments and leave the constitution as it stands.', 2),
    option('GC', 'Amendments with the sunset clause', 'General', 'SUNSET',
      'Adopt the amendments, but subject them to review after seven years.', 3),
    option('GD', 'Refer the question to committee', 'General', 'COMMITTEE',
      'Refer the whole question to a committee with a report due in six months.', 4),
  ]

  const voters = roll(random, 44, {
    prefix: 'ELC-2025-',
    width: 4,
    groups: ['Members in good standing', 'Associate members', 'Life members'],
  })

  return {
    id: 'GEN-2025-BUDGET',
    title: 'General Meeting — Constitutional Amendments',
    description:
      'The annual general meeting vote on the constitutional amendments. This election is archived: it is retained for the record and its results were never published under the standing order for general business.',
    election_type: 'general',
    timezone: ZONE,
    startsInMs: T.archivedStart,
    endsInMs: T.archivedEnd,
    status: 'archived',
    rules: rules({
      votesPerVoter: 1,
      allowNotA: true,
      resultsVisibility: 'never',
      randomizeBallotOrder: false,
    }),
    eligibility: eligibility({
      identifierLabel: 'Member ID',
      groupLabel: 'Membership class',
      notes: 'Members in good standing on the date the roll closed.',
    }),
    ever_opened: 1,
    publishedInMs: T.archivedStart - 5 * DAY,
    archivedInMs: T.archivedStart - 2 * DAY,
    options,
    voters,
    ballots: { count: 41, weights: { GA: 25, GB: 22, GC: 17, GD: 6, NOTA: 9 } },
  }
}

/* ------------------------------------------------------------------ admins --- */

export type DemoAdmin = {
  username: string
  display_name: string
  password: string
  role: AdminRole
  mfa: boolean
  /** Fixed so the documented recovery codes stay valid forever. */
  recoverySalt: string
  recoveryCodes: string[]
  disabled?: boolean
  lockedForMinutes?: number
  lastSignedInMinutesAgo?: number
  mustChangePassword?: boolean
}

/**
 * One account per role, plus the two account states that otherwise need an
 * accident to reproduce.
 *
 * `tomas` is locked out and `dana` is disabled, which means the Administrators
 * screen has something in every state a row can be in: active, must-reset,
 * locked, disabled, and — because only `hana` carries a second factor — with and
 * without one. The locked and disabled accounts exist to make the Security
 * counters and the Overview "needs attention" list non-zero.
 */
const ADMINS: DemoAdmin[] = [
  {
    username: 'hana.wexford',
    display_name: 'Hana Wexford',
    password: 'Ballot-Demo-2026',
    role: 'super_admin',
    mfa: true,
    recoverySalt: 'demo-recovery-salt-hana',
    // Documented in the README: any one of these signs `hana` in at the code
    // step. Eight unused codes, so the recovery path can be tried repeatedly.
    recoveryCodes: [
      'H4NA-7KQR', '2XDM-9WTP', 'P8VF-3JHZ', 'R5TN-QB6Y',
      'W9CK-4LSM', 'Z2GX-7VDN', 'T6JY-8RPF', 'M3QB-5XHT',
    ],
    lastSignedInMinutesAgo: 12,
  },
  {
    username: 'leo.marchetti',
    display_name: 'Leo Marchetti',
    password: 'Ballot-Demo-2026',
    role: 'election_admin',
    mfa: false,
    recoverySalt: 'demo-recovery-salt-leo',
    recoveryCodes: [],
    lastSignedInMinutesAgo: 34,
  },
  {
    username: 'iris.nakamura',
    display_name: 'Iris Nakamura',
    password: 'Ballot-Demo-2026',
    role: 'election_officer',
    mfa: false,
    recoverySalt: 'demo-recovery-salt-iris',
    recoveryCodes: [],
    lastSignedInMinutesAgo: 55,
  },
  {
    username: 'gary.whitlock',
    display_name: 'Gary Whitlock',
    password: 'Ballot-Demo-2026',
    role: 'auditor',
    mfa: false,
    recoverySalt: 'demo-recovery-salt-gary',
    recoveryCodes: [],
    lastSignedInMinutesAgo: 95,
  },
  {
    username: 'mira.chatterjee',
    display_name: 'Mira Chatterjee',
    password: 'Ballot-Demo-2026',
    role: 'observer',
    mfa: false,
    recoverySalt: 'demo-recovery-salt-mira',
    recoveryCodes: [],
    lastSignedInMinutesAgo: 140,
  },
  {
    username: 'tomas.velasco',
    display_name: 'Tomás Velasco',
    password: 'Ballot-Demo-2026',
    role: 'election_officer',
    mfa: false,
    recoverySalt: 'demo-recovery-salt-tomas',
    recoveryCodes: [],
    // Locked, so the "locked accounts" counter and the unlock action are live.
    lockedForMinutes: 26,
    lastSignedInMinutesAgo: 200,
  },
  {
    username: 'dana.kovacs',
    display_name: 'Dana Kovács',
    password: 'Ballot-Demo-2026',
    role: 'auditor',
    mfa: false,
    recoverySalt: 'demo-recovery-salt-dana',
    recoveryCodes: [],
    // Disabled, so the enable/disable action and the disabled state are live.
    disabled: true,
    lastSignedInMinutesAgo: 60 * 24 * 9,
  },
]

/* ----------------------------------------------------------- audit history --- */

export type DemoAuditEvent = {
  minutesAgo: number
  actorType: 'admin' | 'system' | 'voter'
  actorRef: string
  action: string
  resource: string
  result: 'success' | 'denied' | 'failed'
  summary: string
  electionId?: string
  fromStatus?: ElectionStatus
  toStatus?: ElectionStatus
  ip?: string
  detail?: Record<string, unknown>
}

function history(): DemoAuditEvent[] {
  return [
    { minutesAgo: 9, actorType: 'admin', actorRef: 'hana.wexford', action: 'election_transition', resource: 'election:ORG-2026-PRESIDENT', result: 'success', summary: 'Voting opened for the students’ union executive seats.', electionId: 'ORG-2026-PRESIDENT', fromStatus: 'scheduled', toStatus: 'open', ip: '127.0.0.1' },
    { minutesAgo: 21, actorType: 'admin', actorRef: 'leo.marchetti', action: 'election_update', resource: 'election:PRIM-2026-DEAN', result: 'success', summary: 'Adjusted the closing time for the dean ballot.', electionId: 'PRIM-2026-DEAN', ip: '127.0.0.1' },
    { minutesAgo: 34, actorType: 'admin', actorRef: 'iris.nakamura', action: 'voters_imported', resource: 'election:UNI-2026-REPRESENTATIVE', result: 'success', summary: 'Imported 48 residents to the roll.', electionId: 'UNI-2026-REPRESENTATIVE', ip: '127.0.0.1', detail: { added: 48, skipped: 0 } },
    { minutesAgo: 38, actorType: 'admin', actorRef: 'iris.nakamura', action: 'certify_results', resource: 'election:PRIM-2026-DEAN', result: 'denied', summary: 'Election officers cannot certify results.', electionId: 'PRIM-2026-DEAN', ip: '127.0.0.1' },
    { minutesAgo: 46, actorType: 'system', actorRef: 'system', action: 'election_transition', resource: 'election:PRIM-2026-DEAN', result: 'success', summary: 'Voting closed automatically when the window elapsed.', electionId: 'PRIM-2026-DEAN', fromStatus: 'open', toStatus: 'closed', ip: '127.0.0.1' },
    { minutesAgo: 58, actorType: 'admin', actorRef: 'hana.wexford', action: 'election_transition', resource: 'election:REF-2026-CURFEW', result: 'success', summary: 'Voting paused pending review of a disqualified proposition.', electionId: 'REF-2026-CURFEW', fromStatus: 'open', toStatus: 'paused', ip: '127.0.0.1' },
    { minutesAgo: 62, actorType: 'voter', actorRef: 'voter:REF-2026-CURFEW', action: 'vote_cast', resource: 'election:REF-2026-CURFEW', result: 'success', summary: 'A ballot was cast.', electionId: 'REF-2026-CURFEW', ip: '127.0.0.1', detail: { selection_count: 1 } },
    { minutesAgo: 95, actorType: 'admin', actorRef: 'gary.whitlock', action: 'view_audit', resource: 'audit', result: 'success', summary: 'Exported the audit timeline.', ip: '127.0.0.1' },
    { minutesAgo: 118, actorType: 'admin', actorRef: 'hana.wexford', action: 'certify_results', resource: 'election:BUD-2026-BOARD', result: 'success', summary: 'Results certified for the board slate.', electionId: 'BUD-2026-BOARD', fromStatus: 'closed', toStatus: 'certified', ip: '127.0.0.1', detail: { ballots_at_transition: 34 } },
    { minutesAgo: 140, actorType: 'admin', actorRef: 'mira.chatterjee', action: 'update_settings', resource: 'settings', result: 'denied', summary: 'Observers have read-only access.', ip: '127.0.0.1' },
    { minutesAgo: 180, actorType: 'admin', actorRef: 'leo.marchetti', action: 'candidate_set_status', resource: 'candidate:REF-2026-CURFEW/FREE', result: 'success', summary: 'Disqualified "Make all teaching optional".', electionId: 'REF-2026-CURFEW', ip: '127.0.0.1', detail: { status: 'disqualified', reason: 'Insufficient proposer mandate under the standing orders.' } },
    { minutesAgo: 205, actorType: 'admin', actorRef: 'leo.marchetti', action: 'candidate_set_status', resource: 'candidate:REF-2026-CURFEW/QUORUM', result: 'success', summary: 'Withdrew "Introduce a quorum of 70 per cent".', electionId: 'REF-2026-CURFEW', ip: '127.0.0.1', detail: { status: 'withdrawn' } },
    { minutesAgo: 240, actorType: 'admin', actorRef: 'iris.nakamura', action: 'voters_added', resource: 'election:ORG-2026-PRESIDENT', result: 'success', summary: 'Added 24 residents to the roll.', electionId: 'ORG-2026-PRESIDENT', ip: '127.0.0.1', detail: { added: 24 } },
    { minutesAgo: 300, actorType: 'admin', actorRef: 'hana.wexford', action: 'election_transition', resource: 'election:UNI-2026-REPRESENTATIVE', result: 'success', summary: 'Voting opened for the faculty representative seat.', electionId: 'UNI-2026-REPRESENTATIVE', fromStatus: 'scheduled', toStatus: 'open', ip: '127.0.0.1' },
    { minutesAgo: 430, actorType: 'admin', actorRef: 'hana.wexford', action: 'election_publish', resource: 'election:UNI-2026-REPRESENTATIVE', result: 'success', summary: 'Published the faculty representative election.', electionId: 'UNI-2026-REPRESENTATIVE', fromStatus: 'draft', toStatus: 'scheduled', ip: '127.0.0.1' },
    { minutesAgo: 520, actorType: 'admin', actorRef: 'leo.marchetti', action: 'rules_updated', resource: 'election:DEPT-2026-REPRESENTATIVE', result: 'success', summary: 'Changed the ballot to allow two selections and an abstention.', electionId: 'DEPT-2026-REPRESENTATIVE', ip: '127.0.0.1' },
    { minutesAgo: 610, actorType: 'admin', actorRef: 'iris.nakamura', action: 'candidate_add', resource: 'election:UNI-2026-REPRESENTATIVE', result: 'success', summary: 'Added "Sameer Kulkarni" to the ballot.', electionId: 'UNI-2026-REPRESENTATIVE', ip: '127.0.0.1' },
    { minutesAgo: 700, actorType: 'admin', actorRef: 'tomas.velasco', action: 'voter_eligibility_changed', resource: 'election:UNI-2026-REPRESENTATIVE', result: 'failed', summary: 'Could not exclude the voter: the roll is frozen.', electionId: 'UNI-2026-REPRESENTATIVE', ip: '127.0.0.1' },
    { minutesAgo: 820, actorType: 'admin', actorRef: 'hana.wexford', action: 'backup_created', resource: 'backup', result: 'success', summary: 'Manual snapshot created.', ip: '127.0.0.1', detail: { label: 'before-council-vote' } },
    { minutesAgo: 900, actorType: 'system', actorRef: 'system', action: 'election_transition', resource: 'election:GEN-2025-BUDGET', result: 'success', summary: 'Voting opened automatically at the scheduled start.', electionId: 'GEN-2025-BUDGET', fromStatus: 'scheduled', toStatus: 'open', ip: '127.0.0.1' },
    { minutesAgo: 1400, actorType: 'admin', actorRef: 'hana.wexford', action: 'election_archive', resource: 'election:GEN-2025-BUDGET', result: 'success', summary: 'Archived the general meeting election.', electionId: 'GEN-2025-BUDGET', fromStatus: 'certified', toStatus: 'archived', ip: '127.0.0.1' },
    { minutesAgo: 1600, actorType: 'admin', actorRef: 'gary.whitlock', action: 'election_archive', resource: 'election:GEN-2025-BUDGET', result: 'denied', summary: 'Auditors cannot change an election.', electionId: 'GEN-2025-BUDGET', ip: '127.0.0.1' },
  ]
}

/* --------------------------------------------------------- security events --- */

export type DemoSecurityEvent = {
  minutesAgo: number
  kind: string
  summary: string
  severity: 'info' | 'notice' | 'warning' | 'critical'
  adminRef?: string
  ip?: string
  acknowledgedMinutesAgo?: number
  detail?: Record<string, unknown>
}

function securityLog(): DemoSecurityEvent[] {
  return [
    { minutesAgo: 7, kind: 'voter_verification_failed', severity: 'notice', summary: 'A spent one-time code was presented again and refused.', ip: '127.0.0.1', detail: { reason: 'code_already_consumed', election: 'UNI-2026-REPRESENTATIVE' } },
    { minutesAgo: 17, kind: 'login_failed', severity: 'warning', summary: 'Five failed sign-in attempts for an unknown account from the same address.', ip: '127.0.0.1', acknowledgedMinutesAgo: 4, detail: { username: 'j.chen', attempts: 5 } },
    { minutesAgo: 29, kind: 'mfa_failed', severity: 'warning', summary: 'A second-factor code was entered incorrectly for hana.wexford.', adminRef: 'hana.wexford', ip: '127.0.0.1', detail: { reason: 'bad_code' } },
    { minutesAgo: 33, kind: 'reauthenticated', severity: 'info', summary: 'Re-authentication completed for certifying the board slate.', adminRef: 'hana.wexford', ip: '127.0.0.1', acknowledgedMinutesAgo: 20, detail: { election: 'BUD-2026-BOARD' } },
    { minutesAgo: 51, kind: 'session_revoked', severity: 'warning', summary: 'A revoked administrator session token was replayed and refused.', ip: '127.0.0.1', detail: { username: 'tomas.velasco' } },
    { minutesAgo: 63, kind: 'account_locked', severity: 'warning', summary: 'Account locked after repeated failed sign-ins: tomas.velasco.', adminRef: 'tomas.velasco', ip: '127.0.0.1', acknowledgedMinutesAgo: 55, detail: { locked_for_minutes: 15 } },
    { minutesAgo: 88, kind: 'voter_verified', severity: 'info', summary: 'A voter completed verification for the faculty representative election.', ip: '127.0.0.1', detail: { election: 'UNI-2026-REPRESENTATIVE' } },
    { minutesAgo: 94, kind: 'voter_verification_new_address', severity: 'notice', summary: 'A voter verified from an address not seen before.', ip: '127.0.0.1', detail: { election: 'ORG-2026-PRESIDENT' } },
    { minutesAgo: 150, kind: 'ballot_credential_rejected', severity: 'notice', summary: 'A ballot was refused because its voting credential had expired.', ip: '127.0.0.1', detail: { election: 'UNI-2026-REPRESENTATIVE', state: 'expired' } },
    { minutesAgo: 205, kind: 'approval_granted', severity: 'info', summary: 'Two-person approval granted for restoring the database from a nightly archive.', adminRef: 'leo.marchetti', ip: '127.0.0.1', acknowledgedMinutesAgo: 180, detail: { backup: 'nightly-automatic' } },
    { minutesAgo: 260, kind: 'mfa_recovery_used', severity: 'warning', summary: 'A recovery code was used to complete a second factor.', adminRef: 'hana.wexford', ip: '127.0.0.1', detail: { reason: 'lost_authenticator' } },
    { minutesAgo: 310, kind: 'permission_denied', severity: 'warning', summary: 'An observer attempted to change platform settings.', adminRef: 'mira.chatterjee', ip: '127.0.0.1', acknowledgedMinutesAgo: 300, detail: { permission: 'settings.manage' } },
    { minutesAgo: 340, kind: 'account_disabled', severity: 'warning', summary: 'Account disabled: dana.kovacs.', adminRef: 'hana.wexford', ip: '127.0.0.1', detail: { reason: 'Left the institution.' } },
    { minutesAgo: 420, kind: 'rate_limited', severity: 'warning', summary: 'Too many verification attempts from one address; the caller was rate limited.', ip: '127.0.0.1', detail: { limit: 10, window_seconds: 60 } },
    { minutesAgo: 520, kind: 'password_changed', severity: 'notice', summary: 'Password changed for leo.marchetti.', adminRef: 'leo.marchetti', ip: '127.0.0.1', acknowledgedMinutesAgo: 500 },
    { minutesAgo: 700, kind: 'backup_restored', severity: 'critical', summary: 'The database was replaced from a pre-restore snapshot.', adminRef: 'hana.wexford', ip: '127.0.0.1', detail: { backup: 'before-council-vote', safety_backup: true } },
    { minutesAgo: 900, kind: 'origin_rejected', severity: 'warning', summary: 'A request with a cross-site origin was refused.', ip: '127.0.0.1', detail: { host: 'example.invalid' } },
    { minutesAgo: 1100, kind: 'election_transition', severity: 'info', summary: 'Two-person approval granted for disabling an administrator account.', adminRef: 'leo.marchetti', ip: '127.0.0.1', acknowledgedMinutesAgo: 1050 },
    { minutesAgo: 1300, kind: 'system_reset', severity: 'critical', summary: 'The platform was reset to a clean state during setup.', adminRef: 'hana.wexford', ip: '127.0.0.1', acknowledgedMinutesAgo: 1250, detail: { keep_admins: true } },
  ]
}

/* -------------------------------------------------------------- approvals --- */

export type DemoApproval = {
  minutesAgo: number
  /** Username of the requester. */
  requestedBy: string
  /** Username of the decider, or null while the request is still pending. */
  decidedBy?: string | null
  permission: string
  action: string
  resource: string
  electionId?: string
  payloadSummary: string
  justification: string
  status: 'pending' | 'approved' | 'rejected' | 'expired'
  decisionNote?: string
  /** Present when decided, so the audit history matches the queue. */
  executedMinutesAgo?: number
}

function approvals(): DemoApproval[] {
  return [
    {
      // The live one. Leo holds election.reopen and it needs a second pair of
      // eyes, so this is a request that can actually be approved from the
      // Security → Approvals tab by signing in as a different administrator.
      minutesAgo: 14,
      requestedBy: 'leo.marchetti',
      decidedBy: null,
      permission: 'election.reopen',
      action: 'election.reopen',
      resource: 'election:PRIM-2026-DEAN',
      electionId: 'PRIM-2026-DEAN',
      payloadSummary: 'Reopen the dean ballot so two faculty members who missed the deadline can vote.',
      justification:
        'Two of thirty voted by faculty missed the close because the mail server was down and the notice never reached them. Both have asked to vote. Requesting a reopen so the seat is decided by the full faculty rather than by an outage.',
      status: 'pending',
    },
    {
      minutesAgo: 200,
      requestedBy: 'hana.wexford',
      decidedBy: 'leo.marchetti',
      permission: 'backup.restore',
      action: 'backup.restore',
      resource: 'backup:4',
      payloadSummary: 'Restore the database from "nightly automatic" taken 02 Oct 2026, 06:08 (412 KB).',
      justification:
        'A roll import was applied to the wrong election. Restoring from the 06:08 archive is the fastest way back to the state that was verified before the import.',
      status: 'approved',
      decisionNote: 'Checked the roll totals against the council register. Restore looks safe to run.',
      executedMinutesAgo: 195,
    },
    {
      minutesAgo: 340,
      requestedBy: 'iris.nakamura',
      decidedBy: 'hana.wexford',
      permission: 'system.reset',
      action: 'system.reset',
      resource: 'platform',
      payloadSummary: 'Reset the platform, keeping administrator accounts.',
      justification: 'The demo workspace needs rebuilding from scratch before the term starts.',
      status: 'rejected',
      decisionNote: 'Declined. Rebuild the elections individually instead — a reset would take the accounts with it.',
    },
  ]
}

/* ----------------------------------------------------------------- backups --- */

export type DemoBackup = {
  label: string
  /** Milliseconds from seed time. */
  takenInMs: number
  kind: 'manual' | 'scheduled' | 'pre_restore' | 'pre_reset'
  note: string
  createdBy?: string
}

function backupHistory(): DemoBackup[] {
  return [
    { label: 'nightly-automatic', takenInMs: -3 * HOUR, kind: 'scheduled', note: 'Automatic archive taken overnight.', createdBy: 'system' },
    { label: 'before-council-vote', takenInMs: -14 * HOUR, kind: 'manual', note: 'Taken before the council meeting restored from the 06:08 archive.', createdBy: 'hana.wexford' },
    { label: 'before-roll-import', takenInMs: -26 * HOUR, kind: 'manual', note: 'Taken before the 48-row roll import.', createdBy: 'leo.marchetti' },
    { label: 'pre-restore-snapshot', takenInMs: -200 * MINUTE, kind: 'pre_restore', note: 'Automatic snapshot taken immediately before a restore.', createdBy: 'system' },
    { label: 'nightly-automatic-2', takenInMs: -27 * HOUR, kind: 'scheduled', note: 'Automatic archive taken overnight.', createdBy: 'system' },
    { label: 'start-of-term', takenInMs: -8 * DAY, kind: 'manual', note: 'Baseline snapshot taken at the start of the teaching term.', createdBy: 'hana.wexford' },
  ]
}

/* ---------------------------------------------------------------- sessions --- */

/**
 * Historical session rows.
 *
 * Only sessions that are still within their lifetime are seeded, and their tokens
 * are unguessable, so none of these rows can be turned into a working sign-in: they
 * exist to give the Sessions tab its states — "this session", another person's
 * active session, and sessions that were revoked with a stated reason — without
 * pre-authenticating anybody. A repository that shipped usable console tokens
 * would be a repository that shipped console access.
 *
 * Expired sessions are deliberately absent. The server purges them on the next
 * sign-in, so a fixture full of them would be empty again by the time anybody
 * looked at the screen.
 */
export type DemoSession = {
  adminRef: string
  startedInMs: number
  lastSeenInMs: number
  ip: string
  userAgent: string
  mfaVerified: boolean
  revokedAfterMinutes?: number
  revokedReason?: string
}

function sessions(): DemoSession[] {
  return [
    { adminRef: 'tomas.velasco', startedInMs: -230 * MINUTE, lastSeenInMs: -52 * MINUTE, ip: '127.0.0.1', userAgent: 'Mozilla/5.0 (Macintosh) Demo browser', mfaVerified: false, revokedAfterMinutes: 8, revokedReason: 'signed out' },
    { adminRef: 'leo.marchetti', startedInMs: -190 * MINUTE, lastSeenInMs: -22 * MINUTE, ip: '127.0.0.1', userAgent: 'Mozilla/5.0 (Macintosh) Demo browser', mfaVerified: false, revokedAfterMinutes: 15, revokedReason: 'superseded by a new verification' },
    { adminRef: 'mira.chatterjee', startedInMs: -150 * MINUTE, lastSeenInMs: -141 * MINUTE, ip: '127.0.0.1', userAgent: 'Mozilla/5.0 (Macintosh) Demo browser', mfaVerified: false, revokedAfterMinutes: 3, revokedReason: 'signed out' },
    { adminRef: 'iris.nakamura', startedInMs: -58 * MINUTE, lastSeenInMs: -34 * MINUTE, ip: '127.0.0.1', userAgent: 'Mozilla/5.0 (Macintosh) Demo browser', mfaVerified: false },
  ]
}

/* ------------------------------------------------------------------- build --- */

/**
 * Assemble the whole workspace.
 *
 * `nowMs` is injected rather than read from the clock inside the generators so
 * the caller controls the reference point; `Store` passes the moment the database
 * is opened, which is also the moment every relative time is measured from.
 */
export function createDemoDataset(nowMs: number): DemoDataset {
  const elections = [
    universityElection(),
    organisationElection(),
    referendumElection(),
    primaryElection(),
    boardElection(),
    clubElection(),
    departmentElection(),
    municipalElection(),
    generalElection(),
  ]

  return {
    nowMs,
    elections,
    admins: ADMINS,
    auditEvents: history(),
    securityEvents: securityLog(),
    approvals: approvals(),
    backups: backupHistory(),
    sessions: sessions(),
    settings: {
      // Deliberately not the defaults everywhere, so the Settings screen shows a
      // platform that has been configured rather than one that has never been
      // touched. Nothing here weakens security: `requireMfa` stays off (only one
      // demo account has a second factor, and turning the requirement on would
      // lock the other four out of the console) and `revealDemoPasscodes` stays
      // off (disclosure is switched on by the ELECTION_DEMO_OTP environment
      // variable instead, so `npm run dev:secure` cannot be defeated by demo
      // data).
      ...DEFAULT_SETTINGS,
      backupRetention: 14,
      sessionIdleMinutes: 720,
      maxLoginAttempts: 6,
      credentialTtlSeconds: 1200,
    },
  }
}

export type DemoDataset = {
  nowMs: number
  elections: DemoElection[]
  admins: DemoAdmin[]
  auditEvents: DemoAuditEvent[]
  securityEvents: DemoSecurityEvent[]
  approvals: DemoApproval[]
  backups: DemoBackup[]
  sessions: DemoSession[]
  settings: PlatformSettings
}

/* -------------------------------------------------------------- demo login --- */

/**
 * The one password every seeded administrator shares.
 *
 * A demo workspace is read by people who did not create it, and seven accounts
 * with seven passwords is seven things to write down before anything can be
 * clicked. That is the trade, and it is only safe because this data is
 * disposable — `npm run demo:reset` throws the whole workspace away.
 *
 * Note that it deliberately *satisfies* the password policy rather than dodging
 * it: it is long and uses all four character classes, so it would be accepted on
 * a real deployment. That is exactly why it must never be reused — a memorable
 * password that passes the checks is the one people do reuse. Replace it before
 * pointing this at anything that matters.
 */
export const DEMO_PASSWORD = 'Ballot-Demo-2026'