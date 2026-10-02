/**
 * Application root.
 *
 * Two surfaces share one server: the voter portal and the administration
 * workspace. The root owns the bootstrap poll, the server clock offset, and the
 * distinction between the two. There is deliberately no offline voting path: the
 * server is the only authority for election state and timing.
 */

import { useCallback, useEffect, useState } from 'react'
import { fetchState, getServerOffset, ServerUnavailableError, type Bootstrap } from './lib/api'
import { ELECTION_TYPE_LABELS } from './lib/types'
import { AdminApp } from './admin/AdminApp'
import { VoterFlow } from './voter/VoterFlow'
import { SiteBar, SiteFoot } from './ui/Shell'
import { Icon } from './ui/Icon'
import { Alert, Spinner } from './ui/primitives'

type Surface = 'voter' | 'admin'

function readSurface(): Surface {
  const hash = window.location.hash.replace('#/', '')
  return hash.startsWith('admin') ? 'admin' : 'voter'
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
      <div className="auth-split">
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

  const live = bootstrap.elections.filter((item) => item.status !== 'archived')

  return (
    <div className="app-shell">
      <SiteBar
        meta={
          <span className="site-bar-meta">
            <Icon name="lock" />
            Secure voter session
            <span className="site-bar-sep">·</span>
            <button type="button" className="site-bar-link" onClick={() => { window.location.hash = '#/admin' }}>
              Exit portal
            </button>
          </span>
        }
      />

      <div className="app-content">
        <VoterFlow elections={bootstrap.elections} serverOffsetMs={serverOffsetMs} onChanged={() => void load()} />
      </div>

      <SiteFoot
        left="Ballot secrecy is structural, not a promise."
        right={
          <>
            Powered by Ballot · Local election workspace
            {live.length > 0 && ` · ${live.map((item) => ELECTION_TYPE_LABELS[item.election_type]).join(' · ')}`}
          </>
        }
      />
    </div>
  )
}
