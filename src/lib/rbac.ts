/**
 * Role-based access control.
 *
 * This module is the single source of truth for what each administrator role may
 * do. The server enforces it on every command; the admin UI imports the same
 * matrix to decide which controls to render. Hiding a button is a convenience,
 * never the control: every permission here is checked again server side.
 *
 * Elevation is expressed separately from permission. An action may be permitted
 * by role and still require the administrator to prove themselves again
 * (re-authentication or MFA), or require a second administrator to approve.
 */

export const ADMIN_ROLES = [
  'super_admin',
  'election_admin',
  'election_officer',
  'auditor',
  'observer',
] as const
export type AdminRole = (typeof ADMIN_ROLES)[number]

export const ROLE_LABELS: Record<AdminRole, string> = {
  super_admin: 'Super Admin',
  election_admin: 'Election Administrator',
  election_officer: 'Election Officer',
  auditor: 'Auditor',
  observer: 'Read-Only Observer',
}

export const ROLE_DESCRIPTIONS: Record<AdminRole, string> = {
  super_admin:
    'Unrestricted control of the platform, including administrator accounts, backups, system reset, and security settings.',
  election_admin:
    'Creates and configures elections, manages candidates and voter rolls, and runs the full publication lifecycle up to certification.',
  election_officer:
    'Day-to-day operations on an existing election: running the poll, managing candidates, and importing voters. Cannot certify results or alter administrator accounts.',
  auditor:
    'Read-only access to results, the audit trail, and security events. Every administrative action is recorded against them but they can change nothing.',
  observer:
    'Read-only view of election status and published results. No access to voter contact details, the audit trail, or security events.',
}

export const PERMISSIONS = [
  'dashboard.view',
  'election.view',
  'election.create',
  'election.edit',
  'election.schedule',
  'election.setRules',
  'election.open',
  'election.close',
  'election.reopen',
  'election.certify',
  'election.archive',
  'election.delete',
  'candidate.view',
  'candidate.manage',
  'voter.view',
  'voter.view_pii',
  'voter.import',
  'voter.manage',
  'results.view',
  'results.view_live',
  'results.view_restricted',
  'audit.read',
  'security.read',
  'security.manage',
  'backup.view',
  'backup.create',
  'backup.restore',
  'admin.view',
  'admin.manage',
  'settings.view',
  'settings.manage',
  'system.reset',
] as const
export type Permission = (typeof PERMISSIONS)[number]

/**
 * Role to permission matrix.
 *
 * Deliberately explicit rather than derived from a hierarchy, so adding a role
 * cannot silently grant more than intended.
 */
const MATRIX: Record<AdminRole, readonly Permission[]> = {
  super_admin: PERMISSIONS,

  election_admin: [
    'dashboard.view',
    'election.view',
    'election.create',
    'election.edit',
    'election.schedule',
    'election.setRules',
    'election.open',
    'election.close',
    'election.reopen',
    'election.certify',
    'election.archive',
    'election.delete',
    'candidate.view',
    'candidate.manage',
    'voter.view',
    'voter.view_pii',
    'voter.import',
    'voter.manage',
    'results.view',
    'results.view_live',
    'results.view_restricted',
    'audit.read',
    'backup.view',
    'backup.create',
    'admin.view',
    'settings.view',
  ],

  election_officer: [
    'dashboard.view',
    'election.view',
    'election.open',
    'election.close',
    'election.reopen',
    'candidate.view',
    'candidate.manage',
    'voter.view',
    'voter.import',
    'voter.manage',
    'results.view',
    'results.view_live',
    'audit.read',
    'backup.view',
    'admin.view',
    'settings.view',
  ],

  auditor: [
    'dashboard.view',
    'election.view',
    'candidate.view',
    'voter.view',
    'results.view',
    'results.view_live',
    'results.view_restricted',
    'audit.read',
    'security.read',
    'backup.view',
    'admin.view',
    'settings.view',
  ],

  observer: [
    'dashboard.view',
    'election.view',
    'candidate.view',
    'results.view',
  ],
}

const ROLE_PERMISSIONS = new Map<AdminRole, ReadonlySet<Permission>>(
  ADMIN_ROLES.map((role) => [role, new Set(MATRIX[role])]),
)

export function permissionsFor(role: AdminRole): Permission[] {
  return [...(ROLE_PERMISSIONS.get(role) ?? new Set<Permission>())]
}

export function roleHas(role: AdminRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS.get(role)?.has(permission) ?? false
}

export function isAdminRole(value: unknown): value is AdminRole {
  return typeof value === 'string' && (ADMIN_ROLES as readonly string[]).includes(value)
}

/* ------------------------------------------------------------ elevation --- */

export const ELEVATION_STEPS = ['none', 'reauth', 'mfa', 'two_person'] as const
export type ElevationStep = (typeof ELEVATION_STEPS)[number]

export type ElevationRule = {
  /** How the administrator must satisfy themselves before this runs. */
  elevation: ElevationStep
  /** Human readable explanation shown in the confirmation dialog. */
  reason: string
}

/**
 * Operations that need more than a role permission.
 *
 * `reauth` asks for the password again and stays satisfied for a short window.
 * `mfa` requires a fresh second factor. `two_person` requires a different
 * administrator to approve the specific request first.
 */
export const ELEVATION: Partial<Record<Permission, ElevationRule>> = {
  'election.close': {
    elevation: 'reauth',
    reason: 'Closing voting ends the ballot and fixes the tally. Confirm your password to continue.',
  },
  'election.reopen': {
    elevation: 'two_person',
    reason:
      'The state machine does not permit reopening a closed poll. This permission is the reserved authority for that override: if it is ever granted, it will need two administrators as well as a fresh password, because it breaks the advertised closing time.',
  },
  'election.certify': {
    elevation: 'reauth',
    reason: 'Certification signs the result off as the official record and it cannot be undone.',
  },
  'election.delete': {
    elevation: 'reauth',
    reason: 'Deleting an election permanently destroys its configuration.',
  },
  'election.setRules': {
    elevation: 'reauth',
    reason: 'Changing core voting rules alters how every ballot is counted.',
  },
  'backup.restore': {
    elevation: 'two_person',
    reason: 'Restoring a backup discards every change made since it was taken. A second administrator must approve it.',
  },
  'system.reset': {
    elevation: 'two_person',
    reason: 'A system reset destroys all elections, ballots, and voter records. A second administrator must approve it.',
  },
  'admin.manage': {
    elevation: 'two_person',
    reason: 'Administrator accounts control access to everything. A second administrator must approve the change.',
  },
  'security.manage': {
    elevation: 'reauth',
    reason: 'Changing security settings affects how every administrator is protected.',
  },
}

export type { AdminRole as Role }

export function elevationFor(permission: Permission): ElevationRule {
  if (!Object.prototype.hasOwnProperty.call(ELEVATION, permission)) {
    return { elevation: 'none', reason: '' }
  }
  return ELEVATION[permission] ?? { elevation: 'none', reason: '' }
}

/** Permissions that a two-person approval request can carry. */
export const TWO_PERSON_PERMISSIONS: readonly Permission[] = (Object.keys(ELEVATION) as Permission[]).filter(
  (permission) => ELEVATION[permission]?.elevation === 'two_person',
)

/** Capability summary for the settings and account screens. */
export function describeRole(role: AdminRole): {
  role: AdminRole
  label: string
  description: string
  permissions: Permission[]
} {
  return {
    role,
    label: ROLE_LABELS[role],
    description: ROLE_DESCRIPTIONS[role],
    permissions: permissionsFor(role).sort(),
  }
}

/**
 * Lifecycle action to permission.
 *
 * One command drives the whole lifecycle, but opening a poll and certifying a
 * result are different privileges with different elevation, so the action
 * selects the permission. The server enforces through this map and the admin UI
 * reads the same map to decide what to ask for, which is what keeps a "close"
 * button from quietly requiring less than closing really does.
 *
 * `reopen` is listed but is not a `LifecycleAction`: the state machine in
 * `./lifecycle` deliberately has no transition out of `closed`, so a finished
 * poll cannot be reopened. The entry is the reserved authority for that override
 * — mapping it here means that if it is ever enabled it already carries the
 * strictest elevation, rather than inheriting whatever the command's default is.
 */
export const LIFECYCLE_PERMISSIONS: Record<string, Permission> = {
  publish: 'election.edit',
  unpublish: 'election.edit',
  open: 'election.open',
  pause: 'election.open',
  resume: 'election.open',
  close: 'election.close',
  reopen: 'election.reopen',
  certify: 'election.certify',
  archive: 'election.archive',
}

export function permissionForLifecycleAction(action: string): Permission | null {
  // Own-property lookup, so an inherited member such as `toString` is not
  // mistaken for a registered action.
  return Object.prototype.hasOwnProperty.call(LIFECYCLE_PERMISSIONS, action) ? LIFECYCLE_PERMISSIONS[action] : null
}
