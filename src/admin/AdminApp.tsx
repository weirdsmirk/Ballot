/**
 * Administrative control centre.
 *
 * The shell: a fixed set of sections, a persistent identity strip, and the
 * workspace for whichever election is open. It is a separate surface from the
 * voter portal and shares nothing with it except the server, because the two
 * have opposite security postures — one is public, the other is the whole
 * platform's control plane.
 *
 * Layout is the reference frame: a dark navigation rail that never scrolls away,
 * a white top bar carrying only the page's identity and the four things an
 * operator can do from anywhere, and a light working area for everything else.
 *
 * Navigation is filtered by the signed-in role so the interface does not offer
 * what the account cannot do. That is a courtesy only. Every command below is
 * authorised again in `src/server/authorize.ts` against the table in
 * `src/lib/rbac.ts`, and a request that the interface would not have offered is
 * refused for exactly the same reason one it did offer would be.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { authApi, electionApi } from '../lib/api'
import { ROLE_LABELS, roleHas, type Permission } from '../lib/rbac'
import type { ClientSession } from '../lib/adminTypes'
import type { ElectionSummary } from '../lib/types'
import { Alert, Spinner } from '../ui/primitives'
import { Icon, initials, type IconName } from '../ui/Icon'
import { Brand } from '../ui/Shell'
import { ElevationProvider, useElevation } from './control/elevation'
import { AdminLogin } from './AdminLogin'
import { ElectionWorkspace } from './election/ElectionWorkspace'
import { AuditLogPanel } from './control/panels/AuditLogPanel'
import { BackupsPanel } from './control/panels/BackupsPanel'
import { CandidatesPanel } from './control/panels/CandidatesPanel'
import { DashboardPanel } from './control/panels/DashboardPanel'
import { DangerPanel } from './control/panels/DangerPanel'
import { ElectionsPanel } from './control/panels/ElectionsPanel'
import { ResultsPanel } from './control/panels/ResultsPanel'
import { SecurityPanel } from './control/panels/SecurityPanel'
import { SettingsPanel } from './control/panels/SettingsPanel'
import { VotersPanel } from './control/panels/VotersPanel'

type SectionId =
  | 'dashboard'
  | 'elections'
  | 'candidates'
  | 'voters'
  | 'results'
  | 'audit'
  | 'security'
  | 'backups'
  | 'settings'
  | 'danger'

type NavItem = {
  id: SectionId
  label: string
  hint: string
  permission: Permission
  group: 'operate' | 'govern' | 'account'
  icon: IconName
  /** Shown as a red count beside the label, e.g. open security alerts. */
  count?: (data: AlertCounts) => number
}

export type AlertCounts = { security: number }

/**
 * The section list.
 *
 * `permission` is what the signed-in role must hold to see the section at all,
 * which is why an observer's console has three entries and a super
 * administrator's has ten.
 */
const NAV: NavItem[] = [
  { id: 'dashboard', label: 'Overview', hint: 'Platform status right now', permission: 'dashboard.view', group: 'operate', icon: 'gauge' },
  { id: 'elections', label: 'Elections', hint: 'Create, schedule, run and certify', permission: 'election.view', group: 'operate', icon: 'flag' },
  { id: 'candidates', label: 'Candidates', hint: 'Ballot options across elections', permission: 'candidate.view', group: 'operate', icon: 'users' },
  { id: 'voters', label: 'Voters', hint: 'Rolls, eligibility and verification', permission: 'voter.view', group: 'operate', icon: 'user' },
  { id: 'results', label: 'Results', hint: 'Tallies and certification state', permission: 'results.view', group: 'operate', icon: 'trend' },
  { id: 'audit', label: 'Audit log', hint: 'Who did what, with outcomes', permission: 'audit.read', group: 'govern', icon: 'audit' },
  { id: 'security', label: 'Security', hint: 'Events, sessions, approvals, accounts', permission: 'security.read', group: 'govern', icon: 'shield' },
  { id: 'backups', label: 'Backups', hint: 'Archives, restore and retention', permission: 'backup.view', group: 'govern', icon: 'archive' },
  { id: 'danger', label: 'Destructive ops', hint: 'Platform reset', permission: 'system.reset', group: 'govern', icon: 'warning' },
  // Rendered in the rail's own "Your account" group rather than in the two groups
  // above, but declared here so role filtering and the active-section lookup stay
  // in one place.
  { id: 'settings', label: 'Settings', hint: 'Platform configuration and your account', permission: 'settings.view', group: 'account', icon: 'cog' },
]

/**
 * The workspace the console is talking to.
 *
 * There is no organisation name in the platform's data model — it is a generic
 * engine that runs any number of elections for any body. Naming a host it does
 * not know about would be a fiction, so the rail names the one thing that is
 * genuinely true and useful: which server these elections live on.
 */
function useWorkspaceLabel(): { name: string; cycle: string } {
  return useMemo(() => {
    const host = window.location.host || 'this server'
    return { name: host, cycle: `${new Date().getFullYear()} cycle` }
  }, [])
}

export function AdminApp({
  serverOffsetMs,
  needsBootstrap,
  session,
  onSessionChange,
  onChanged,
}: {
  serverOffsetMs: number
  needsBootstrap: boolean
  session: ClientSession | null
  onSessionChange: (session: ClientSession | null) => void
  onChanged: () => void
}) {
  if (needsBootstrap || !session) {
    return <AdminLogin needsBootstrap={needsBootstrap} onAuthenticated={onSessionChange} />
  }
  return (
    <ElevationProvider>
      <ControlCentre
        serverOffsetMs={serverOffsetMs}
        session={session}
        onSignOut={() => {
          onSessionChange(null)
          onChanged()
        }}
        onChanged={onChanged}
      />
    </ElevationProvider>
  )
}

function ControlCentre({
  serverOffsetMs,
  session,
  onSignOut,
  onChanged,
}: {
  serverOffsetMs: number
  session: ClientSession
  onSignOut: () => void
  onChanged: () => void
}) {
  const { busy } = useElevation()
  const role = session.admin.role
  const workspace = useWorkspaceLabel()
  const [section, setSection] = useState<SectionId>('dashboard')
  const [elections, setElections] = useState<ElectionSummary[] | null>(null)
  const [workspaceId, setWorkspaceId] = useState<string | null>(null)
  const [focusElectionId, setFocusElectionId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [navOpen, setNavOpen] = useState(false)
  const [countdown, setCountdown] = useState(0)
  const [alerts, setAlerts] = useState<AlertCounts>({ security: 0 })

  const allowed = useMemo(() => NAV.filter((item) => roleHas(role, item.permission)), [role])
  const current = allowed.find((item) => item.id === section) ?? allowed[0]
  const canAccess = useCallback(
    (target: string) => allowed.some((item) => item.id === target),
    [allowed],
  )

  const loadElections = useCallback(async () => {
    const result = await electionApi.list(true)
    if (!result.ok) {
      setError(result.error)
      return
    }
    setElections(result.value.elections)
    setError(null)
  }, [])

  useEffect(() => {
    void loadElections()
  }, [loadElections])
  // Keep the session lifetime visible. A console that silently expires mid-task
  // is worse than one that says how long is left.
  useEffect(() => {
    const tick = () => setCountdown(Math.max(0, Math.round((Date.parse(session.expires_at) - (Date.now() + serverOffsetMs)) / 1000)))
    tick()
    const interval = setInterval(tick, 1000)
    return () => clearInterval(interval)
  }, [session.expires_at, serverOffsetMs])

  const refresh = useCallback(async () => {
    await loadElections()
    onChanged()
  }, [loadElections, onChanged])

  const signOut = async () => {
    await authApi.logout()
    onSignOut()
  }

  const openWorkspace = (electionId: string) => {
    setWorkspaceId(electionId)
    setFocusElectionId(electionId)
  }

  const navigate = (target: string, electionId?: string) => {
    if (electionId) setFocusElectionId(electionId)
    const item = allowed.find((entry) => entry.id === target)
    if (item) setSection(item.id)
    setNavOpen(false)
  }

  // A failed election read must not tear down the console. The shell stays, the
  // error is shown with a way to retry, and the panels keep whatever they had.
  if (workspaceId && elections) {
    return (
      <ElectionWorkspace
        electionId={workspaceId}
        serverOffsetMs={serverOffsetMs}
        onChanged={refresh}
        onBack={() => {
          setWorkspaceId(null)
          void loadElections()
        }}
      />
    )
  }

  const groups: { id: NavItem['group']; label: string }[] = [
    { id: 'operate', label: 'Workspace' },
    { id: 'govern', label: 'Governance' },
  ]

  return (
    <div className="control-shell">
      <a className="skip-link" href="#control-main">
        Skip to content
      </a>

      <nav id="control-nav" className={`control-nav${navOpen ? ' control-nav-open' : ''}`} aria-label="Administration sections">
        <div className="control-brand">
          <Brand onNavigate={() => { window.location.hash = '#/' }} />
        </div>

        <div className="control-workspace" role="button" tabIndex={0}>
          <span className="workspace-avatar" aria-hidden="true">
            {initials(workspace.name)}
          </span>
          <span className="control-workspace-text">
            <span className="control-workspace-name">{workspace.name}</span>
            <span className="control-workspace-sub">Local workspace</span>
          </span>
          <Icon name="chevron-down" />
        </div>

        <div className="control-nav-scroll">
          {groups.map((group) => {
            const items = allowed.filter((item) => item.group === group.id)
            if (items.length === 0) return null
            return (
              <div key={group.id} className="control-nav-group">
                <p className="control-nav-label">{group.label}</p>
                {items.map((item) => {
                  const count = item.count ? item.count(alerts) : 0
                  return (
                    <button
                      key={item.id}
                      type="button"
                      className={`control-nav-item${current?.id === item.id ? ' active' : ''}${
                        item.id === 'danger' ? ' control-nav-danger' : ''
                      }`}
                      aria-current={current?.id === item.id ? 'page' : undefined}
                      onClick={() => navigate(item.id)}
                    >
                      <Icon name={item.icon} />
                      <span className="control-nav-item-label">{item.label}</span>
                      {count > 0 && <span className="control-nav-count">{count}</span>}
                    </button>
                  )
                })}
              </div>
            )
          })}

          <div className="control-nav-group">
            <p className="control-nav-label">Your account</p>
            {allowed
              .filter((item) => item.group === 'account')
              .map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`control-nav-item${current?.id === item.id ? ' active' : ''}`}
                  aria-current={current?.id === item.id ? 'page' : undefined}
                  onClick={() => navigate(item.id)}
                >
                  <Icon name={item.icon} />
                  <span className="control-nav-item-label">{item.label}</span>
                </button>
              ))}
            {/* Signing out belongs with your identity, not among the platform's
                sections, so it appears whether or not Settings is granted. */}
            <button type="button" className="control-nav-item" onClick={() => void signOut()}>
              <Icon name="logout" />
              <span className="control-nav-item-label">Sign out</span>
            </button>
          </div>
        </div>

        <div className="control-nav-foot">
          <div className="control-nav-card">
            <Icon name="lock" />
            <div>
              <strong>Local &amp; secure</strong>
              <span>Data stays on this device</span>
            </div>
          </div>
          <button type="button" className="control-portal" onClick={() => { window.location.hash = '#/vote' }}>
            <Icon name="logout" />
            Open voter portal
            <Icon name="arrow-right" />
          </button>
          <div className="control-user">
            <span className="user-avatar" aria-hidden="true">
              {initials(session.admin.display_name)}
            </span>
            <span className="control-user-text">
              <span className="control-user-name">{session.admin.display_name}</span>
              <span className="control-user-role">{ROLE_LABELS[role]}</span>
              {/* The session lifetime and the second-factor state belong with the
                  identity, not in the top bar: both are facts about this person,
                  not about the page. */}
              <span className="control-user-meta">
                <span className={`control-identity-dot${busy ? ' control-identity-busy' : ''}`} aria-hidden="true" />
                {session.admin.mfa_enabled ? '2FA on' : 'Password only'} · {formatCountdownSeconds(countdown)}
              </span>
            </span>
            <button type="button" onClick={() => void signOut()} title="Sign out" aria-label="Sign out">
              <Icon name="logout" />
            </button>
          </div>
        </div>
      </nav>

      <div className="control-region">
        <header className="control-topbar">
          <button
            type="button"
            className="control-nav-toggle"
            aria-expanded={navOpen}
            aria-controls="control-nav"
            onClick={() => setNavOpen((value) => !value)}
          >
            <Icon name="gauge" />
            {current?.label ?? 'Menu'}
          </button>
          <div className="control-topbar-text">
            <span className="eyebrow">
              {workspace.name} / {workspace.cycle}
            </span>
            <h1 className="control-topbar-title">{current?.label ?? 'Overview'}</h1>
          </div>
          <div className="control-topbar-actions">
            <span className="control-role-pill">
              <Icon name="user" />
              {ROLE_LABELS[role]}
            </span>
            <button type="button" className="btn-icon" aria-label="Search" onClick={() => navigate('elections')}>
              <Icon name="search" />
            </button>
            <button
              type="button"
              className="btn-icon"
              aria-label="Alerts"
              onClick={() => (alerts.security > 0 ? navigate('security') : navigate('audit'))}
            >
              <Icon name="bell" />
              {alerts.security > 0 && (
                <span
                  aria-hidden="true"
                  style={{
                    position: 'absolute',
                    top: 7,
                    right: 8,
                    width: 6,
                    height: 6,
                    borderRadius: 3,
                    background: 'var(--red)',
                  }}
                />
              )}
            </button>
            <button type="button" className="btn-primary" onClick={() => { window.location.hash = '#/vote' }}>
              <Icon name="logout" />
              Voter portal
            </button>
          </div>
        </header>

        <main id="control-main" className="control-main">
          {error && (
            <div className="control-body control-flash">
              <Alert tone="error">
                {error}{' '}
                <button type="button" className="link-button" onClick={() => void loadElections()}>
                  Retry
                </button>
              </Alert>
            </div>
          )}
          {!elections && !error && <Spinner label="Opening the control centre…" />}

          {current?.id === 'dashboard' && (
            <DashboardPanel
              onNavigate={navigate}
              canAccess={canAccess}
              serverOffsetMs={serverOffsetMs}
              onOpenWorkspace={openWorkspace}
              onAlertCounts={setAlerts}
            />
          )}

          {current?.id === 'elections' && (
            <ElectionsPanel
              serverOffsetMs={serverOffsetMs}
              onOpenWorkspace={openWorkspace}
              onChanged={refresh}
            />
          )}

          {/* Sections that read the election list wait for it, so they are only
              mounted once there is something to show. */}
          {elections && current?.id === 'candidates' && (
            <CandidatesPanel
              role={role}
              elections={elections}
              selectedElectionId={focusElectionId}
              onSelectElection={setFocusElectionId}
              onChanged={refresh}
            />
          )}

          {elections && current?.id === 'voters' && (
            <VotersPanel
              role={role}
              elections={elections}
              selectedElectionId={focusElectionId}
              onSelectElection={setFocusElectionId}
              onChanged={refresh}
            />
          )}

          {elections && current?.id === 'results' && (
            <ResultsPanel
              role={role}
              elections={elections}
              selectedElectionId={focusElectionId}
              onSelectElection={setFocusElectionId}
              serverOffsetMs={serverOffsetMs}
            />
          )}

          {elections && current?.id === 'audit' && <AuditLogPanel elections={elections} />}

          {current?.id === 'security' && <SecurityPanel role={role} adminId={session.admin.id} />}

          {current?.id === 'backups' && <BackupsPanel role={role} />}

          {current?.id === 'settings' && <SettingsPanel role={role} session={session} onChanged={refresh} />}

          {current?.id === 'danger' && <DangerPanel role={role} onChanged={refresh} />}
        </main>
      </div>
    </div>
  )
}

/** `12m 30s`, or `expired`. */
function formatCountdownSeconds(seconds: number): string {
  if (seconds <= 0) return 'expired'
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const rest = seconds % 60
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m ${rest}s`
  return `${rest}s`
}
