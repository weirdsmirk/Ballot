/**
 * Backups.
 *
 * A backup is the only thing standing between an operator and an unrecoverable
 * mistake, so this screen is built around two questions: how current is the
 * newest archive, and what exactly would restoring this one destroy.
 *
 * Restore is the most dangerous operation on the platform. It is guarded twice:
 * the interface makes the consequence explicit and requires the backup's id to be
 * typed, and the server independently demands two-person approval, verifies the
 * archive's checksum, and snapshots the live database before overwriting it.
 */

import { useCallback, useState } from 'react'
import { controlApi } from '../../../lib/api'
import { roleHas, type AdminRole } from '../../../lib/rbac'
import type { BackupRecord } from '../../../lib/adminTypes'
import { Alert, EmptyState } from '../../../ui/primitives'
import { ConfirmDialog, type ConfirmOptions } from '../ConfirmDialog'
import { DataTable, type Column } from '../DataTable'
import { useElevation } from '../elevation'
import { ControlCard, SectionHeader, formatAge, formatBytes, formatInstant, useControlData } from '../shared'

const KIND_LABELS: Record<BackupRecord['kind'], string> = {
  manual: 'Manual',
  scheduled: 'Scheduled',
  pre_restore: 'Before a restore',
  pre_reset: 'Before a reset',
}

export function BackupsPanel({ role }: { role: AdminRole }) {
  const canCreate = roleHas(role, 'backup.create')
  const canRestore = roleHas(role, 'backup.restore')
  const { run } = useElevation()

  const { data, error, loading, reload } = useControlData(() => controlApi.backups())
  const [label, setLabel] = useState('')
  const [note, setNote] = useState('')
  const [creating, setCreating] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<ConfirmOptions | null>(null)
  const [restoring, setRestoring] = useState<BackupRecord | null>(null)

  const backups = data?.backups ?? []
  const newest = backups[0] ?? null
  const newestAge = newest ? Math.round((Date.now() - Date.parse(newest.created_at)) / 1000) : null
  const stale = newestAge === null || newestAge > 86_400

  const create = useCallback(async () => {
    setActionError(null)
    setCreating(true)
    const outcome = await run({ permission: 'backup.create' }, () =>
      controlApi.createBackup(label.trim() || 'manual', note.trim()),
    )
    setCreating(false)
    if (outcome.status === 'failed') {
      setActionError(outcome.error)
      return
    }
    if (outcome.status === 'cancelled') return
    setNotice(
      `Created ${outcome.value.backup.label} (${formatBytes(outcome.value.backup.size_bytes)}).` +
        (outcome.value.pruned > 0 ? ` Pruned ${outcome.value.pruned} older archive(s) per the retention policy.` : ''),
    )
    setLabel('')
    setNote('')
    reload()
  }, [run, label, note, reload])

  const restore = useCallback(
    async (backup: BackupRecord) => {
      setActionError(null)
      // Dismiss the confirmation before starting the work, so an elevation dialog
      // never opens on top of another one.
      setConfirm(null)
      setRestoring(null)
      const outcome = await run(
        {
          permission: 'backup.restore',
          twoPerson: {
            permission: 'backup.restore',
            action: 'backup.restore',
            resource: `backup:${backup.id}`,
            payloadSummary: `Restore the database from "${backup.label}" taken ${formatInstant(backup.created_at)} (${formatBytes(backup.size_bytes)}). Everything recorded after that moment will be discarded.`,
            justification: '',
          },
        },
        (approvalToken) => controlApi.restoreBackup(backup.id, approvalToken),
      )
      if (outcome.status === 'failed') {
        setActionError(outcome.error)
        return
      }
      if (outcome.status === 'cancelled') return
      setNotice(
        `Database replaced with "${backup.label}". A safety snapshot (#${outcome.value.safetyBackupId}) was taken first. Reload to see the restored state.`,
      )
      reload()
    },
    [run, reload],
  )

  const columns: Column<BackupRecord>[] = [
    {
      key: 'created_at',
      header: 'Taken',
      width: '190px',
      render: (backup) => (
        <div className="cell-stack">
          <span className="data">{formatInstant(backup.created_at).slice(5)}</span>
          <span className="cell-secondary">{formatAge(backup.created_at)}</span>
        </div>
      ),
    },
    {
      key: 'label',
      header: 'Archive',
      render: (backup) => (
        <div className="cell-stack">
          <span className="cell-primary">{backup.label}</span>
          <span className="cell-secondary data">{backup.filename}</span>
        </div>
      ),
    },
    {
      key: 'kind',
      header: 'Kind',
      render: (backup) => <span className="pill">{KIND_LABELS[backup.kind] ?? backup.kind}</span>,
    },
    { key: 'size_bytes', header: 'Size', align: 'right', render: (backup) => formatBytes(backup.size_bytes) },
    {
      key: 'contents',
      header: 'Contains',
      secondary: true,
      sortable: false,
      value: () => '',
      render: (backup) => (
        <span className="cell-secondary">
          {backup.election_count} elections &middot; {backup.vote_count} ballots &middot; {backup.admin_count} admins
        </span>
      ),
    },
    { key: 'created_by_label', header: 'By', secondary: true },
    {
      key: 'note',
      header: 'Note',
      secondary: true,
      render: (backup) => <span className="cell-secondary">{backup.note || '—'}</span>,
    },
    {
      key: 'actions',
      header: 'Actions',
      sortable: false,
      value: () => '',
      render: (backup) =>
        canRestore ? (
          <button
            type="button"
            className="link-button link-danger"
            onClick={() => {
              setRestoring(backup)
              setConfirm({
                title: `Restore from "${backup.label}"?`,
                confirmLabel: 'Restore this backup',
                tone: 'danger',
                requireTyped: String(backup.id),
                body: (
                  <>
                    <p>
                      The live database will be replaced with the archive taken{' '}
                      <strong>{formatInstant(backup.created_at)}</strong>. Everything recorded since then is discarded.
                    </p>
                    <p>
                      <strong>What is lost:</strong> elections created after that point, all ballots cast since, any
                      voter roll changes, administrator accounts added since, and the audit trail entries for all of it.
                    </p>
                    <p>
                      The current database is snapshotted automatically before the overwrite, so this is recoverable if
                      the archive turns out to be the wrong one.
                    </p>
                  </>
                ),
                footnote:
                  'Restoring requires a second administrator to approve it, and the archive is checksum-verified first. Both decisions are recorded permanently.',
              })
            }}
          >
            Restore
          </button>
        ) : (
          <span className="cell-secondary">view only</span>
        ),
    },
  ]

  return (
    <div className="control-body">
      <SectionHeader
        eyebrow="Admin workspace"
        title="Backups"
        description="A byte-for-byte copy of the database, including ballots, rolls, accounts and the audit trail. Archives are held inside the Git-ignored data directory."
        actions={
          canCreate ? (
            <button type="button" className="btn-primary-inline" disabled={creating} onClick={() => void create()}>
              {creating ? 'Creating…' : 'Create backup now'}
            </button>
          ) : (
            <span className="cell-secondary">Your role cannot create archives.</span>
          )
        }
      />

      {notice && <Alert tone="success">{notice}</Alert>}
      {actionError && <Alert tone="error">{actionError}</Alert>}
      {error && <Alert tone="error">{error}</Alert>}

      <div className="kpi-row">
        <div className={`kpi${stale ? ' kpi-warn' : ' kpi-ok'}`}>
          <span className="kpi-label">Newest archive</span>
          <span className="kpi-value">{newest ? formatAge(newest.created_at) : 'none'}</span>
          <span className="kpi-sub">{stale ? 'older than 24 hours' : 'current'}</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Archives held</span>
          <span className="kpi-value">{backups.length}</span>
          <span className="kpi-sub">per the retention setting</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Total on disk</span>
          <span className="kpi-value">{formatBytes(data?.total_size_bytes ?? 0)}</span>
          <span className="kpi-sub">excluding the live database</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Newest contains</span>
          <span className="kpi-value">{newest?.vote_count ?? 0}</span>
          <span className="kpi-sub">ballots at the time</span>
        </div>
      </div>

      {stale && (
        <Alert tone="warn">
          {newest
            ? 'The newest archive is more than a day old. Anything that happens in the meantime is not recoverable.'
            : 'No backup has ever been taken. Nothing on this server can be recovered if it is lost.'}
        </Alert>
      )}

      {canCreate && (
        <ControlCard eyebrow="New archive" title="Take an archive" description="Useful before a risky change: a large roll import, a rules change, or anything else you would want to undo.">
          <div className="inline-form">
            <div className="form-group">
              <label htmlFor="backup-label">Label</label>
              <input
                id="backup-label"
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                placeholder="before-roll-import"
                maxLength={80}
              />
            </div>
            <div className="form-group">
              <label htmlFor="backup-note">Note</label>
              <input
                id="backup-note"
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder="Why this archive was taken"
                maxLength={500}
              />
            </div>
            <button type="button" className="btn-primary-inline" disabled={creating} onClick={() => void create()}>
              {creating ? 'Creating…' : 'Create'}
            </button>
          </div>
        </ControlCard>
      )}

      <ControlCard
        eyebrow="Stored"
        title="Archives"
        description={data?.directory ? `Held in ${data.directory}` : undefined}
      >
        {loading && !data ? (
          <p className="control-loading">Loading archives…</p>
        ) : backups.length === 0 ? (
          <EmptyState title="No archives yet" icon="archive">
            <p>
              Take one before making a significant change. Archives contain voter personal data, so they are stored
              outside version control and never committed.
            </p>
          </EmptyState>
        ) : (
          <DataTable
            columns={columns}
            rows={backups}
            rowKey={(row) => row.id}
            searchPlaceholder="Search by label, file, author or note…"
            searchKeys={['label', 'filename', 'created_by_label', 'note']}
            filters={[
              {
                key: 'kind',
                label: 'Kind',
                match: (row: BackupRecord, value: string) => row.kind === value,
                options: Object.entries(KIND_LABELS).map(([value, label]) => ({ value, label })),
              },
            ]}
            pageSize={25}
            dense
            caption="Database archives"
          />
        )}
      </ControlCard>

      {confirm && (
        <ConfirmDialog
          options={confirm}
          onCancel={() => {
            setConfirm(null)
            setRestoring(null)
          }}
          onConfirm={() => {
            if (restoring) void restore(restoring)
          }}
        />
      )}
    </div>
  )
}
