/**
 * Role-based access control.
 *
 * These tests are about the decisions, not the wiring: who may do what, and
 * which operations are considered consequential enough to need more than a role
 * permission. They exist because a matrix is exactly the kind of thing that
 * drifts quietly — a new permission added to a role by accident, or a critical
 * operation left without elevation.
 */

import { describe, expect, it } from 'vitest'
import { LIFECYCLE_ACTIONS } from './types'
import { isValidTransition } from './lifecycle'
import {
  ADMIN_ROLES,
  LIFECYCLE_PERMISSIONS,
  PERMISSIONS,
  ROLE_DESCRIPTIONS,
  ROLE_LABELS,
  TWO_PERSON_PERMISSIONS,
  elevationFor,
  isAdminRole,
  permissionForLifecycleAction,
  permissionsFor,
  roleHas,
  type AdminRole,
  type Permission,
} from './rbac'

const DECLARED = new Set<string>(PERMISSIONS)

/**
 * Permissions that only read.
 *
 * Listed explicitly rather than pattern-matched, because a pattern like
 * "everything ending in .view" quietly misclassifies `results.view_live` and
 * would let a read permission masquerade as a mutation.
 */
const READ_ONLY: Permission[] = [
  'dashboard.view',
  'election.view',
  'candidate.view',
  'voter.view',
  'voter.view_pii',
  'results.view',
  'results.view_live',
  'results.view_restricted',
  'audit.read',
  'security.read',
  'backup.view',
  'admin.view',
  'settings.view',
]

/** Everything else changes recorded state. */
const MUTATING: Permission[] = PERMISSIONS.filter((permission) => !READ_ONLY.includes(permission))

describe('the read/mutating split is accurate', () => {
  it('covers every declared permission exactly once', () => {
    expect([...READ_ONLY, ...MUTATING].sort()).toEqual([...PERMISSIONS].sort())
  })

  it('leaves no read-only permission unclassified', () => {
    for (const permission of READ_ONLY) {
      expect(MUTATING).not.toContain(permission)
    }
  })
})

describe('role and permission definitions', () => {
  it('names every role and describes it', () => {
    for (const role of ADMIN_ROLES) {
      expect(ROLE_LABELS[role]).toBeTruthy()
      expect(ROLE_DESCRIPTIONS[role].length).toBeGreaterThan(20)
    }
  })

  it('grants only declared permissions', () => {
    for (const role of ADMIN_ROLES) {
      for (const permission of permissionsFor(role)) {
        expect(DECLARED.has(permission), `${role} grants undeclared ${permission}`).toBe(true)
      }
    }
  })

  it('recognises valid roles and rejects others', () => {
    expect(isAdminRole('super_admin')).toBe(true)
    expect(isAdminRole('nonsense')).toBe(false)
    expect(isAdminRole(42)).toBe(false)
  })
})

describe('read-only roles cannot change anything', () => {
  it('gives an observer no mutating permission at all', () => {
    for (const permission of MUTATING) {
      expect(roleHas('observer', permission), `observer must not hold ${permission}`).toBe(false)
    }
  })

  it('gives an auditor no mutating permission at all', () => {
    for (const permission of MUTATING) {
      expect(roleHas('auditor', permission), `auditor must not hold ${permission}`).toBe(false)
    }
  })

  it('keeps an observer out of the audit trail and voter contact details', () => {
    expect(roleHas('observer', 'audit.read')).toBe(false)
    expect(roleHas('observer', 'voter.view_pii')).toBe(false)
    expect(roleHas('observer', 'security.read')).toBe(false)
  })

  it('lets an auditor read the trail and security log but still not write', () => {
    expect(roleHas('auditor', 'audit.read')).toBe(true)
    expect(roleHas('auditor', 'security.read')).toBe(true)
    expect(roleHas('auditor', 'security.manage')).toBe(false)
    expect(roleHas('auditor', 'settings.manage')).toBe(false)
  })
})

describe('privileged roles are separated', () => {
  it('stops an election officer from certifying or administering', () => {
    expect(roleHas('election_officer', 'election.open')).toBe(true)
    expect(roleHas('election_officer', 'election.close')).toBe(true)
    // Certification signs the result off; it is not a day-to-day operation.
    expect(roleHas('election_officer', 'election.certify')).toBe(false)
    expect(roleHas('election_officer', 'admin.manage')).toBe(false)
    expect(roleHas('election_officer', 'system.reset')).toBe(false)
    expect(roleHas('election_officer', 'backup.restore')).toBe(false)
  })

  it('reserves platform administration for the super administrator', () => {
    const restricted: Permission[] = ['admin.manage', 'settings.manage', 'system.reset', 'backup.restore']
    for (const permission of restricted) {
      for (const role of ADMIN_ROLES.filter((item) => item !== 'super_admin')) {
        expect(roleHas(role, permission), `${role} must not hold ${permission}`).toBe(false)
      }
      expect(roleHas('super_admin', permission)).toBe(true)
    }
  })

  it('lets an election administrator run the poll but not touch the platform', () => {
    expect(roleHas('election_admin', 'election.certify')).toBe(true)
    expect(roleHas('election_admin', 'election.create')).toBe(true)
    expect(roleHas('election_admin', 'admin.manage')).toBe(false)
    expect(roleHas('election_admin', 'system.reset')).toBe(false)
  })
})

describe('lifecycle actions map to distinct permissions', () => {
  it('maps every lifecycle action the state machine can perform', () => {
    for (const action of LIFECYCLE_ACTIONS) {
      expect(permissionForLifecycleAction(action), `${action} is unmapped`).toBeTruthy()
    }
  })

  it('maps only declared permissions, plus the reserved reopening authority', () => {
    for (const permission of Object.values(LIFECYCLE_PERMISSIONS)) {
      expect(DECLARED.has(permission), `${permission} is not a declared permission`).toBe(true)
    }
    // `reopen` is not a LifecycleAction: the state machine has no transition out
    // of `closed`. It is mapped anyway so the override already carries the
    // strictest elevation if it is ever enabled.
    const extra = Object.keys(LIFECYCLE_PERMISSIONS).filter((action) => !LIFECYCLE_ACTIONS.includes(action as never))
    expect(extra).toEqual(['reopen'])
    expect(isValidTransition('closed', 'reopen' as never)).toBe(false)
  })

  it('separates opening a poll from closing and certifying it', () => {
    expect(permissionForLifecycleAction('open')).toBe('election.open')
    expect(permissionForLifecycleAction('close')).toBe('election.close')
    expect(permissionForLifecycleAction('certify')).toBe('election.certify')
    expect(permissionForLifecycleAction('reopen')).toBe('election.reopen')
  })

  it('returns null for an unknown action rather than defaulting to something permissive', () => {
    expect(permissionForLifecycleAction('delete_everything')).toBeNull()
    // Inherited members must not be mistaken for registered actions.
    expect(permissionForLifecycleAction('toString')).toBeNull()
    expect(permissionForLifecycleAction('constructor')).toBeNull()
    expect(permissionForLifecycleAction('__proto__')).toBeNull()
    expect(permissionForLifecycleAction('')).toBeNull()
  })
})

describe('elevation for critical operations', () => {
  /**
   * The operations the platform treats as consequential. Each is one an
   * administrator could be socially pressured into, or would want to do by
   * mistake, so none may be a single click.
   */
  const CRITICAL: { permission: Permission; why: string }[] = [
    { permission: 'election.close', why: 'ending voting fixes the tally' },
    { permission: 'election.certify', why: 'certification signs off the official result' },
    { permission: 'election.reopen', why: 'reopening breaks the advertised closing time' },
    { permission: 'election.setRules', why: 'rules changes alter how every ballot counts' },
    { permission: 'backup.restore', why: 'restore discards everything recorded since' },
    { permission: 'system.reset', why: 'reset destroys all platform data' },
    { permission: 'admin.manage', why: 'administrator accounts control everything' },
  ]

  it('demands an extra check for every critical operation', () => {
    for (const { permission, why } of CRITICAL) {
      expect(elevationFor(permission).elevation, `${permission} (${why}) has no elevation`).not.toBe('none')
      expect(elevationFor(permission).reason.length).toBeGreaterThan(20)
    }
  })

  it('requires two people for the operations that destroy data', () => {
    for (const permission of ['backup.restore', 'system.reset', 'admin.manage'] as Permission[]) {
      expect(elevationFor(permission).elevation, `${permission} must need two people`).toBe('two_person')
    }
  })

  it('lists exactly the two-person permissions as approvable', () => {
    for (const permission of TWO_PERSON_PERMISSIONS) {
      expect(elevationFor(permission).elevation).toBe('two_person')
    }
    expect(TWO_PERSON_PERMISSIONS).toContain('system.reset')
    expect(TWO_PERSON_PERMISSIONS).not.toContain('election.close')
  })

  it('leaves ordinary operations unelevated', () => {
    for (const permission of ['election.view', 'candidate.manage', 'voter.import', 'backup.create', 'audit.read'] as Permission[]) {
      expect(elevationFor(permission).elevation).toBe('none')
    }
  })

  it('grants no elevation to a prototype key', () => {
    for (const key of ['toString', 'constructor', '__proto__'] as unknown as Permission[]) {
      expect(elevationFor(key).elevation, `${String(key)} gained elevation`).toBe('none')
    }
  })
})

describe('role summaries', () => {
  it('describes every role in a stable, sorted form', () => {
    for (const role of ADMIN_ROLES as readonly AdminRole[]) {
      const summary = permissionsFor(role).slice().sort()
      expect(summary).toEqual([...summary].sort())
      expect(ROLE_LABELS[role]).toBeTruthy()
    }
  })
})
