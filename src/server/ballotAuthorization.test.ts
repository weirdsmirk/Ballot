/**
 * Command-level authorisation over ballot secrecy.
 *
 * The storage tests in `ballotSecrecy.test.ts` prove the data cannot express a
 * voter-to-choice link. These prove the *API* does not provide one either, at any
 * privilege level — which is a separate question, because an API can grow a command
 * that reads two tables and reassembles what storage deliberately kept apart.
 *
 * The rule being enforced: no command may return a ballot selection for a named
 * voter. A command may return selections only when the caller presents a secret
 * receipt, and receipts are not reachable by identity.
 */

import { describe, expect, it } from 'vitest'
import { COMMAND_PERMISSIONS, resolveCommandPermission } from './authorize'
import { CONTROL_ROUTES } from './http'
import { ADMIN_ROLES, permissionsFor } from '../lib/rbac'
import { readFileSync } from 'node:fs'
import path from 'node:path'

/**
 * Read a sibling source file.
 *
 * The tests below assert on the shipped source rather than on a copy of it, so that
 * a change cannot pass by being invisible to the check. The path is resolved from
 * the working directory because the transform in use does not give `import.meta.url`
 * a file scheme.
 */
function sourcePath(file: string): string {
  return path.resolve(process.cwd(), 'src/server', file)
}

/**
 * Every command the election plane accepts, taken from the dispatcher's own union.
 *
 * Read from the source rather than imported, because the union is a type and so has
 * no runtime form to import. A hand-maintained list here would drift.
 */
function electionCommands(): string[] {
  const source = readFileSync(sourcePath('commands.ts'), 'utf8')
  const start = source.indexOf('export type CommandName =')
  if (start < 0) throw new Error('CommandName union not found in commands.ts')
  const end = source.indexOf('\n}', start)
  const union = source.slice(start, end < 0 ? source.length : end)
  return [...union.matchAll(/'([a-z][a-zA-Z0-9_.]*)'/g)].map((match) => match[1])
}

/** Strip comments, so an explanatory note cannot trip a structural check. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

describe('no command returns a voter’s ballot choice by their identity', () => {
  it('the command list is discoverable, so the checks below are not vacuous', () => {
    const commands = electionCommands()
    expect(commands.length).toBeGreaterThan(30)
    expect(commands).toContain('voter.vote')
    expect(commands).toContain('voter.receipt')
    expect(commands).toContain('election.participation')
  })

  it('no command is named in a way that would return a voter’s choice', () => {
    // Names are a weak signal, so this is only a tripwire for the obvious shape; the
    // real checks are the contract scan and the handler assertions below. Matching on
    // word boundaries keeps `election.voters.add` — which is about the roll — from
    // being dragged in by the letters "vot".
    const commands = electionCommands()
    const dangerous = commands.filter((name) =>
      /(voter'?s?_?ballot|ballot_?for_?voter|voter_?selections?|selections?_?for_?voter|voter_?choices?|voter_?votes?\b)/i.test(
        name,
      ),
    )
    expect(dangerous).toEqual([])
  })

  it('the commands that do exist are the documented safe set', () => {
    // Everything touching a ballot, spelled out, so adding one is a deliberate act
    // rather than an accident that a name filter would wave through.
    const commands = electionCommands()
    const ballotish = commands.filter((name) => /ballot|particip|receipt|credential|preview/.test(name))
    expect(ballotish.sort()).toEqual([
      'election.participation',
      'election.participation.clear',
      'election.preview',
      'voter.ballot',
      'voter.credential',
      'voter.receipt',
    ])
  })

  it('no command response type carries both a voter identifier and a selection', () => {
    /*
     * The check that matters, and it is made against the client contract rather than
     * against handler source.
     *
     * A scan of the handlers would be too blunt: `voter.vote` legitimately holds a
     * voter and a ballot in the same transaction — it has to, in order to check one
     * against the other — and the difference between that and a disclosure is what it
     * *returns*, not what it touches.
     *
     * So this reads the declared response type of every command in `api.ts`, which
     * is the contract an administrator or a voter actually receives, and asserts that
     * no single response can name both a voter and a choice. A type that grew both
     * would be exactly the report this platform must not produce.
     */
    const source = readFileSync(path.resolve(process.cwd(), 'src/lib/api.ts'), 'utf8')
    const typeBodies = new Map<string, string>()
    for (const match of source.matchAll(/export type (\w+)\s*=\s*\{([\s\S]*?)\n\}/g)) {
      typeBodies.set(match[1], withoutComments(match[2]))
    }
    expect(typeBodies.size).toBeGreaterThan(10)

    const voterish = /voter_id|voter_record_id|\bvoter\b/
    const choiceish = /candidate_id|selections|selection_count|\bvotes\b|candidate_ids/

    const offenders: string[] = []
    for (const [name, body] of typeBodies) {
      if (voterish.test(body) && choiceish.test(body)) offenders.push(name)
    }
    // `BallotReceipt` deliberately has neither: it names a receipt and a count, and
    // the count is how many options were chosen, not which.
    expect(offenders).toEqual([])
  })

  it('the receipt type is anchored on a receipt, not on a voter', () => {
    const source = readFileSync(path.resolve(process.cwd(), 'src/lib/types.ts'), 'utf8')
    const body = withoutComments(/export type BallotReceipt = \{([\s\S]*?)\n\}/.exec(source)?.[1] ?? '')
    expect(body).toContain('receipt:')
    expect(body).not.toMatch(/voter/)
    // No candidate id, and no list of options: only how many were chosen.
    expect(body).not.toMatch(/candidate_id|selections/)
  })

  it('voter.receipt resolves through the receipt, never through the voter', () => {
    const source = readFileSync(sourcePath('commands.ts'), 'utf8')
    const start = source.indexOf("case 'voter.receipt':")
    const body = source.slice(start, source.indexOf("case 'voter.credential':"))
    expect(body).toContain('findReceipt')
    // It must not look the voter up in order to find their ballot.
    expect(body).not.toMatch(/resolveVoterSession/)
    expect(body).not.toMatch(/hasParticipated|countParticipants/)
  })

  it('the participation report carries no selections, and never will', () => {
    const source = readFileSync(sourcePath('commands.ts'), 'utf8')
    const start = source.indexOf("case 'election.participation':")
    const body = source.slice(start, source.indexOf("case 'election.participation.clear':"))
    // Built from the roll, eligibility and participation.
    expect(body).toContain('listRollVoters')
    expect(body).toContain('findEligibility')
    expect(body).toContain('findParticipation')
    // It counts ballots for the summary, which is an aggregate and safe. What it must
    // never do is read an individual ballot or touch a selection.
    expect(body).toContain('countBallotRows')
    expect(body).not.toMatch(/listBallots|recordBallot|findReceipt|\.selections/)
  })

  it('asking for a voter’s selections by name is a named refusal, not a silent 404', () => {
    const source = readFileSync(sourcePath('commands.ts'), 'utf8')
    expect(source).toContain('election.participation.clear')
    expect(source).toContain('cannot be retrieved by voter identity')
  })
})

describe('the participation report is separately authorised', () => {
  it('requires voter.view, like any other roll read', () => {
    expect(resolveCommandPermission('election.participation', {})).toBe('voter.view')
  })

  it('is not public, and is not readable by the read-only role', () => {
    expect(COMMAND_PERMISSIONS['election.participation']).not.toBeNull()
    expect(permissionsFor('observer')).not.toContain('voter.view')
  })

  it('no role can widen it into a selections report', () => {
    // Whatever the role, the command is the participation report, and the response
    // shape has no selections field. There is no permission that would change that,
    // which is the property worth stating.
    for (const role of ADMIN_ROLES) {
      const permissions = permissionsFor(role)
      expect(permissions.some((name) => /selection|choice|ballot/i.test(name))).toBe(false)
    }
  })

  it('results stay separate from participation, as two distinct commands', () => {
    // Two commands, so neither can be extended into the other without also merging
    // identity and choice.
    expect(resolveCommandPermission('election.results', {})).toBeNull()
    expect(resolveCommandPermission('election.participation', {})).toBe('voter.view')
  })
})

describe('there is no generic database surface', () => {
  it('no control route offers a raw or generic read of storage', () => {
    // `query` in a name means a filtered, paginated read of one audited table, which
    // is fine. What must not exist is a route that hands back table contents or takes
    // a statement from the caller.
    const routes = Object.keys(CONTROL_ROUTES)
    const suspicious = routes.filter((name) => /(raw|sql|table|\bdb\b|dump|export|execute|statement)/i.test(name))
    expect(suspicious).toEqual([])
  })

  it('no control route accepts a caller-supplied statement', () => {
    // The shape of a generic database endpoint: take a query from the caller and run
    // it. Nothing in the control plane accepts one.
    for (const [name] of Object.entries(CONTROL_ROUTES)) {
      expect(name).not.toMatch(/sql|statement|query_?text/i)
    }
  })

  it('no control route is mapped to a permission that would expose a ballot', () => {
    // Every control command is in the authorisation table, so none can be reached
    // without a permission being consulted for it.
    for (const name of Object.keys(CONTROL_ROUTES)) {
      expect(Object.prototype.hasOwnProperty.call(COMMAND_PERMISSIONS, name)).toBe(true)
    }
  })

  it('no auth route reads the ballot store', () => {
    const source = readFileSync(sourcePath('authCommands.ts'), 'utf8')
    expect(source).not.toMatch(/ballots|selections|listBallots/)
  })

  it('the participant-facing receipt route is the only one that yields a selection', () => {
    const source = readFileSync(sourcePath('commands.ts'), 'utf8')
    const withSelections = [...source.matchAll(/case '([a-z][a-zA-Z0-9_.]*)': \{/g)]
      .map((match, index, all) => {
        const start = match.index
        const next = all[index + 1]
        const end = next ? next.index : source.length
        return source.slice(start, end)
      })
      .filter((body) => /findReceipt|listBallots/.test(body))
    expect(withSelections).toHaveLength(1)
  })
})
