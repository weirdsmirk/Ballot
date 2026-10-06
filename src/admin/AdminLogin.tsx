/**
 * The front door, and the administrator sign-in behind it.
 *
 * Four states, because the server and the two destinations distinguish them:
 * choosing which way in, creating the first account, submitting a password, and
 * satisfying a second factor.
 *
 * A password alone never opens a session once a second factor is configured. The
 * server returns "a second factor is required" instead of a session, and this
 * screen asks for the code. That is why the MFA step is a separate state rather
 * than an extra field on the form: a hidden field would invite a client to send
 * a password and a code together, which is exactly what must not happen.
 *
 * The chooser comes first on every unauthenticated route, including `#/admin`.
 * It used to be opt-in per route, which meant a bookmarked console link dropped
 * someone straight into a password field with no explanation of what else the
 * product is — a state no visitor had asked for and one they could not back out
 * of. One rule now: signed out, you get the choice.
 */

import { useEffect, useState } from 'react'
import { authApi } from '../lib/api'
import type { ClientSession } from '../lib/adminTypes'
import { Icon } from '../ui/Icon'
import { AuthFrame } from '../ui/Shell'
import { Doorway, DOOR_HERO } from '../ui/Doorway'
import { Alert, DemoNote, Field } from '../ui/primitives'

type Stage = 'choose' | 'password' | 'mfa'

export function AdminLogin({
  needsBootstrap,
  onAuthenticated,
}: {
  needsBootstrap: boolean
  onAuthenticated: (session: ClientSession) => void
}) {
  // A server with no accounts has nothing to sign in *to*, so the chooser's
  // administrator row would lead nowhere. That is the one case that skips it.
  const [stage, setStage] = useState<Stage>(needsBootstrap ? 'password' : 'choose')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [code, setCode] = useState('')
  const [mfaKnown, setMfaKnown] = useState<boolean | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Ask the server whether this account has a second factor, so the form can say
  // so before the password is submitted rather than surprising the operator.
  useEffect(() => {
    if (needsBootstrap || username.trim().length < 3) {
      setMfaKnown(null)
      return
    }
    let cancelled = false
    const timer = setTimeout(() => {
      void authApi.status(username.trim()).then((result) => {
        if (!cancelled && result.ok) setMfaKnown(result.value.mfaEnabled)
      })
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [username, needsBootstrap])

  const submitPassword = async (event: React.FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    // The two calls have deliberately different result shapes: bootstrap always
    // returns a session, whereas sign-in may instead say a second factor is
    // required, and no session exists yet.
    if (needsBootstrap) {
      const created = await authApi.bootstrap({ username, password, display_name: displayName })
      setBusy(false)
      if (!created.ok) {
        setError(created.error)
        return
      }
      onAuthenticated(created.value.session)
      return
    }
    const signedIn = await authApi.login(username, password)
    setBusy(false)
    if (!signedIn.ok) {
      setError(signedIn.error)
      return
    }
    if (signedIn.value.mfaRequired || !signedIn.value.session) {
      setStage('mfa')
      return
    }
    onAuthenticated(signedIn.value.session)
  }

  const submitCode = async (event: React.FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    const result = await authApi.mfaVerify(username.trim(), code)
    setBusy(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    onAuthenticated(result.value.session)
  }

  if (stage === 'choose') {
    /*
      The chooser, from `ui/Doorway`.

      It lives there because it used to have two callers — this, and the second
      screen of a landing page that argued its way down to the same two doors. That
      page is gone, so this is the door and nothing else, and the component is the
      door rather than a thing one chooses between.

      The administrator door swaps the sign-in form into this same half of the
      screen, because navigating would throw away the page the visitor chose and
      there is nothing on the far side worth coming back to.
    */
    return <Doorway onAdmin={() => setStage('password')} />
  }

  if (stage === 'mfa') {
    return (
      <AuthFrame statement={DOOR_HERO.statement} meta={DOOR_HERO.meta}>
        <div className="auth-frame-work">
          <button type="button" className="entry-back" onClick={() => { setStage('password'); setCode(''); setError(null) }}>
            <Icon name="arrow-left" />
            All ways in
          </button>

          <form className="auth-card" onSubmit={submitCode}>
              <div className="auth-card-head">
                <span className="icon-tile tile-green">
                  <Icon name="shield-check" />
                </span>
                <div>
                  <span className="eyebrow">Step 2 of 2</span>
                  <h2>Verify it&rsquo;s you</h2>
                </div>
              </div>
              <p className="card-subtitle">
                Enter the six-digit code from your authenticator app to finish signing in as <strong>{username}</strong>.
              </p>

              {error && (
                <div style={{ marginTop: 16 }}>
                  <Alert tone="error">{error}</Alert>
                </div>
              )}

              <div style={{ marginTop: 20 }}>
                <Field label="Verification code" htmlFor="admin-code">
                  <input
                    id="admin-code"
                    className="data"
                    value={code}
                    onChange={(event) => setCode(event.target.value)}
                    autoComplete="one-time-code"
                    inputMode="numeric"
                    maxLength={12}
                    autoFocus
                    required
                  />
                </Field>
              </div>

              <DemoNote>
                No session is open yet. The code comes from your authenticator app, or from an unused recovery code.
              </DemoNote>

              <button type="submit" className="btn-primary btn-block" disabled={busy} style={{ marginTop: 12 }}>
                {busy ? 'Verifying…' : 'Verify & enter'}
                <Icon name="arrow-right" />
              </button>
              {/*
                No second back link at the foot. The one at the top of this stage
                already goes back, and unlike this one it reaches the chooser as
                well as the password step — so a second control here would be a
                slower route to the same place.
              */}
          </form>
        </div>
      </AuthFrame>
    )
  }

  return (
    <AuthFrame statement={DOOR_HERO.statement} meta={DOOR_HERO.meta}>
      <div className="auth-frame-work">
        {/*
          Always shown. The chooser is the origin of every path into this form, so
          there is always something to go back to — including for someone who
          arrived on a console bookmark, who otherwise has no explanation of what
          the other door was.
        */}
        <button type="button" className="entry-back" onClick={() => { setStage('choose'); setError(null) }}>
          <Icon name="arrow-left" />
          All ways in
        </button>

        <form className="auth-card" onSubmit={submitPassword}>
            <div className="auth-card-head">
              <span className="icon-tile tile-blue">
                <Icon name="lock" />
              </span>
              <div>
                {/*
                  No eyebrow here. The hero directly above already says
                  "Administrator access", and with the card's box gone a second
                  eyebrow a hundred pixels below read as a repetition rather than
                  as a label. The second-factor step keeps its own, because
                  "Step 2 of 2" tells the operator something the hero does not.
                */}
                <h2>{needsBootstrap ? 'Create the first administrator' : 'Administrator sign in'}</h2>
              </div>
            </div>
            <p className="card-subtitle">
              {needsBootstrap
                ? 'This server has no administrator accounts yet. The account you create now will own every election on it.'
                : 'Use your administrator credentials to continue.'}
            </p>

            {error && (
              <div style={{ marginTop: 16 }}>
                <Alert tone="error">{error}</Alert>
              </div>
            )}

            {needsBootstrap && (
              <div style={{ marginTop: 20 }}>
                <Field label="Display name" htmlFor="admin-display">
                  <input
                    id="admin-display"
                    value={displayName}
                    onChange={(event) => setDisplayName(event.target.value)}
                    placeholder="Chief Returning Officer"
                    autoComplete="name"
                  />
                </Field>
              </div>
            )}

            <div style={{ marginTop: needsBootstrap ? 0 : 20 }}>
              <Field
                label="Username"
                htmlFor="admin-username"
                hint={needsBootstrap ? '3–40 characters: letters, numbers, dots, hyphens or underscores.' : undefined}
              >
                <input
                  id="admin-username"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  placeholder="j.chen"
                  autoComplete="username"
                  autoCapitalize="none"
                  spellCheck={false}
                  required
                  minLength={3}
                />
              </Field>
            </div>

            <Field
              label="Password"
              htmlFor="admin-password"
              hint={
                needsBootstrap
                  ? 'At least 12 characters, using three of: lower case, upper case, digits, symbols. Stored as a salted scrypt hash.'
                  : undefined
              }
            >
              <input
                id="admin-password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder={needsBootstrap ? undefined : 'Enter your password'}
                autoComplete={needsBootstrap ? 'new-password' : 'current-password'}
                required
                minLength={needsBootstrap ? 12 : 1}
              />
            </Field>

            {/*
              The role is not chosen here. The first account is always the super
              administrator because it owns a server with no other accounts, and
              every later account is granted its role by whoever created it. A
              control that could not change the outcome would be a promise the
              server does not keep, so the screen states the role instead.
            */}
            <div className="role-readout">
              <span className="eyebrow">Sign in as</span>
              <span className="role-readout-value">
                <Icon name="user" />
                {needsBootstrap ? 'Super Admin' : 'Your assigned role'}
              </span>
              <span className="role-readout-hint">
                {needsBootstrap
                  ? 'The first account on a server owns every election on it.'
                  : 'Granted by whoever created the account. The request cannot raise it.'}
              </span>
            </div>

            <button type="submit" className="btn-primary btn-block btn-lg" disabled={busy}>
              {busy
                ? 'Working…'
                : needsBootstrap
                  ? 'Create account and sign in'
                  : 'Continue securely'}
              {!busy && <Icon name="arrow-right" />}
            </button>

            <div style={{ marginTop: 18 }}>
              <DemoNote>
                {needsBootstrap ? (
                  <>
                    This account becomes a <strong>Super Admin</strong> and will own every election on this server.
                  </>
                ) : (
                  <>
                    Accounts are created by a Super Admin under <strong>Security &rarr; Accounts</strong>. If you have
                    lost your password, they can reset it.
                  </>
                )}
              </DemoNote>
            </div>

            <div className="auth-card-foot">
              <button type="button" className="link-secondary" onClick={() => setError('Password reset is handled by your local election officer.')}>
                Forgot password?
              </button>
            </div>

            {mfaKnown && (
              <p className="voter-info-note" style={{ marginTop: 16, textAlign: 'center' }}>
                This account has a second factor, so you will be asked for a code after your password.
              </p>
            )}
        </form>
      </div>
    </AuthFrame>
  )
}
