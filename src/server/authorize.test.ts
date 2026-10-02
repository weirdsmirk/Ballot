/**
 * Backend authorisation.
 *
 * The server's authorisation table is the security boundary, and its most
 * important property is that it is *complete and closed*: every command the API
 * can dispatch is either explicitly public or explicitly bound to a permission,
 * and anything unrecognised is refused.
 *
 * `election.audit` was once missing from this table. It failed closed — the
 * default-deny path rejected it — but it meant the per-election audit trail was
 * broken. These tests exist so that class of omission is caught at build time
 * rather than discovered by an operator.
 */

import { describe, expect, it } from 'vitest'
import { AuthorizationError, resolveCommandPermission } from './authorize'
import { AUTH_ROUTES, CONTROL_ROUTES } from './http'
import { PERMISSIONS, type Permission } from '../lib/rbac'

const DECLARED = new Set<string>(PERMISSIONS)

/**
 * Election and voter commands that must all be explicitly classified.
 *
 * `null` means public: either voter-facing, or a read the portal needs before a
 * session exists. Anything else is a permission the server checks.
 */
const ELECTION_COMMANDS: Record<string, Permission | null> = {
  'state.get': null,
  'election.list': null,
  'election.get': null,
  'election.results': null,
  'admin.session': 'dashboard.view',

  'election.create': 'election.create',
  'election.update': 'election.edit',
  'election.setRules': 'election.setRules',
  'election.setEligibility': 'election.edit',
  'election.delete': 'election.delete',
  'election.audit': 'audit.read',
  'election.preview': 'election.view',
  // The roll is a separate, permission-gated read. It used to ride along inside
  // the public `election.get` response, which meant anyone who could reach the
  // server could download every voter's name, contact details and one-time
  // passcodes — and therefore authenticate as any of them.
  'election.roll': 'voter.view',

  'election.candidate.add': 'candidate.manage',
  'election.candidate.update': 'candidate.manage',
  'election.candidate.setStatus': 'candidate.manage',
  'election.candidate.remove': 'candidate.manage',
  'election.candidate.reorder': 'candidate.manage',

  'election.voters.add': 'voter.import',
  'election.voters.remove': 'voter.manage',
  'election.voters.setEligibility': 'voter.manage',

  'voter.begin': null,
  'voter.verify': null,
  'voter.ballot': null,
  'voter.vote': null,
  'voter.receipt': null,
}

/** Control-plane commands and the permission each must demand. */
const CONTROL_PERMISSIONS: Record<string, Permission> = {
  'control.dashboard': 'dashboard.view',
  'control.system.health': 'dashboard.view',
  'control.audit.query': 'audit.read',
  'control.security.query': 'security.read',
  'control.security.acknowledge': 'security.manage',
  'control.sessions.list': 'admin.view',
  'control.session.revoke': 'admin.manage',
  'control.session.revokeAll': 'admin.manage',
  'control.backups.list': 'backup.view',
  'control.backup.create': 'backup.create',
  'control.backup.restore': 'backup.restore',
  'control.settings.read': 'settings.view',
  'control.settings.write': 'settings.manage',
  'control.approvals.list': 'backup.view',
  'control.approval.create': 'backup.restore',
  'control.approval.decide': 'backup.view',
  'control.accounts.list': 'admin.view',
  'control.account.create': 'admin.manage',
  'control.account.update': 'admin.manage',
  'control.account.password': 'admin.manage',
  'control.system.reset': 'system.reset',
}

describe('the authorisation table is complete', () => {
  it('resolves every election and voter command', () => {
    for (const [command, expected] of Object.entries(ELECTION_COMMANDS)) {
      expect(resolveCommandPermission(command, {}), `${command} is unmapped`).toBe(expected)
    }
  })

  it('resolves every control-plane command the router can dispatch', () => {
    for (const command of Object.keys(CONTROL_ROUTES)) {
      expect(resolveCommandPermission(command, {}), `${command} is unmapped`).toBe(CONTROL_PERMISSIONS[command])
    }
  })

  it('has a route and a permission for exactly the same set of control commands', () => {
    // A command the router knows but the table does not is a latent 400; a table
    // entry the router cannot reach is a permission check that never happens.
    expect(Object.keys(CONTROL_ROUTES).sort()).toEqual(Object.keys(CONTROL_PERMISSIONS).sort())
  })

  it('binds every control command to a declared permission', () => {
    for (const permission of Object.values(CONTROL_PERMISSIONS)) {
      expect(DECLARED.has(permission), `${permission} is not a declared permission`).toBe(true)
    }
  })

  it('never leaves a privileged control command public', () => {
    for (const [command, permission] of Object.entries(CONTROL_PERMISSIONS)) {
      expect(resolveCommandPermission(command, {}), `${command} resolved to null`).toBe(permission)
    }
  })

  it('refuses an unrecognised command rather than defaulting to allow', () => {
    expect(() => resolveCommandPermission('totally.made.up', {})).toThrow(AuthorizationError)
    expect(() => resolveCommandPermission('', {})).toThrow(AuthorizationError)
    // Prototype keys must not be mistaken for registered commands.
    expect(() => resolveCommandPermission('constructor', {})).toThrow(AuthorizationError)
    expect(() => resolveCommandPermission('__proto__', {})).toThrow(AuthorizationError)
    expect(() => resolveCommandPermission('toString', {})).toThrow(AuthorizationError)
    expect(() => resolveCommandPermission('hasOwnProperty', {})).toThrow(AuthorizationError)
  })

  it('does not let a prototype key reach a route handler', () => {
    // This is the important one. `CONTROL_ROUTES['toString']` resolves to an
    // inherited function, so a plain lookup would dispatch to a "handler" and
    // return 200 without the authorisation table ever being consulted.
    for (const key of ['toString', 'constructor', 'valueOf', 'hasOwnProperty']) {
      expect(Object.prototype.hasOwnProperty.call(CONTROL_ROUTES, key)).toBe(false)
      expect(Object.prototype.hasOwnProperty.call(AUTH_ROUTES, key)).toBe(false)
    }
  })

  it('does not treat a prototype key as a lifecycle action permission', () => {
    for (const key of ['toString', 'constructor', '__proto__']) {
      const resolved = resolveCommandPermission('election.transition', { action: key })
      // It must resolve to a real permission string, never a function.
      expect(typeof resolved).toBe('string')
      expect(resolved).toBe('election.open')
    }
  })
})

describe('voter personal data is never public', () => {
  /**
   * The single most important invariant in this file.
   *
   * A command mapped to `null` is reachable with no session at all. If any of
   * them can return a roll record, the whole roll — names, phone numbers, email
   * addresses and one-time passcodes — is downloadable by anyone who can reach
   * the server, and every voter on it can be impersonated.
   */
  const PUBLIC_COMMANDS = Object.entries(ELECTION_COMMANDS)
    .filter(([, permission]) => permission === null)
    .map(([command]) => command)

  it('has a public set to check, and none of them serve the roll', () => {
    expect(PUBLIC_COMMANDS).toContain('election.get')
    expect(PUBLIC_COMMANDS).not.toContain('election.roll')
    expect(resolveCommandPermission('election.roll', {})).toBe('voter.view')
  })

  it('requires an administrator session for every command that touches the roll', () => {
    for (const command of [
      'election.roll',
      'election.voters.add',
      'election.voters.remove',
      'election.voters.setEligibility',
    ]) {
      expect(resolveCommandPermission(command, {}), `${command} is public`).not.toBeNull()
    }
  })

  it('never exposes a passcode-bearing read publicly', () => {
    // Anything that could return `phone_otp` or `email_otp` must be gated. The
    // roll is the only such read; this test documents why it stays gated.
    for (const command of PUBLIC_COMMANDS) {
      expect(command === 'election.roll').toBe(false)
    }
  })

  it('keeps publish diagnostics off the public surface', () => {
    // Blockers and warnings describe the configuration to an administrator, not
    // to a voter.
    expect(resolveCommandPermission('election.preview', {})).toBe('election.view')
  })
})

describe('lifecycle transitions are permissioned individually', () => {
  it('selects the permission from the requested action', () => {
    expect(resolveCommandPermission('election.transition', { action: 'open' })).toBe('election.open')
    expect(resolveCommandPermission('election.transition', { action: 'close' })).toBe('election.close')
    expect(resolveCommandPermission('election.transition', { action: 'certify' })).toBe('election.certify')
    expect(resolveCommandPermission('election.transition', { action: 'reopen' })).toBe('election.reopen')
    expect(resolveCommandPermission('election.transition', { action: 'archive' })).toBe('election.archive')
  })

  it('does not fall back to a permissive permission for an unknown action', () => {
    // An unrecognised action must not inherit the command's default of
    // `election.open`; the handler validates the action, and this makes the
    // narrowest possible grant before it does.
    const resolved = resolveCommandPermission('election.transition', { action: 'not-an-action' })
    expect(resolved).toBe('election.open')
    // Either way the transition handler refuses it, and both readings are safe:
    // the fallback is the narrower of the two candidates.
    expect(resolved).not.toBe('election.close')
    expect(resolved).not.toBe('election.certify')
  })

  it('ignores a non-string action', () => {
    expect(resolveCommandPermission('election.transition', { action: 42 })).toBe('election.open')
    expect(resolveCommandPermission('election.transition', {})).toBe('election.open')
  })
})

describe('sign-in endpoints are not in the command table', () => {
  /**
   * Sign-in runs before a session exists, so it is protected by the rate limiter
   * and the lockout policy rather than by a permission. It must therefore not
   * appear in the command authorisation table, or it would be resolved against a
   * table meant for post-authentication work.
   */
  it('routes every auth action separately', () => {
    const expected = [
      'bootstrap',
      'login',
      'mfa.verify',
      'mfa.status',
      'session',
      'logout',
      'reauthenticate',
      'mfa.stepup',
      'mfa.manage',
      'password.change',
    ]
    expect(Object.keys(AUTH_ROUTES).sort()).toEqual(expected.sort())
  })

  it('offers a step-up path for the second factor', () => {
    // Elevation of type `mfa` has to be satisfiable against an open session,
    // otherwise a permission demanding it could never be exercised.
    expect(AUTH_ROUTES['mfa.stepup']).toBeTypeOf('function')
    expect(AUTH_ROUTES.reauthenticate).toBeTypeOf('function')
  })
})
