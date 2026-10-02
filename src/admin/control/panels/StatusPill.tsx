/**
 * Candidate status badge.
 *
 * Separate from the election `StatusBadge` in the shared primitives: candidate
 * states mean something different, and conflating "disqualified" with "closed"
 * would be misleading on a screen where both appear.
 */

import type { CandidateStatus } from '../../../lib/types'

const LABELS: Record<CandidateStatus, string> = {
  draft: 'Draft',
  approved: 'Approved',
  withdrawn: 'Withdrawn',
  disqualified: 'Disqualified',
}

const HINTS: Record<CandidateStatus, string> = {
  draft: 'Not yet approved for the ballot. Does not appear to voters.',
  approved: 'On the ballot and able to receive votes.',
  withdrawn: 'Withdrew. Any votes already cast are not counted.',
  disqualified: 'Removed from the count by an administrator. The reason is in the audit trail.',
}

export function StatusPill({ status }: { status: CandidateStatus }) {
  return (
    <span className={`pill pill-${status}`} title={HINTS[status]}>
      {LABELS[status]}
    </span>
  )
}

export { LABELS as CANDIDATE_STATUS_LABELS }
