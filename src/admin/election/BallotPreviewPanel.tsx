/**
 * Ballot preview.
 *
 * Renders exactly the options and rules a voter will see, in the order they will
 * see them, alongside a readiness check. This is the screen an administrator
 * uses to confirm a ballot is correct before it is published, so the preview
 * reads from the same server payload the voter receives rather than from a
 * separate client-side projection.
 */

import { electionApi } from '../../lib/api'
import { useEffect, useState } from 'react'
import type { BallotPreview } from '../../lib/types'
import { formatInZone } from '../../lib/time'
import { Alert, Eyebrow, Spinner, StatusBadge, Switch } from '../../ui/primitives'
import { Icon } from '../../ui/Icon'

export function BallotPreviewPanel({ electionId, serverOffsetMs }: { electionId: string; serverOffsetMs: number }) {
  const [preview, setPreview] = useState<BallotPreview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [asVoter, setAsVoter] = useState(false)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      const result = await electionApi.preview(electionId)
      if (cancelled) return
      if (!result.ok) setError(result.error)
      else {
        setPreview(result.value.preview)
        setError(null)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [electionId])

  if (error) return <Alert tone="error">{error}</Alert>
  if (!preview) return <Spinner label="Building ballot preview…" />

  const { election, options, rules, blockers, warnings } = preview

  return (
    <div className="panel">
      <div className="panel-head">
        <div>
          <Eyebrow>Ballot preview</Eyebrow>
          <h2 style={{ marginTop: 9 }}>What a voter will see</h2>
          <p>Read from the same server payload the voter interface receives, in the order they will receive it.</p>
        </div>
        <Switch
          checked={asVoter}
          onChange={setAsVoter}
          label="Show voter framing"
          detail="Wrap the ballot in the voter's own header and card"
        />
      </div>

      {blockers.length > 0 && (
        <Alert tone="error">
          <strong>Cannot publish yet:</strong>
          <ul>
            {blockers.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </Alert>
      )}
      {warnings.length > 0 && (
        <Alert tone="warn">
          <strong>Worth reviewing:</strong>
          <ul>
            {warnings.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </Alert>
      )}
      {blockers.length === 0 && warnings.length === 0 && <Alert tone="success">This ballot is complete and ready to publish.</Alert>}

      <div className="preview-meta">
        <div>
          <span className="preview-meta-label">Status</span>
          <StatusBadge status={election.status} effective={election.effective_status} />
        </div>
        <div>
          <span className="preview-meta-label">Opens</span>
          <span>{formatInZone(election.starts_at, election.timezone)}</span>
        </div>
        <div>
          <span className="preview-meta-label">Closes</span>
          <span>{formatInZone(election.ends_at, election.timezone)}</span>
        </div>
        <div>
          <span className="preview-meta-label">Selections allowed</span>
          <span>{rules.votesPerVoter}</span>
        </div>
        <div>
          <span className="preview-meta-label">Identity check</span>
          <span>{rules.requireOtp ? 'One-time codes' : 'Identifier only'}</span>
        </div>
        <div>
          <span className="preview-meta-label">Eligible voters</span>
          <span>{election.eligible_count}</span>
        </div>
      </div>

      {asVoter && (
        <div className="preview-voter-frame">
          {/* The voter's own frame, not a decoration: an administrator checking a
              ballot should see the card a voter will see, header and all. */}
          <div className="site-bar preview-bar">
            {/* The same inner row the real header uses, so this miniature cannot
                drift from the layout it is a miniature of. */}
            <div className="site-bar-inner">
              {/* Text only, like the real header this miniature copies. A mark here
                  would make the preview show a lockup the voter never sees. */}
              <span className="brand">
                <span className="brand-name">
                  Ballot<span className="brand-dot">.</span>
                </span>
              </span>
              <span className="site-bar-meta">
                <Icon name="lock" />
                Secure voter session
              </span>
            </div>
          </div>
          <div className="preview-voter-body">
            <Eyebrow tone="blue">
              {election.eligibility.identifierLabel || 'Identifier'} required
            </Eyebrow>
            <h3 className="preview-voter-title">{election.title}</h3>
            <p className="preview-voter-lede">
              {rules.votesPerVoter === 1
                ? 'Select one option. You may only cast one vote, and this action cannot be undone.'
                : `Select ${rules.votesPerVoter} options. This action cannot be undone.`}
            </p>
          </div>
        </div>
      )}

      {options.length === 0 ? (
        <Alert tone="info">No options are published on this ballot yet.</Alert>
      ) : (
        <div className="candidate-list preview-list">
          {options.map((option) => (
            <label key={option.key} className={`candidate-row${option.kind !== 'candidate' ? ' special' : ''}`}>
              <span className="radio-circle" aria-hidden="true" />
              <input type={rules.votesPerVoter > 1 ? 'checkbox' : 'radio'} name="preview" readOnly />
              {rules.showCandidateImages && option.image_url && option.kind === 'candidate' && (
                <img className="candidate-photo" src={option.image_url} alt="" />
              )}
              <span className="candidate-info">
                <span className="candidate-name">{option.name}</span>
                {option.organization && <span className="candidate-party">{option.organization}</span>}
                {option.symbol && <span className="candidate-symbol">{option.symbol}</span>}
                {option.description && <span className="candidate-desc">{option.description}</span>}
              </span>
            </label>
          ))}
        </div>
      )}

      <p className="preview-footnote">
        Preview generated at server time {new Date(Date.now() + serverOffsetMs).toISOString().replace('T', ' ').slice(0, 19)} UTC.
        Ballot order is{' '}
        {rules.randomizeBallotOrder ? 'shuffled per voter session' : 'fixed as shown above'}.
      </p>
    </div>
  )
}
