/**
 * Settings.
 *
 * Platform-wide configuration, grouped by what it affects. The groupings matter
 * more than they look: an operator changing a lockout window is doing something
 * different from one toggling results visibility, and lumping them into one form
 * makes it far too easy to change the wrong thing.
 *
 * Two settings are dangerous enough to be confirmed explicitly rather than
 * saved: revealing voter codes, and requiring a second factor on every
 * account (which can lock everyone out if they have not enrolled).
 *
 * Saving needs two-person approval when it changes security-relevant settings,
 * and the server decides that independently of what this screen shows.
 */

import { useCallback, useState } from 'react'
import { authApi, controlApi } from '../../../lib/api'
import { roleHas, type AdminRole } from '../../../lib/rbac'
import type { MfaSetup, PlatformSettings, SystemHealth } from '../../../lib/adminTypes'
import { RESULTS_VISIBILITIES } from '../../../lib/types'
import { Alert, Field } from '../../../ui/primitives'
import { ConfirmDialog, type ConfirmOptions } from '../ConfirmDialog'
import { useElevation } from '../elevation'
import { ControlCard, SectionHeader, formatBytes, formatUptime, useControlData } from '../shared'

const VISIBILITY_LABELS: Record<string, string> = {
  live: 'Live while voting is open',
  after_close: 'After voting closes',
  after_certify: 'After certification',
  never: 'Never published',
}

/** Settings that change how administrators are protected, and so need approval. */
const SECURITY_KEYS: (keyof PlatformSettings)[] = [
  'requireMfa',
  'sessionIdleMinutes',
  'maxLoginAttempts',
  'lockoutMinutes',
  'rateLimitRequests',
  'rateLimitWindowSeconds',
  'allowAdminCreation',
  'otpTtlSeconds',
  'otpMaxAttempts',
  'otpLockoutSeconds',
  'otpResendCooldownSeconds',
  'otpDigits',
]

export function SettingsPanel({ role, session, onChanged }: {
  role: AdminRole
  session: { admin: { mfa_enabled: boolean } }
  onChanged: () => void
}) {
  const canManage = roleHas(role, 'settings.manage')
  const { run } = useElevation()
  const { data, error, loading, reload } = useControlData(() => controlApi.settings())
  const health = useControlData<{ health: SystemHealth }>(() => controlApi.health())

  const [draft, setDraft] = useState<PlatformSettings | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [confirm, setConfirm] = useState<ConfirmOptions | null>(null)
  const [setup, setSetup] = useState<MfaSetup | null>(null)
  const [mfaCode, setMfaCode] = useState('')
  const [mfaPassword, setMfaPassword] = useState('')

  const settings = draft ?? data?.settings ?? null

  const save = useCallback(
    async (next: PlatformSettings, previous: PlatformSettings) => {
      setActionError(null)
      setSaving(true)
      // Dismiss any confirmation before the elevation dialog opens.
      setConfirm(null)
      const touchesSecurity = SECURITY_KEYS.some((key) => next[key] !== previous[key])
      const outcome = await run(
        {
          permission: 'settings.manage',
          twoPerson: {
            permission: 'settings.manage',
            action: 'settings.write',
            resource: 'settings',
            payloadSummary: describeChanges(previous, next),
            justification: '',
          },
        },
        (approvalToken) => controlApi.writeSettings(next, approvalToken),
      )
      setSaving(false)
      if (outcome.status === 'failed') {
        setActionError(outcome.error)
        return
      }
      if (outcome.status === 'cancelled') return
      setDraft(null)
      setNotice(
        'Settings saved.' +
          (touchesSecurity ? ' The change is recorded with its before and after values in the audit trail.' : ''),
      )
      reload()
      health.reload()
      onChanged()
    },
    [run, reload, health, onChanged],
  )

  const requestSave = useCallback(
    (next: PlatformSettings) => {
      if (!settings) return
      const summary = describeChanges(settings, next)
      const dangerous = next.revealDemoPasscodes !== settings.revealDemoPasscodes
      const locksEveryoneOut = next.requireMfa && !settings.requireMfa
      if (!dangerous && !locksEveryoneOut) {
        void save(next, settings)
        return
      }
      setConfirm({
        title: dangerous ? 'Reveal one-time codes to voters?' : 'Require a second factor on every account?',
        confirmLabel: 'Save settings',
        tone: 'danger',
        requireTyped: dangerous ? 'REVEAL' : 'REQUIRE MFA',
        body: (
          <>
            {dangerous && (
              <p>
                Voter one-time codes will be shown on screen instead of being sent by message. Anyone who can reach
                this server can then complete verification as any voter on the roll. This exists so a local
                demonstration can be completed without an SMS or mail gateway.
              </p>
            )}
            {locksEveryoneOut && (
              <p>
                Every administrator must have a second factor before they can sign in. Accounts without one will be
                refused at sign-in, so enrol a factor on each account first.
              </p>
            )}
            <p className="cell-secondary">Also changing: {summary}</p>
          </>
        ),
        footnote: 'Changing security settings needs a second administrator to approve it. The change is recorded with its previous values.',
      })
    },
    [settings, save],
  )

  const beginMfa = useCallback(async () => {
    setActionError(null)
    const result = await authApi.mfaBegin()
    if (!result.ok) {
      setActionError(result.error)
      return
    }
    setSetup(result.value.setup)
  }, [])

  const confirmMfa = useCallback(async () => {
    setActionError(null)
    const result = await authApi.mfaConfirm(mfaCode)
    if (!result.ok) {
      setActionError(result.error)
      return
    }
    setSetup(null)
    setMfaCode('')
    setNotice('Second factor enabled. It will be demanded at your next sign-in.')
    onChanged()
  }, [mfaCode, onChanged])

  const disableMfa = useCallback(
    async (code: string) => {
      setActionError(null)
      const result = await authApi.mfaDisable(mfaPassword, code)
      setMfaPassword('')
      setMfaCode('')
      if (!result.ok) {
        setActionError(result.error)
        return
      }
      setNotice('Second factor removed from your account.')
      onChanged()
    },
    [mfaPassword, mfaCode, onChanged],
  )

  if (loading && !settings) return <div className="control-body"><p className="control-loading">Loading settings…</p></div>
  if (!settings) return <div className="control-body"><Alert tone="error">{error ?? 'Settings are unavailable.'}</Alert></div>

  const dirty = draft !== null
  const set = <K extends keyof PlatformSettings>(key: K, value: PlatformSettings[K]) =>
    setDraft({ ...settings, [key]: value })
  const number = (key: keyof PlatformSettings, min: number, max: number, hint: string) => (
    <Field label={hint} htmlFor={`s-${String(key)}`}>
      <input
        id={`s-${String(key)}`}
        type="number"
        min={min}
        max={max}
        value={String(settings[key])}
        disabled={!canManage}
        onChange={(event) => set(key, Number(event.target.value) as never)}
      />
    </Field>
  )

  return (
    <div className="control-body">
      <SectionHeader
        eyebrow="Admin workspace"
        title="Settings"
        description="Platform-wide configuration. Every change is recorded in the audit trail with its previous values."
        actions={
          canManage ? (
            <>
              {dirty && (
                <button type="button" className="btn-cancel" onClick={() => setDraft(null)}>
                  Discard changes
                </button>
              )}
              <button
                type="button"
                className="btn-primary-inline"
                disabled={!dirty || saving}
                onClick={() => draft && requestSave(draft)}
              >
                {saving ? 'Saving…' : dirty ? 'Save changes' : 'Saved'}
              </button>
            </>
          ) : (
            <span className="cell-secondary">Your role can read settings but not change them.</span>
          )
        }
      />

      {notice && <Alert tone="success">{notice}</Alert>}
      {actionError && <Alert tone="error">{actionError}</Alert>}
      {error && <Alert tone="error">{error}</Alert>}

      <div className="settings-grid">
        <ControlCard
          eyebrow="Account"
          title="Your account"
          description="A second factor is the strongest protection available, and several critical operations can demand it."
        >
          {session.admin.mfa_enabled ? (
            <>
              <Alert tone="success">A second factor is enabled on your account.</Alert>
              {setup ? (
                <Field label="Authenticator code" htmlFor="mfa-disable-code">
                  <input
                    id="mfa-disable-code"
                    className="mono"
                    value={mfaCode}
                    onChange={(event) => setMfaCode(event.target.value)}
                    placeholder="000000"
                    inputMode="numeric"
                    maxLength={6}
                  />
                </Field>
              ) : null}
              {!setup && (
                <div className="inline-form">
                  <div className="form-group">
                    <label htmlFor="mfa-disable-password">Your password</label>
                    <input
                      id="mfa-disable-password"
                      type="password"
                      autoComplete="current-password"
                      value={mfaPassword}
                      onChange={(event) => setMfaPassword(event.target.value)}
                    />
                  </div>
                  <div className="form-group">
                    <label htmlFor="mfa-disable-code2">Current code</label>
                    <input
                      id="mfa-disable-code2"
                      className="mono"
                      value={mfaCode}
                      onChange={(event) => setMfaCode(event.target.value)}
                      placeholder="000000"
                      inputMode="numeric"
                      maxLength={6}
                    />
                  </div>
                  <button
                    type="button"
                    className="btn-outline"
                    disabled={!mfaPassword || mfaCode.length < 6}
                    onClick={() => void disableMfa(mfaCode)}
                  >
                    Remove second factor
                  </button>
                </div>
              )}
            </>
          ) : (
            <>
              <Alert tone="warn">
                Your account has no second factor. Anyone who obtains your password can sign in as you.
              </Alert>
              {setup ? (
                <MfaEnrolment setup={setup} code={mfaCode} onCode={setMfaCode} onConfirm={() => void confirmMfa()} />
              ) : (
                <button type="button" className="btn-primary-inline" onClick={() => void beginMfa()}>
                  Set up a second factor
                </button>
              )}
            </>
          )}

          <ChangePassword />
        </ControlCard>

        <ControlCard
          eyebrow="Voter verification"
          title="Voter verification codes"
          description="Codes are generated on the server, stored only as a hash, and are single use. These values bound how hard one can be guessed."
        >
          <div className="form-grid">
            {number('otpDigits', 4, 10, 'Code length (digits)')}
            {number('otpTtlSeconds', 30, 1800, 'Code lifetime (seconds)')}
            {number('otpMaxAttempts', 1, 10, 'Wrong guesses allowed')}
            {number('otpLockoutSeconds', 30, 3600, 'Lockout after those guesses (seconds)')}
            {number('otpResendCooldownSeconds', 0, 900, 'Minimum gap between codes (seconds)')}
          </div>
          <p className="field-hint">
            A short numeric code is only as strong as these limits: a stolen database can be brute-forced offline no
            matter how the code is hashed, so the attempt cap and the short lifetime are the real defences. Codes are
            also single use, so a captured one is worthless once spent. Raise the length above six if your delivery
            gateway can carry it.
          </p>
        </ControlCard>

        <ControlCard eyebrow="Access" title="Access control" description="Who can be created, and how long a sign-in may take.">
          <label className="checkbox">
            <input
              type="checkbox"
              checked={settings.allowAdminCreation}
              disabled={!canManage}
              onChange={(event) => set('allowAdminCreation', event.target.checked)}
            />
            Allow administrators to create further accounts
          </label>
          <div className="form-grid">
            {number('sessionIdleMinutes', 5, 1440, 'Session lifetime (minutes)')}
            {number('maxLoginAttempts', 1, 20, 'Sign-in attempts before lockout')}
            {number('lockoutMinutes', 1, 1440, 'Lockout duration (minutes)')}
          </div>
        </ControlCard>

        <ControlCard eyebrow="Access" title="Second factor policy" description="Applies to every administrator account on this platform.">
          <label className="checkbox">
            <input
              type="checkbox"
              checked={settings.requireMfa}
              disabled={!canManage}
              onChange={(event) => set('requireMfa', event.target.checked)}
            />
            Require a second factor for every administrator
          </label>
          {!settings.requireMfa && (
            <p className="field-hint">
              Individual administrators can still enrol a factor from their own account page. Requiring it platform-wide
              refuses sign-in for any account without one.
            </p>
          )}
        </ControlCard>

        <ControlCard eyebrow="Limits" title="Rate limiting" description="Applied per client address to the API as a whole, and more tightly to sign-in.">
          <div className="form-grid">
            {number('rateLimitRequests', 5, 1000, 'Requests per window')}
            {number('rateLimitWindowSeconds', 10, 3600, 'Window length (seconds)')}
          </div>
          <p className="field-hint">
            Sign-in, bootstrap and second-factor attempts use a separate, much smaller budget that is keyed on the
            account as well as the address.
          </p>
        </ControlCard>

        <ControlCard title="Results and voter experience" description="Defaults applied to elections created from now on.">
          <Field label="Default results visibility" htmlFor="s-visibility">
            <select
              id="s-visibility"
              value={settings.defaultResultsVisibility}
              disabled={!canManage}
              onChange={(event) => set('defaultResultsVisibility', event.target.value as PlatformSettings['defaultResultsVisibility'])}
            >
              {RESULTS_VISIBILITIES.map((value) => (
                <option key={value} value={value}>
                  {VISIBILITY_LABELS[value] ?? value}
                </option>
              ))}
            </select>
          </Field>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={settings.maintenanceMode}
              disabled={!canManage}
              onChange={(event) => set('maintenanceMode', event.target.checked)}
            />
            Maintenance mode &mdash; restrict voter access while administration continues
          </label>
        </ControlCard>

        <ControlCard title="Backups" description="How many automatic archives are kept before the oldest is pruned.">
          {number('backupRetention', 1, 100, 'Archives to keep')}
        </ControlCard>

        <ControlCard
          title="Demonstration mode"
          description="Only ever appropriate for a local demonstration."
          tone={settings.revealDemoPasscodes ? 'danger' : 'default'}
        >
          <label className="checkbox">
            <input
              type="checkbox"
              checked={settings.revealDemoPasscodes}
              disabled={!canManage}
              onChange={(event) => set('revealDemoPasscodes', event.target.checked)}
            />
            Show voter one-time codes on screen
          </label>
          <Alert tone="warn">
            With this on, anyone who can reach the server can complete verification as any voter on the roll. Never
            enable it where real voters are involved.
          </Alert>
          <p className="field-hint">
            Turning this off here does not switch disclosure off if the server was started with{' '}
            <code>ELECTION_DEMO_OTP=1</code>, which forces it on for the whole run. System health reports whichever is
            actually in force.
          </p>
        </ControlCard>

        <ControlCard title="System" description="Read-only diagnostics.">
          {health.data ? (
            <div className="mini-stats">
              <div className="mini-stat">
                <span className="mini-stat-value">{health.data.health.status}</span>
                <span className="mini-stat-label">Status</span>
              </div>
              <div className="mini-stat">
                <span className="mini-stat-value">{formatUptime(health.data.health.uptime_seconds)}</span>
                <span className="mini-stat-label">Uptime</span>
              </div>
              <div className="mini-stat">
                <span className="mini-stat-value">{formatBytes(health.data.health.database_size_bytes)}</span>
                <span className="mini-stat-label">Database</span>
              </div>
              <div className="mini-stat">
                <span className="mini-stat-value">v{health.data.health.schema_version}</span>
                <span className="mini-stat-label">Schema</span>
              </div>
              <div className="mini-stat">
                <span className="mini-stat-value">{health.data.health.node_version}</span>
                <span className="mini-stat-label">Runtime</span>
              </div>
            </div>
          ) : (
            <p className="control-muted">{health.loading ? 'Loading…' : (health.error ?? 'Unavailable')}</p>
          )}
          {health.data?.health.issues.length ? (
            <ul className="health-issues">
              {health.data.health.issues.map((issue) => (
                <li key={issue.message} className={`health-issue health-issue-${issue.severity}`}>
                  {issue.message}
                </li>
              ))}
            </ul>
          ) : null}
        </ControlCard>
      </div>

      {confirm && (
        <ConfirmDialog
          options={confirm}
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            if (draft) void save(draft, settings)
          }}
        />
      )}
    </div>
  )
}

/** Show the secret once, and make the operator type it in by hand. */
function MfaEnrolment({
  setup,
  code,
  onCode,
  onConfirm,
}: {
  setup: MfaSetup
  code: string
  onCode: (value: string) => void
  onConfirm: () => void
}) {
  return (
    <div className="mfa-enrol">
      <p className="preview-footnote">
        Add this secret to an authenticator app, then enter the code it shows. The secret is shown only once.
      </p>
      <pre className="code-block">{setup.secret}</pre>
      <details className="mfa-uri">
        <summary>Enrol by URI instead</summary>
        <pre className="code-block">{setup.uri}</pre>
      </details>
      <Field label="Code from your authenticator" htmlFor="mfa-code">
        <input
          id="mfa-code"
          className="mono"
          value={code}
          onChange={(event) => onCode(event.target.value)}
          placeholder="000000"
          inputMode="numeric"
          maxLength={6}
          autoComplete="one-time-code"
        />
      </Field>
      <h4 className="mfa-recovery-title">Recovery codes</h4>
      <p className="field-hint">
        Each is single use. They are the only way back in if the authenticator is lost, and only their hashes are
        stored.
      </p>
      <pre className="code-block">{setup.recovery_codes.join('\n')}</pre>
      <button type="button" className="btn-primary-inline" disabled={code.length < 6} onClick={onConfirm}>
        Confirm and enable
      </button>
    </div>
  )
}

function ChangePassword() {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    const result = await authApi.changePassword(current, next)
    setBusy(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    setCurrent('')
    setNext('')
    setDone(true)
  }

  return (
    <details className="settings-details">
      <summary>Change your password</summary>
      <form onSubmit={submit}>
        {error && <Alert tone="error">{error}</Alert>}
        {done && <Alert tone="success">Password changed. Other sessions stay signed in; you can revoke them under Security.</Alert>}
        <Field label="Current password" htmlFor="pw-current">
          <input
            id="pw-current"
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(event) => setCurrent(event.target.value)}
            required
          />
        </Field>
        <Field
          label="New password"
          htmlFor="pw-new"
          hint="At least 12 characters, using three of: lower case, upper case, digits, symbols."
        >
          <input
            id="pw-new"
            type="password"
            autoComplete="new-password"
            value={next}
            onChange={(event) => setNext(event.target.value)}
            minLength={12}
            required
          />
        </Field>
        <button type="submit" className="btn-primary-inline" disabled={busy}>
          {busy ? 'Changing…' : 'Change password'}
        </button>
      </form>
    </details>
  )
}

/** Plain-language summary of what a settings change actually does. */
function describeChanges(before: PlatformSettings, after: PlatformSettings): string {
  const parts: string[] = []
  if (before.allowAdminCreation !== after.allowAdminCreation) {
    parts.push(after.allowAdminCreation ? 'administrator creation re-enabled' : 'administrator creation disabled')
  }
  if (before.requireMfa !== after.requireMfa) {
    parts.push(after.requireMfa ? 'second factor now required' : 'second factor no longer required')
  }
  if (before.sessionIdleMinutes !== after.sessionIdleMinutes) {
    parts.push(`session lifetime ${after.sessionIdleMinutes} minutes`)
  }
  if (before.maxLoginAttempts !== after.maxLoginAttempts) {
    parts.push(`lockout after ${after.maxLoginAttempts} attempts`)
  }
  if (before.lockoutMinutes !== after.lockoutMinutes) {
    parts.push(`lockout lasts ${after.lockoutMinutes} minutes`)
  }
  if (before.rateLimitRequests !== after.rateLimitRequests || before.rateLimitWindowSeconds !== after.rateLimitWindowSeconds) {
    parts.push(`rate limit ${after.rateLimitRequests} per ${after.rateLimitWindowSeconds}s`)
  }
  if (before.backupRetention !== after.backupRetention) {
    parts.push(`keep ${after.backupRetention} archives`)
  }
  if (before.defaultResultsVisibility !== after.defaultResultsVisibility) {
    parts.push(`default results ${after.defaultResultsVisibility.replace(/_/g, ' ')}`)
  }
  if (before.revealDemoPasscodes !== after.revealDemoPasscodes) {
    parts.push(after.revealDemoPasscodes ? 'codes revealed to voters' : 'codes hidden from voters')
  }
  if (before.maintenanceMode !== after.maintenanceMode) {
    parts.push(after.maintenanceMode ? 'maintenance mode on' : 'maintenance mode off')
  }
  if (before.otpDigits !== after.otpDigits) {
    parts.push(`codes ${after.otpDigits} digits`)
  }
  if (before.otpTtlSeconds !== after.otpTtlSeconds) {
    parts.push(`codes valid ${after.otpTtlSeconds}s`)
  }
  if (before.otpMaxAttempts !== after.otpMaxAttempts) {
    parts.push(`${after.otpMaxAttempts} guesses per code`)
  }
  if (before.otpLockoutSeconds !== after.otpLockoutSeconds) {
    parts.push(`code lockout ${after.otpLockoutSeconds}s`)
  }
  if (before.otpResendCooldownSeconds !== after.otpResendCooldownSeconds) {
    parts.push(`resend cooldown ${after.otpResendCooldownSeconds}s`)
  }
  return parts.length ? parts.join('; ') : 'no effective change'
}
