/**
 * Application root.
 *
 * Three surfaces share one server: the front door, the voter portal and the
 * administration workspace. The root owns the bootstrap poll, the server clock
 * offset, and the routing between them. There is deliberately no offline voting
 * path: the server is the only authority for election state and timing.
 *
 * `#/` is the front door — the photograph, the argument, and the two ways in.
 * `#/vote` is the voter portal and `#/admin` is the console. The door exists
 * because the two destinations need genuinely different opening moves, one of
 * which is a password: putting a sign-in form in front of everyone would be a
 * form in the way of the thing the product is actually for.
 */

import { useCallback, useEffect, useState } from 'react'
import { fetchState, getServerOffset, ServerUnavailableError, type Bootstrap } from './lib/api'
import { AdminApp } from './admin/AdminApp'
import { AdminLogin } from './admin/AdminLogin'
import { VoterFlow } from './voter/VoterFlow'
import { SiteBar, SiteFoot } from './ui/Shell'
import { Icon } from './ui/Icon'
import { Alert, Spinner } from './ui/primitives'

type Surface = 'start' | 'voter' | 'admin'

function readSurface(): Surface {
  const hash = window.location.hash.replace('#/', '')
  if (hash.startsWith('admin')) return 'admin'
  if (hash.startsWith('vote')) return 'voter'
  // The root, and anything unrecognised, is the front door.
  return 'start'
}

export default function App() {
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null)
  const [surface, setSurface] = useState<Surface>(readSurface)
  const [offline, setOffline] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    try {
      const next = await fetchState()
      setBootstrap(next)
      setOffline(null)
    } catch (error) {
      setOffline(
        error instanceof ServerUnavailableError
          ? error.message
          : 'The election server could not be reached.',
      )
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // Keep the view fresh: lifecycle transitions, pauses and other administrators'
  // actions all need to reach voters without a manual reload.
  useEffect(() => {
    const interval = setInterval(() => void load(), 10_000)
    return () => clearInterval(interval)
  }, [load])

  useEffect(() => {
    const onHash = () => setSurface(readSurface())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  if (loading) return <Spinner label="Connecting to the election server…" />

  if (offline) {
    return (
      <div className="page-shell">
        <SiteBar />
        <div className="page-center">
          <div className="auth-card" style={{ textAlign: 'center' }}>
            <span className="icon-tile icon-tile-lg tile-red" style={{ margin: '0 auto 18px' }}>
              <Icon name="warning" />
            </span>
            <h1>Server unavailable</h1>
            <p className="card-subtitle">{offline}</p>
            <p className="voter-info-note" style={{ marginTop: 18 }}>
              Start the election server, then reload this page:
            </p>
            <pre className="code-block startup-command">npm run dev</pre>
            <Alert tone="warn" >
              Voting is disabled while the server is unreachable. Election timing, eligibility and the one-vote rule are
              all enforced on the server, so there is no safe offline mode for casting ballots.
            </Alert>
            <button type="button" className="btn-primary btn-block btn-lg" onClick={() => void load()}>
              Retry
            </button>
          </div>
        </div>
        <SiteFoot left="No election data is cached in this browser." right="Ballot · local election workspace" />
      </div>
    )
  }

  if (!bootstrap) return <Spinner />

  const serverOffsetMs = getServerOffset()

  /*
   * The front door. It renders the same sign-in component the console does, in
   * its "entry" mode: the photograph and the argument, with the two ways in, and
   * the administrator form swapping into the right-hand half in place rather than
   * by navigating away — so the page the voter chose is still the page behind
   * the form.
   *
   * Signing in hands over to `#/admin`, because that is where the console
   * actually lives and the two must not end up rendering each other.
   */
  if (surface === 'start') {
    return (
      <AdminLogin
        entry
        needsBootstrap={!bootstrap.admins_exist}
        onAuthenticated={() => {
          window.location.hash = '#/admin'
          void load()
        }}
      />
    )
  }

  // The administration console owns the whole page. It is a separate surface with
  // its own navigation and identity strip, and deliberately does not share the
  // voter portal's header or footer: an operator's screen and a voter's screen
  // should not be the same screen.
  if (surface === 'admin') {
    return (
      <AdminApp
        serverOffsetMs={serverOffsetMs}
        needsBootstrap={!bootstrap.admins_exist}
        session={bootstrap.session}
        onSessionChange={() => void load()}
        onChanged={() => void load()}
      />
    )
  }

  return (
    <div className="app-shell">
      <SiteBar
        meta={
          <span className="site-bar-meta">
            <Icon name="lock" />
            Secure voter session
            <span className="site-bar-sep">·</span>
            <button type="button" className="site-bar-link" onClick={() => { window.location.hash = '#/vote' }}>
              Exit portal
            </button>
          </span>
        }
      />

      <div className="app-content">
        <VoterFlow elections={bootstrap.elections} serverOffsetMs={serverOffsetMs} onChanged={() => void load()} />
      </div>

      {/*
        The footer names the product and stops there. It used to enumerate every
        open election type as well, which made the line grow with the workspace
        and told a voter nothing they could act on — the elections are one screen
        above, and they can all be read at a glance.
      */}
      <SiteFoot left="Ballot secrecy is structural, not a promise." right="Local election workspace" />
    </div>
  )
}
