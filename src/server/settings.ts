/**
 * Platform settings, stored as a single JSON row so the whole configuration is
 * readable and writable atomically.
 *
 * Settings are deliberately conservative by default. Anything that weakens
 * security, such as revealing voter one-time codes, is off.
 */

import { queryOne, execute, type SqlDatabase } from './db'
import { DEFAULT_SETTINGS, type PlatformSettings } from '../lib/adminTypes'

const KEY = 'platform_settings'

export function readSettings(database: SqlDatabase): PlatformSettings {
  const row = queryOne(database, "SELECT value FROM app_state WHERE key = ?", [KEY])
  const raw = typeof row?.value === 'string' ? row.value : null
  if (!raw) return { ...DEFAULT_SETTINGS }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_SETTINGS }
    return sanitize({ ...DEFAULT_SETTINGS, ...(parsed as Partial<PlatformSettings>) })
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export function writeSettings(database: SqlDatabase, settings: PlatformSettings): PlatformSettings {
  const clean = sanitize(settings)
  execute(database, 'INSERT INTO app_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [
    KEY,
    JSON.stringify(clean),
  ])
  return clean
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(numeric)))
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/** Clamp and validate so a hand-edited row cannot produce unsafe values. */
export function sanitize(input: PlatformSettings): PlatformSettings {
  const visibility = ['live', 'after_close', 'after_certify', 'never']
  return {
    allowAdminCreation: bool(input.allowAdminCreation, DEFAULT_SETTINGS.allowAdminCreation),
    otpTtlSeconds: clampInt(input.otpTtlSeconds, 30, 1800, DEFAULT_SETTINGS.otpTtlSeconds),
    otpMaxAttempts: clampInt(input.otpMaxAttempts, 1, 10, DEFAULT_SETTINGS.otpMaxAttempts),
    otpLockoutSeconds: clampInt(input.otpLockoutSeconds, 30, 3600, DEFAULT_SETTINGS.otpLockoutSeconds),
    otpResendCooldownSeconds: clampInt(input.otpResendCooldownSeconds, 0, 900, DEFAULT_SETTINGS.otpResendCooldownSeconds),
    otpDigits: clampInt(input.otpDigits, 4, 10, DEFAULT_SETTINGS.otpDigits),
    // A floor of two minutes: below that a voter who paused to read the ballot would
    // find their credential expired before they could submit.
    credentialTtlSeconds: clampInt(input.credentialTtlSeconds, 120, 3600, DEFAULT_SETTINGS.credentialTtlSeconds),
    sessionIdleMinutes: clampInt(input.sessionIdleMinutes, 5, 1440, DEFAULT_SETTINGS.sessionIdleMinutes),
    maxLoginAttempts: clampInt(input.maxLoginAttempts, 1, 20, DEFAULT_SETTINGS.maxLoginAttempts),
    lockoutMinutes: clampInt(input.lockoutMinutes, 1, 1440, DEFAULT_SETTINGS.lockoutMinutes),
    rateLimitRequests: clampInt(input.rateLimitRequests, 5, 1000, DEFAULT_SETTINGS.rateLimitRequests),
    rateLimitWindowSeconds: clampInt(input.rateLimitWindowSeconds, 10, 3600, DEFAULT_SETTINGS.rateLimitWindowSeconds),
    requireMfa: bool(input.requireMfa, DEFAULT_SETTINGS.requireMfa),
    backupRetention: clampInt(input.backupRetention, 1, 100, DEFAULT_SETTINGS.backupRetention),
    defaultResultsVisibility: visibility.includes(input.defaultResultsVisibility)
      ? input.defaultResultsVisibility
      : DEFAULT_SETTINGS.defaultResultsVisibility,
    revealDemoPasscodes: bool(input.revealDemoPasscodes, DEFAULT_SETTINGS.revealDemoPasscodes),
    maintenanceMode: bool(input.maintenanceMode, DEFAULT_SETTINGS.maintenanceMode),
  }
}
