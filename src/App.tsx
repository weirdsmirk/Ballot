/**
 * Application root.
 *
 * Four surfaces share one server: the landing page, the front door, the voter
 * portal and the administration workspace. The root owns the bootstrap poll, the
 * server clock offset, and the routing between them. There is deliberately no
 * offline voting path: the server is the only authority for election state and
 * timing.
 *
 * `#/` is the landing page — the argument, the real figures, and the two ways in.
 * `#/enter` is the front door, and it is a separate surface because those two
 * destinations need genuinely different opening moves, one of which is a
 * password: putting a sign-in form in front of everyone would be a form in the
 * way of the thing the product is actually for.
 *
 * The landing page is allowed to be long, to scroll and to move on its own,
 * because nothing on it stands in front of anybody's vote. The door is not,
 * because the whole job of a door is to be gone.
 */

import { useCallback, useEffect, useState } from 'react'
import {
  fetchState,
  forgetVoterSession,
  getServerOffset,
  ServerUnavailableError,
  voterApi,
  voterSessionElection,
  type Bootstrap,
} from './lib/api'
import { AdminApp } from './admin/AdminApp'
import { AdminLogin } from './admin/AdminLogin'
import { VoterFlow } from './voter/VoterFlow'
import { Landing } from './landing/Landing'
import { SiteBar, SiteFoot } from './ui/Shell'
import { LegalPage, isLegalPage, type LegalPageId } from './ui/LegalPages'
import { Icon } from './ui/Icon'
import { Alert, Spinner } from './ui/primitives'

type Surface = 'landing' | 'start' | 'voter' | 'admin'

/**
 * Which document, if any, this hash points at.
 *
 * Read separately from `readSurface` because a document is not a surface: legal,
 * terms and privacy render in the ordinary page frame and are reachable from
 * anywhere, including while signed in.
 */
function readLegal(): LegalPageId | null {
  return isLegalPage(window.location.hash)
}

function readSurface(): Surface {
  const hash = window.location.hash.replace('#/', '')
  if (hash.startsWith('admin')) return 'admin'
  if (hash.startsWith('vote')) return 'voter'
  if (hash.startsWith('enter')) return 'start'
  // The root, and anything unrecognised, is the landing page.
  return 'landing'
}

/**
 * What the back control on a document should say, and where it should go.
 *
 * It remembers the surface the reader was on, not the last document, because a
 * reader who arrived from the portal wants the portal back and not a sideways
 * step into terms. Two documents read in a row still send you to where you
 * started.
 *
 * Labels are named rather than generic because "back" without a destination is
 * the thing that made this unreadable in the first place.
 */
const BACK_LABEL: Record<Surface, string> = {
  landing: 'Back to Ballot',
  start: 'Back to the front door',
  voter: 'Back to the voter portal',
  admin: 'Back to the console',
}
function surfaceRoute(surface: Surface): string {
  if (surface === 'admin') return '#/admin'
  if (surface === 'voter') return '#/vote'
  if (surface === 'start') return '#/enter'
  return '#/'
}

export default function App() {
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null)
  const [surface, setSurface] = useState<Surface>(readSurface)
  const [legal, setLegal] = useState<LegalPageId | null>(readLegal)
  // The surface a document was opened from, so its back control can name a real
  // destination. Seeded from the current hash so a document opened cold — pasted
  // in a new tab — still has somewhere sensible to go back to.
  const [documentFrom, setDocumentFrom] = useState<Surface>(readSurface)
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
    const onHash = () => {
      const nextSurface = readSurface()
      const nextLegal = readLegal()
      // Leaving a document is not an origin, and neither is arriving on one, so
      // only a real surface updates where the back control points.
      if (!nextLegal) setDocumentFrom(nextSurface)
      setSurface(nextSurface)
      setLegal(nextLegal)
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  /*
   * The three documents render before anything else, including the connection
   * attempt. They are the same text on every machine and they have nothing to do
   * with the database, so a person whose election server is down should still be
   * able to read the privacy notice.
   */
  if (legal) {
    return (
      <LegalPage
        id={legal}
        backTo={surfaceRoute(documentFrom)}
        backLabel={BACK_LABEL[documentFrom]}
      />
    )
  }

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
        <SiteFoot sub="No election data is cached in this browser." />
      </div>
    )
  }

  /*
   * Leave the portal.
   *
   * This control set `location.hash = '#/vote'` while already on `#/vote`, so it
   * did nothing at all — assigning a hash to its current value fires no event and
   * navigates nowhere. It looked like a working link and was not one.
   *
   * What it should do is end the session, not just change the address. A button
   * labelled "Exit portal" that leaves the voter cookie live is worse than no
   * button: the next person at a shared machine lands inside the previous
   * voter's session, which is exactly the failure this product is about. So it
   * revokes on the server first, then navigates to the front door at `#/enter`.
   *
   * The server call is allowed to fail. Someone on a machine with no election
   * server still has to be able to leave the page.
   */
  const exitPortal = async () => {
    const electionId = voterSessionElection()
    if (electionId) {
      try {
        await voterApi.logout(electionId)
      } catch {
        // Nothing to do. The local session is forgotten below either way, and the
        // server treats an absent session as already signed out.
      }
    }
    forgetVoterSession()
    // `#/enter`, the front door — not `#/`. Leaving the portal is an act of
    // finishing with voting, and the landing page is a page to be *read*, which is
    // a strange thing to arrive at mid-session on a shared machine. The front door
    // is the page whose whole job is offering the two ways in, and it is where
    // somebody who has just left the voter portal expects to be able to choose again.
    window.location.hash = '#/enter'
    void load()
  }

  if (!bootstrap) return <Spinner />

  const serverOffsetMs = getServerOffset()

  /*
   * The landing page. The first surface and the only one that is allowed to be
   * long, to scroll and to move on its own.
   */
  if (surface === 'landing') {
    return <Landing />
  }

  /*
   * The front door, on its own. It renders the same sign-in component the console
   * does: the photograph and the argument, the two ways in, and the administrator
   * form swapping into the same page rather than by navigating away — so the page
   * the reader chose is still the page behind the form. This is what a bookmark, a
   * shared link and a refresh land on, which is why the door is a route rather
   * than a state inside the landing page.
   *
   * Signing in hands over to `#/admin`, because that is where the console
   * actually lives and the two must not end up rendering each other.
   */
  if (surface === 'start') {
    return (
      <AdminLogin
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
            <button type="button" className="site-bar-link" onClick={() => void exitPortal()}>
              Exit portal
            </button>
          </span>
        }
      />

      <div className="app-content">
        <VoterFlow elections={bootstrap.elections} serverOffsetMs={serverOffsetMs} onChanged={() => void load()} />
      </div>

      <SiteFoot sub="Ballot secrecy is structural, not a promise." />
    </div>
  )
}
