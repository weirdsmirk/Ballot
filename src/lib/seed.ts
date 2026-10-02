/**
 * Demonstration seed data.
 *
 * This module contains *fixtures only*. Nothing in the application reads these
 * values at runtime: candidates, ballots and voter rolls are database records
 * scoped to a specific election, and an administrator creates every one of them
 * through the admin workflow. This seed exists so a fresh install has something
 * to look at, and it deliberately covers three different election types in three
 * different lifecycle states to show that the platform is not hardcoded to one
 * scenario.
 */

import {
  type CandidateStatus,
  type ElectionStatus,
  type ElectionType,
  type EligibilityRules,
  type ElectionRules,
} from './types'
import { defaultEligibility, defaultRules } from './validate'

export type SeedCandidate = {
  name: string
  organization: string
  abbreviation: string
  description: string
  image_url: string
  symbol: string
  position: number
  status: CandidateStatus
}

export type SeedVoter = {
  voter_id: string
  full_name: string
  phone: string
  email: string
  external_ref: string
  is_eligible: 0 | 1
}

export type SeedElection = {
  id: string
  title: string
  description: string
  election_type: ElectionType
  timezone: string
  starts_at: string
  ends_at: string
  status: ElectionStatus
  rules: ElectionRules
  eligibility: EligibilityRules
  ever_opened: 0 | 1
  published_at: string | null
  candidates: SeedCandidate[]
  voters: SeedVoter[]
}

const HOUR = 3_600_000
const DAY = 86_400_000

const DEMO_ZONE = 'Asia/Kolkata'

function iso(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString()
}

function candidate(
  position: number,
  name: string,
  organization: string,
  abbreviation: string,
  description: string,
  symbol: string,
  status: CandidateStatus = 'approved',
): SeedCandidate {
  return { name, organization, abbreviation, description, image_url: '', symbol, position, status }
}

const UNIVERSITY_CANDIDATES: SeedCandidate[] = [
  candidate(
    1,
    'Ananya Deshmukh',
    'Student Unity Front',
    'SUF',
    'Third-year engineering student. Platform: transparent attendance policy, a 24-hour library extension, and an open budget published each semester.',
    'SUF',
  ),
  candidate(
    2,
    'Rohan Mehta',
    'Independent',
    'IND',
    'Final-year computer science student. Platform: funded hackathons, a mentoring programme for second-years, and free career counselling clinics.',
    'IND',
  ),
  candidate(
    3,
    'Fatima Sheikh',
    'Green Campus Collective',
    'GCC',
    'Second-year environmental science student. Platform: a campus recycling programme, solar rooftop feasibility study, and a student environment fund.',
    'GCC',
  ),
  candidate(
    4,
    'Kabir Rao',
    'Sports Union',
    'SU',
    'Third-year student and captain of the athletics team. Platform: extended gym hours, an inter-faculty tournament, and equipment grants for every department.',
    'SU',
  ),
  candidate(
    5,
    'Priya Nair',
    'Academic Forum',
    'AF',
    'Final-year mathematics student. Platform: a peer tutoring centre, extended examination revision sessions, and a research mentoring scheme.',
    'AF',
  ),
]

const UNIVERSITY_VOTERS: SeedVoter[] = [
  { voter_id: 'STU-2026-0001', full_name: 'Aarav Sharma', phone: '9876543210', email: 'aarav.sharma@example.com', external_ref: 'Computer Science', is_eligible: 1 },
  { voter_id: 'STU-2026-0002', full_name: 'Isha Patel', phone: '8765432109', email: 'isha.patel@example.com', external_ref: 'Computer Science', is_eligible: 1 },
  { voter_id: 'STU-2026-0003', full_name: 'Rohan Gupta', phone: '7654321098', email: 'rohan.gupta@example.com', external_ref: 'Mechanical', is_eligible: 1 },
  { voter_id: 'STU-2026-0004', full_name: 'Meera Nair', phone: '9012345678', email: 'meera.nair@example.com', external_ref: 'Environmental Science', is_eligible: 1 },
  { voter_id: 'STU-2026-0005', full_name: 'Vikram Singh', phone: '8901234567', email: 'vikram.singh@example.com', external_ref: 'Mechanical', is_eligible: 1 },
  { voter_id: 'STU-2026-0006', full_name: 'Ananya Das', phone: '7890123456', email: 'ananya.das@example.com', external_ref: 'Mathematics', is_eligible: 1 },
  { voter_id: 'STU-2026-0007', full_name: 'Kabir Rao', phone: '7011223344', email: 'kabir.rao@example.com', external_ref: 'Mathematics', is_eligible: 1 },
  { voter_id: 'STU-2026-0008', full_name: 'Priya Nair', phone: '7011223355', email: 'priya.nair@example.com', external_ref: 'Computer Science', is_eligible: 1 },
  { voter_id: 'STU-2026-0009', full_name: 'Fatima Sheikh', phone: '7011223366', email: 'fatima.sheikh@example.com', external_ref: 'Environmental Science', is_eligible: 0 },
]

const CLUB_CANDIDATES: SeedCandidate[] = [
  candidate(1, 'Devika Iyer', 'Chess Society', 'CS', 'Rating 2100, two-time inter-college champion. Plans an open ladder tournament and a coaching clinic for beginners.', 'CS'),
  candidate(2, 'Arjun Bose', 'Chess Society', 'CS', "Organiser of the previous year's novice workshop. Plans a rated simulacrum evening and a rating ladder on the noticeboard.", 'CS'),
  candidate(3, 'Sara Qureshi', 'Independent', 'IND', 'Second-year mathematics student. Plans a blitz night series and outreach sessions with the school nearby.', 'IND'),
]

const CLUB_VOTERS: SeedVoter[] = [
  { voter_id: 'CHB-014', full_name: 'Nikhil Verma', phone: '9800011122', email: 'nikhil.verma@example.com', external_ref: 'Chess Society', is_eligible: 1 },
  { voter_id: 'CHB-027', full_name: 'Tara Menon', phone: '9800022233', email: 'tara.menon@example.com', external_ref: 'Chess Society', is_eligible: 1 },
  { voter_id: 'CHB-031', full_name: 'Yusuf Khan', phone: '9800033344', email: 'yusuf.khan@example.com', external_ref: 'Chess Society', is_eligible: 1 },
  { voter_id: 'CHB-044', full_name: 'Leah Fernandes', phone: '9800044455', email: 'leah.fernandes@example.com', external_ref: 'Chess Society', is_eligible: 1 },
]

const DEPARTMENT_CANDIDATES: SeedCandidate[] = [
  candidate(1, 'Marcus Fernandes', 'Civil Engineering', 'CE', 'Final-year student. Platform: a new structural lab booking system and a site-visit fund.', 'CE'),
  candidate(2, 'Zoya Ali', 'Civil Engineering', 'CE', 'Third-year student. Platform: free Revit licences for the department and a weekly design critique.', 'CE'),
  candidate(3, 'Harpreet Singh', 'Civil Engineering', 'CE', 'Final-year student. Platform: an alumni mentorship panel and a competition fund for site teams.', 'CE'),
]

const DEPARTMENT_VOTERS: SeedVoter[] = [
  { voter_id: 'CE-2026-01', full_name: 'Anil Kapoor', phone: '9700011122', email: 'anil.kapoor@example.com', external_ref: 'Civil Engineering', is_eligible: 1 },
  { voter_id: 'CE-2026-02', full_name: 'Sneha Joshi', phone: '9700022233', email: 'sneha.joshi@example.com', external_ref: 'Civil Engineering', is_eligible: 1 },
  { voter_id: 'CE-2026-03', full_name: 'Ravi Pillai', phone: '9700033344', email: 'ravi.pillai@example.com', external_ref: 'Civil Engineering', is_eligible: 1 },
]

export function createDefaultData(): { elections: SeedElection[] } {
  const universityRules: ElectionRules = {
    ...defaultRules(),
    votesPerVoter: 1,
    allowNotA: true,
    resultsVisibility: 'live',
    randomizeBallotOrder: true,
  }
  const universityEligibility: EligibilityRules = {
    ...defaultEligibility(),
    identifierLabel: 'Student ID',
    groupLabel: 'Department',
    notes:
      'Only students on the current enrolment register for the faculty of Engineering may vote. Postgraduate students are not eligible for the undergraduate representation seat.',
  }

  const clubRules: ElectionRules = {
    ...defaultRules(),
    votesPerVoter: 1,
    resultsVisibility: 'after_close',
    randomizeBallotOrder: false,
  }
  const clubEligibility: EligibilityRules = {
    ...defaultEligibility(),
    identifierLabel: 'Membership ID',
    groupLabel: 'Society',
    notes: 'Membership must be current at the time of the poll. Life members are eligible.',
  }

  const departmentRules: ElectionRules = {
    ...defaultRules(),
    votesPerVoter: 1,
    allowNotA: true,
    requireOtp: true,
    resultsVisibility: 'after_close',
  }

  return {
    elections: [
      {
        id: 'UNI-2026-REPRESENTATIVE',
        title: 'Faculty of Engineering — Student Representative',
        description:
          'Election for the single undergraduate student representative seat on the faculty council. The elected representative sits on the faculty board for the 2026-27 academic year and chairs the student affairs subcommittee.',
        election_type: 'university',
        timezone: DEMO_ZONE,
        starts_at: iso(-2 * HOUR),
        ends_at: iso(3 * DAY),
        status: 'open',
        rules: universityRules,
        eligibility: universityEligibility,
        ever_opened: 1,
        published_at: iso(-3 * DAY),
        candidates: UNIVERSITY_CANDIDATES,
        voters: UNIVERSITY_VOTERS,
      },
      {
        id: 'CLUB-2026-CHAIR',
        title: 'Chess Society — Secretary',
        description:
          'Annual election for the secretary of the Chess Society. The secretary organises tournaments, maintains the rating ladder, and manages society finances.',
        election_type: 'club',
        timezone: DEMO_ZONE,
        starts_at: iso(2 * DAY),
        ends_at: iso(4 * DAY),
        status: 'scheduled',
        rules: clubRules,
        eligibility: clubEligibility,
        ever_opened: 0,
        published_at: iso(-HOUR),
        candidates: CLUB_CANDIDATES,
        voters: CLUB_VOTERS,
      },
      {
        id: 'DEPT-2026-REPRESENTATIVE',
        title: 'Civil Engineering — Department Representative',
        description:
          'Departmental election for the student representative who coordinates lab access, industry visits, and the department calendar. This record is still a draft.',
        election_type: 'department',
        timezone: DEMO_ZONE,
        starts_at: iso(7 * DAY),
        ends_at: iso(8 * DAY),
        status: 'draft',
        rules: departmentRules,
        eligibility: {
          ...defaultEligibility(),
          identifierLabel: 'Roll Number',
          groupLabel: 'Batch',
          notes: 'Only students in the third and fourth year batches are eligible.',
        },
        ever_opened: 0,
        published_at: null,
        candidates: DEPARTMENT_CANDIDATES,
        voters: DEPARTMENT_VOTERS,
      },
    ],
  }
}
