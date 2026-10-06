/**
 * A resumed voter session must always land on a screen.
 *
 * The session cookie is `HttpOnly`, so the page cannot know whether it is signed in
 * and has to ask the server on every election it opens. That ask has three possible
 * answers — verified and unvoted, verified and already voted, or not verified — and
 * each one owes the voter a screen.
 *
 * This file exists because the middle case was broken. The resume effect chose the
 * `receipt` stage whenever the server reported `has_voted`, but the receipt payload
 * only ever exists in memory for the response to a vote that this page just
 * submitted; the server will not return a digest on a later request, because the
 * ballot is deliberately not retrievable by identity. So a voter who reloaded the
 * page, or opened a second tab sharing the cookie, got `stage === 'receipt'` with
 * `receipt === null` and the guarded render produced nothing at all.
 *
 * The symptom was a blank page for someone who had already voted — no confirmation,
 * no receipt, no way forward. The regression is invisible to a server-side test
 * because every server response was correct; only the render was wrong. Hence a
 * component test rather than another row in a command test.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { voterApi, type VoterBallotResult, type VoterVoteResult } from '../lib/api'
import type { BallotOption, ElectionResults, ElectionSummary, TallyRow } from '../lib/types'
import { VoterFlow } from './VoterFlow'

vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>()
  return {
    ...actual,
    // The session helpers are real: they only touch in-memory flags, and stubbing
    // them would hide whether the flow treats a restored session as signed in.
    voterApi: {
      ...actual.voterApi,
      ballot: vi.fn(),
      vote: vi.fn(),
    },
  }
})

const mockedBallot = vi.mocked(voterApi.ballot)
const mockedVote = vi.mocked(voterApi.vote)

const ELECTION: ElectionSummary = {
  id: 'UNI-2026-REPRESENTATIVE',
  title: 'Faculty of Engineering — Student Representative',
  description: 'Election for the single undergraduate seat on the faculty council.',
  election_type: 'general',
  timezone: 'Asia/Kolkata',
  starts_at: '2026-09-26T09:53:00.000Z',
  ends_at: '2026-09-29T11:53:00.000Z',
  status: 'open',
  effective_status: 'open',
  schedule_drifted: false,
  rules: {
    votesPerVoter: 1,
    allowNotA: false,
    allowAbstain: false,
    requireOtp: true,
    requirePhone: true,
    requireEmail: true,
    resultsVisibility: 'after_close',
    allowVoteChange: false,
    issueReceipts: true,
    randomizeBallotOrder: false,
    showCandidateImages: false,
  },
  eligibility: {
    mode: 'roll',
    identifierLabel: 'Student ID',
    groupLabel: 'Department',
    notes: '',
  },
  created_at: '2026-09-01T00:00:00.000Z',
  updated_at: '2026-09-01T00:00:00.000Z',
  published_at: '2026-09-20T00:00:00.000Z',
  closed_at: null,
  certified_at: null,
  archived_at: null,
  candidate_count: 2,
  approved_candidate_count: 2,
  eligible_count: 148,
  participant_count: 96,
  ballot_count: 96,
  locked: false,
  edits_allowed: true,
  status_changes_allowed: true,
  actions: [],
}

const CANDIDATES: BallotOption[] = [
  {
    key: 'candidate-1',
    kind: 'candidate',
    name: 'Ada Okonkwo',
    organization: 'Mechanical Engineering',
    abbreviation: 'AO',
    description: 'Three years on the student affairs subcommittee.',
    image_url: '',
    symbol: 'AO',
    position: 1,
    status: 'approved',
  },
  {
    key: 'candidate-2',
    kind: 'candidate',
    name: 'Ravi Menon',
    organization: 'Civil Engineering',
    abbreviation: 'RM',
    description: '',
    image_url: '',
    symbol: 'RM',
    position: 2,
    status: 'approved',
  },
]

const EMPTY_RESULTS: ElectionResults = {
  election_id: ELECTION.id,
  status: 'open',
  effective_status: 'open',
  server_now: '2026-09-27T00:00:00.000Z',
  visible: false,
  hidden_reason: 'Voting is still open.',
  total_votes: 0,
  eligible_count: 0,
  turnout: 0,
  rows: [] as TallyRow[],
  winner: null,
  certified_at: null,
}

function ballotResult(overrides: Partial<VoterBallotResult> = {}): VoterBallotResult {
  return {
    election: ELECTION,
    options: CANDIDATES,
    rules: ELECTION.rules,
    eligibility: ELECTION.eligibility,
    has_voted: false,
    can_vote: true,
    credential: { expires_at: '2026-09-27T00:10:00.000Z' },
    results: EMPTY_RESULTS,
    ...overrides,
  }
}

/** Select the election and continue past its ballot preview. */
async function openElection(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByText(ELECTION.title))
  expect(await screen.findByRole('heading', { name: 'Description' })).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Continue to verification' }))
}

beforeEach(() => {
  mockedBallot.mockReset()
  mockedVote.mockReset()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('resuming a verified session', () => {
  /**
   * The regression. A voter whose session is still valid and who has already voted
   * must be told so, and told why they cannot see what they chose. Before the fix
   * this rendered an empty main region.
   */
  it('shows the already-voted screen when the session reports has_voted', async () => {
    mockedBallot.mockResolvedValue({
      ok: true,
      value: ballotResult({ has_voted: true, can_vote: false, credential: null }),
    })
    const user = userEvent.setup()
    render(<VoterFlow elections={[ELECTION]} serverOffsetMs={0} onChanged={() => {}} />)

    await openElection(user)

    expect(await screen.findByText('You have already voted')).toBeInTheDocument()
    // And it must say the useful thing: the ballot exists, and it is not retrievable.
    expect(
      screen.getByText(/not stored against your identity/i),
    ).toBeInTheDocument()
    // Never the fresh-submit screen, which would imply a receipt this page never got.
    expect(screen.queryByText('Vote recorded')).not.toBeInTheDocument()
  })

  it('does not fall back to the identity prompt for a verified voter', async () => {
    mockedBallot.mockResolvedValue({
      ok: true,
      value: ballotResult({ has_voted: true, can_vote: false, credential: null }),
    })
    const user = userEvent.setup()
    render(<VoterFlow elections={[ELECTION]} serverOffsetMs={0} onChanged={() => {}} />)

    await openElection(user)

    await screen.findByText('You have already voted')
    expect(screen.queryByText('Cast your ballot securely.')).not.toBeInTheDocument()
  })

  it('shows the ballot to a verified voter who has not yet voted', async () => {
    mockedBallot.mockResolvedValue({ ok: true, value: ballotResult() })
    const user = userEvent.setup()
    render(<VoterFlow elections={[ELECTION]} serverOffsetMs={0} onChanged={() => {}} />)

    await openElection(user)

    expect(await screen.findByText('Ada Okonkwo')).toBeInTheDocument()
    expect(screen.queryByText('Cast your ballot securely.')).not.toBeInTheDocument()
  })

  it('prompts an unverified visitor for their identifier', async () => {
    mockedBallot.mockResolvedValue({ ok: false, code: 'unauthorized', error: 'Not signed in.' })
    const user = userEvent.setup()
    render(<VoterFlow elections={[ELECTION]} serverOffsetMs={0} onChanged={() => {}} />)

    await openElection(user)

    expect(await screen.findByText('Cast your ballot securely.')).toBeInTheDocument()
    expect(screen.getByLabelText('Student ID')).toBeInTheDocument()
  })
})

describe('casting a vote in this session', () => {
  /**
   * The other half of the contract: 'receipt' now means "just submitted, and here is
   * the payload", and that has to keep working. Without this the fix above would
   * still be correct for resumed sessions but would have quietly cost a voter the
   * only record of their ballot.
   */
  it('shows the receipt with its digest immediately after submitting', async () => {
    mockedBallot.mockResolvedValue({ ok: true, value: ballotResult() })
    const vote: VoterVoteResult = {
      recorded: true,
      receipts: ['BALLOT-RECEIPT-9F2C'],
      submitted_at: '2026-09-27T00:05:00.000Z',
      integrity_digest: 'a'.repeat(64),
      election: ELECTION,
      results: { ...EMPTY_RESULTS, total_votes: 1, eligible_count: 1, turnout: 100 },
    }
    mockedVote.mockResolvedValue({ ok: true, value: vote })
    const user = userEvent.setup()
    render(<VoterFlow elections={[ELECTION]} serverOffsetMs={0} onChanged={() => {}} />)

    await openElection(user)
    await user.click(await screen.findByRole('checkbox', { name: /Ada Okonkwo/ }))
    await user.click(screen.getByRole('button', { name: 'Review and submit' }))
    await user.click(await screen.findByRole('button', { name: 'Submit vote' }))

    expect(await screen.findByText('Your ballot is cast')).toBeInTheDocument()
    expect(screen.getByText('BALLOT-RECEIPT-9F2C')).toBeInTheDocument()
    expect(screen.getByText('Receipt code')).toBeInTheDocument()
  })
})
