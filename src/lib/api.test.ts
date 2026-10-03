/**
 * The client-side record of an open voter session.
 *
 * This exists because of a button that did nothing. The portal header's "Exit
 * portal" set `location.hash = '#/vote'` while already on `#/vote`; assigning a
 * hash to its current value fires no event, so nothing happened and the control
 * looked like a working link.
 *
 * The fix could not simply be "navigate to `#/`". A control labelled "Exit
 * portal" that leaves the voter cookie live is worse than no control at all: the
 * next person at a shared machine lands inside the previous voter's session,
 * which is the exact failure this product exists to prevent. Ending a session
 * takes an election id, because `voter.logout` is scoped to one election — and
 * all the client held was a boolean. So the id is recorded too.
 *
 * These assertions are cheap and pin the part that regresses silently: the id
 * must never outlive the session it belongs to, or a later sign-out would be
 * aimed at an election the voter is no longer in.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { forgetVoterSession, markVoterSession, voterSessionElection } from './api'

describe('the client-side voter session record', () => {
  beforeEach(() => {
    forgetVoterSession()
  })

  it('reports no session before one is opened', () => {
    expect(voterSessionElection()).toBeNull()
  })

  it('records which election the session belongs to', () => {
    markVoterSession(true, 'ORG-2026-PRESIDENT')
    expect(voterSessionElection()).toBe('ORG-2026-PRESIDENT')
  })

  it('reports none once the session is forgotten', () => {
    markVoterSession(true, 'UNI-2026-REPRESENTATIVE')
    forgetVoterSession()
    expect(voterSessionElection()).toBeNull()
  })

  it('does not let a stale id survive a later sign-out', () => {
    // A second voter on the same machine. If `forgetVoterSession` cleared only
    // the boolean and left the id behind, the next "Exit portal" would revoke a
    // session against the previous voter's election.
    markVoterSession(true, 'ORG-2026-PRESIDENT')
    forgetVoterSession()
    markVoterSession(true, 'UNI-2026-REPRESENTATIVE')
    expect(voterSessionElection()).toBe('UNI-2026-REPRESENTATIVE')
  })

  it('withholds the id while no session is open', () => {
    // Marking the session false must clear the id as well, so that even a direct
    // read cannot produce an election to sign out of.
    markVoterSession(true, 'PRIM-2026-DEAN')
    markVoterSession(false)
    expect(voterSessionElection()).toBeNull()
  })
})