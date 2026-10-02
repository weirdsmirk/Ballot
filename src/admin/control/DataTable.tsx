/**
 * Searchable, filterable, sortable tables.
 *
 * The administration interface is mostly tables, and an operator's first
 * question about any of them is "where is the thing I want". So the same
 * toolbar, paging and empty state are implemented once here rather than per
 * screen, and each screen only describes its own columns.
 *
 * Two paging modes, because the platform has both kinds of data:
 *
 * - `client`  the server returned the whole set (an election's roll, the
 *             candidate list). Search and paging happen in the browser.
 * - `server`  the endpoint pages and filters itself (the audit trail, the
 *             security log). Search and paging are sent as parameters and the
 *             row count comes from the response.
 *
 * Selecting rows and per-row actions are optional, because a log is read-only
 * and a roll is not.
 */

import { useMemo, useState, type ReactNode } from 'react'
import { Icon } from '../../ui/Icon'
import { EmptyState } from '../../ui/primitives'

export type Column<T> = {
  key: string
  header: ReactNode
  /** Cell body. Defaults to the raw value for that key. */
  render?: (row: T) => ReactNode
  align?: 'left' | 'right'
  width?: string
  /** Value used for sorting and searching. Defaults to the raw value. */
  value?: (row: T) => string | number
  /** Hidden below this width to keep dense tables readable on a laptop. */
  secondary?: boolean
  sortable?: boolean
}

export type FilterDef<T> = {
  key: string
  label: string
  /** Applies when a filter is active. */
  match: (row: T, value: string) => boolean
  options: { value: string; label: string }[]
}

export type SortState = { key: string; direction: 'asc' | 'desc' } | null

export type DataTableProps<T> = {
  columns: Column<T>[]
  rows: T[]
  rowKey: (row: T) => string | number
  /** Shown in the toolbar as the placeholder and used for free-text search. */
  searchPlaceholder?: string
  /** Columns whose values free-text search covers. Defaults to every column. */
  searchKeys?: string[]
  filters?: FilterDef<T>[]
  /** Extra controls rendered on the right of the toolbar. */
  toolbar?: ReactNode
  emptyTitle?: string
  emptyBody?: ReactNode
  pageSize?: number
  /** Enables the row checkbox column. */
  selectable?: boolean
  selected?: number[]
  onSelectedChange?: (ids: number[]) => void
  rowActions?: (row: T) => ReactNode
  /** Highlights a row, e.g. the current selection in a picker. */
  isHighlighted?: (row: T) => boolean
  onRowClick?: (row: T) => void
  /** Renders under the table, e.g. a bulk action bar. */
  footer?: ReactNode
  dense?: boolean
  caption?: string
  /**
   * Present when the endpoint filters and pages itself. Local filtering and
   * paging are then skipped, and toolbar changes are reported upward instead.
   */
  server?: {
    total: number
    page: number
    pageSize: number
    loading?: boolean
    onPageChange: (page: number) => void
    onQueryChange: (query: { search: string; filters: Record<string, string> }) => void
  }
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  searchPlaceholder = 'Search…',
  searchKeys,
  filters = [],
  toolbar,
  emptyTitle = 'Nothing to show',
  emptyBody,
  pageSize = 25,
  selectable = false,
  selected = [],
  onSelectedChange,
  rowActions,
  isHighlighted,
  onRowClick,
  footer,
  dense = false,
  caption,
  server,
}: DataTableProps<T>) {
  const [search, setSearch] = useState('')
  const [active, setActive] = useState<Record<string, string>>({})
  const [sort, setSort] = useState<SortState>(null)
  const [page, setPage] = useState(0)

  const valueOf = (row: T, column: Column<T>): string | number => {
    if (column.value) return column.value(row)
    const raw = (row as Record<string, unknown>)[column.key]
    return raw === null || raw === undefined ? '' : (raw as string | number)
  }

  // In server mode the rows are already filtered, sorted and paged, so the
  // local pass is skipped entirely rather than re-applied to a page of results.
  const local = useMemo(() => {
    const needle = search.trim().toLowerCase()
    const searched = needle
      ? rows.filter((row) => {
          const keys = searchKeys ?? columns.map((column) => column.key)
          return keys.some((key) => {
            const column = columns.find((item) => item.key === key)
            return column ? String(valueOf(row, column)).toLowerCase().includes(needle) : false
          })
        })
      : rows
    const withFilters = Object.entries(active).reduce(
      (accumulator, [key, value]) => {
        const filter = filters.find((item) => item.key === key)
        return filter && value ? accumulator.filter((row) => filter.match(row, value)) : accumulator
      },
      searched,
    )
    if (!sort) return withFilters
    const column = columns.find((item) => item.key === sort.key)
    if (!column) return withFilters
    const direction = sort.direction === 'asc' ? 1 : -1
    return [...withFilters].sort((left, right) => {
      const a = valueOf(left, column)
      const b = valueOf(right, column)
      if (typeof a === 'number' && typeof b === 'number') return (a - b) * direction
      return String(a).localeCompare(String(b), undefined, { numeric: true }) * direction
    })
  }, [rows, search, active, sort, columns, searchKeys, filters])

  const filtered = server ? rows : local
  const total = server ? server.total : local.length
  const size = server ? server.pageSize : pageSize
  const currentPage = server ? server.page : Math.min(page, Math.max(0, Math.ceil(filtered.length / pageSize) - 1))
  const pageCount = Math.max(1, Math.ceil(total / size))
  const visible = server ? filtered : filtered.slice(currentPage * pageSize, currentPage * pageSize + pageSize)

  const reportQuery = (nextSearch: string, nextActive: Record<string, string>) => {
    server?.onQueryChange({ search: nextSearch, filters: nextActive })
  }

  const toggleSort = (key: string) => {
    setSort((current) =>
      current?.key === key ? { key, direction: current.direction === 'asc' ? 'desc' : 'asc' } : { key, direction: 'asc' },
    )
  }

  const changePage = (next: number) => {
    const bounded = Math.max(0, Math.min(pageCount - 1, next))
    if (server) server.onPageChange(bounded)
    else setPage(bounded)
  }

  const toggleRow = (id: number) => {
    onSelectedChange?.(selected.includes(id) ? selected.filter((item) => item !== id) : [...selected, id])
  }

  const allVisibleSelected = visible.length > 0 && visible.every((row) => selected.includes(Number(rowKey(row))))
  const searching = search.trim().length > 0 || Object.values(active).some(Boolean)

  return (
    <div className="table-block">
      {(searchPlaceholder || filters.length > 0 || toolbar) && (
        <div className="table-toolbar">
          {searchPlaceholder && (
            <div className="table-search">
              <Icon name="search" />
              <input
                type="search"
                value={search}
                placeholder={searchPlaceholder}
                aria-label={searchPlaceholder}
                onChange={(event) => {
                  setSearch(event.target.value)
                  if (server) reportQuery(event.target.value, active)
                  else setPage(0)
                }}
              />
            </div>
          )}
          {filters.map((filter) => (
            <label key={filter.key} className="table-filter">
              <span className="sr-only">{filter.label}</span>
              <select
                aria-label={filter.label}
                value={active[filter.key] ?? ''}
                onChange={(event) => {
                  const next = { ...active, [filter.key]: event.target.value }
                  setActive(next)
                  if (server) reportQuery(search, next)
                  else setPage(0)
                }}
              >
                <option value="">{filter.label}: all</option>
                {filter.options.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          ))}
          {toolbar && <div className="table-toolbar-actions">{toolbar}</div>}
        </div>
      )}

      {(searching || server) && (
        <p className="table-count">
          {searching || server ? `${total} matching row${total === 1 ? '' : 's'}` : null}
          {searching && (
            <button
              type="button"
              className="link-button inline"
              onClick={() => {
                setSearch('')
                setActive({})
                if (server) reportQuery('', {})
              }}
            >
              Clear filters
            </button>
          )}
        </p>
      )}

      {filtered.length === 0 ? (
        <EmptyState
          title={rows.length === 0 ? emptyTitle : 'No rows match those filters'}
          icon={rows.length === 0 ? 'search' : 'search'}
          compact
        >
          {rows.length === 0 ? emptyBody : <p>Adjust the search or clear the filters to see the full set again.</p>}
        </EmptyState>
      ) : (
        <div className="table-scroll">
          <table className={`data-table${dense ? ' data-table-dense' : ''}`}>
            {caption && <caption className="sr-only">{caption}</caption>}
            <thead>
              <tr>
                {selectable && (
                  <th className="col-check">
                    <input
                      type="checkbox"
                      checked={allVisibleSelected}
                      aria-label="Select all rows on this page"
                      onChange={() => {
                        const ids = visible.map((row) => Number(rowKey(row)))
                        onSelectedChange?.(
                          allVisibleSelected
                            ? selected.filter((id) => !ids.includes(id))
                            : [...new Set([...selected, ...ids])],
                        )
                      }}
                    />
                  </th>
                )}
                {columns.map((column) => (
                  <th
                    key={column.key}
                    className={[column.align === 'right' ? 'col-num' : '', column.secondary ? 'col-secondary' : '']
                      .filter(Boolean)
                      .join(' ')}
                    style={column.width ? { width: column.width } : undefined}
                    aria-sort={sort?.key === column.key ? (sort.direction === 'asc' ? 'ascending' : 'descending') : undefined}
                  >
                    {column.sortable === false ? (
                      column.header
                    ) : (
                      <button
                        type="button"
                        className="table-sort"
                        onClick={() => toggleSort(column.key)}
                        title={`Sort by ${typeof column.header === 'string' ? column.header : column.key}`}
                      >
                        {column.header}
                        <span className="table-sort-mark" aria-hidden="true">
                          {sort?.key === column.key ? (
                            <Icon name={sort.direction === 'asc' ? 'chevron-down' : 'chevron-down'} />
                          ) : null}
                        </span>
                      </button>
                    )}
                  </th>
                ))}
                {rowActions && <th className="col-actions">Actions</th>}
              </tr>
            </thead>
            <tbody>
              {visible.map((row) => {
                const id = Number(rowKey(row))
                return (
                  <tr
                    key={String(rowKey(row))}
                    className={[
                      isHighlighted?.(row) ? 'row-highlight' : '',
                      onRowClick ? 'row-clickable' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    onClick={onRowClick ? () => onRowClick(row) : undefined}
                  >
                    {selectable && (
                      <td className="col-check" onClick={(event) => event.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={selected.includes(id)}
                          aria-label={`Select row ${rowKey(row)}`}
                          onChange={() => toggleRow(id)}
                        />
                      </td>
                    )}
                    {columns.map((column) => (
                      <td
                        key={column.key}
                        className={[column.align === 'right' ? 'col-num' : '', column.secondary ? 'col-secondary' : '']
                          .filter(Boolean)
                          .join(' ')}
                      >
                        {column.render ? column.render(row) : String(valueOf(row, column) || '—')}
                      </td>
                    ))}
                    {rowActions && (
                      <td className="col-actions" onClick={(event) => event.stopPropagation()}>
                        <div className="row-actions">{rowActions(row)}</div>
                      </td>
                    )}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {footer}
      {pageCount > 1 && (
        <div className="table-pager">
          <span className="table-pager-count">
            {total === 0 ? 0 : currentPage * size + 1}–{Math.min(total, (currentPage + 1) * size)} of {total}
          </span>
          <div className="table-pager-buttons">
            <button type="button" className="btn-outline" disabled={currentPage === 0} onClick={() => changePage(0)}>
              First
            </button>
            <button type="button" className="btn-outline" disabled={currentPage === 0} onClick={() => changePage(currentPage - 1)}>
              Previous
            </button>
            <span className="table-pager-position">
              Page {currentPage + 1} of {pageCount}
            </span>
            <button
              type="button"
              className="btn-outline"
              disabled={currentPage >= pageCount - 1}
              onClick={() => changePage(currentPage + 1)}
            >
              Next
            </button>
            <button
              type="button"
              className="btn-outline"
              disabled={currentPage >= pageCount - 1}
              onClick={() => changePage(pageCount - 1)}
            >
              Last
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
