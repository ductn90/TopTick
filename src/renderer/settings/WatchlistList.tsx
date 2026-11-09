import { useState, type FormEvent } from 'react'
import { t } from '../../shared/i18n'
import type { Language, Settings, Watchlist } from '../../shared/types'
import { AddCircleIcon, PenIcon, TrashIcon } from '../icons'
import type { Run } from './Settings'
import styles from './WatchlistList.module.css'

interface WatchlistListProps {
  settings: Settings
  selectedId: string
  onSelect(id: string): void
  run: Run
  lang: Language
}

type Mode = { kind: 'idle' } | { kind: 'rename'; id: string; name: string } | { kind: 'delete'; id: string }

export function WatchlistList({ settings, selectedId, onSelect, run, lang }: WatchlistListProps): React.JSX.Element {
  const [mode, setMode] = useState<Mode>({ kind: 'idle' })
  const [newName, setNewName] = useState('')
  const onlyOne = settings.watchlists.length <= 1

  const create = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    const result = await run({ type: 'createWatchlist', name: newName })
    if (result.ok) {
      setNewName('')
      onSelect(result.settings.watchlists[result.settings.watchlists.length - 1]!.id)
    }
  }

  const rename = async (e: FormEvent, id: string, name: string): Promise<void> => {
    e.preventDefault()
    const result = await run({ type: 'renameWatchlist', id, name })
    if (result.ok) setMode({ kind: 'idle' })
  }

  const remove = async (id: string): Promise<void> => {
    const result = await run({ type: 'deleteWatchlist', id })
    setMode({ kind: 'idle' })
    if (result.ok && id === selectedId) onSelect(result.settings.activeWatchlistId)
  }

  const row = (w: Watchlist): React.JSX.Element => {
    const selected = w.id === selectedId
    const active = w.id === settings.activeWatchlistId
    if (mode.kind === 'rename' && mode.id === w.id) {
      return (
        <form className={styles.inline} onSubmit={(e) => void rename(e, w.id, mode.name)}>
          <input
            className={styles.input}
            data-testid="rename-input"
            aria-label={t(lang, 'settings.watchlists.rename')}
            value={mode.name}
            maxLength={64}
            autoFocus
            onChange={(e) => setMode({ ...mode, name: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setMode({ kind: 'idle' })
            }}
          />
          <div className={styles.actions}>
            <button type="submit" className={styles.small} data-testid="rename-save">
              {t(lang, 'settings.common.save')}
            </button>
            <button type="button" className={styles.small} onClick={() => setMode({ kind: 'idle' })}>
              {t(lang, 'settings.common.cancel')}
            </button>
          </div>
        </form>
      )
    }
    if (mode.kind === 'delete' && mode.id === w.id) {
      return (
        <div className={styles.inline} role="group" aria-label={t(lang, 'settings.watchlists.delete')}>
          <span className={styles.confirm}>{t(lang, 'settings.watchlists.deleteConfirm', { name: w.name })}</span>
          <div className={styles.actions}>
            <button type="button" className={`${styles.small} ${styles.danger}`} data-testid="confirm-delete" onClick={() => void remove(w.id)}>
              {t(lang, 'settings.watchlists.delete')}
            </button>
            <button type="button" className={styles.small} autoFocus onClick={() => setMode({ kind: 'idle' })}>
              {t(lang, 'settings.common.cancel')}
            </button>
          </div>
        </div>
      )
    }
    const renameLabel = t(lang, 'settings.watchlists.renameNamed', { name: w.name })
    const deleteLabel = onlyOne ? t(lang, 'error.LAST_WATCHLIST') : t(lang, 'settings.watchlists.deleteNamed', { name: w.name })
    return (
      <div className={styles.item}>
        <button
          type="button"
          className={styles.select}
          data-testid="select-watchlist"
          aria-current={selected ? 'true' : undefined}
          onClick={() => onSelect(w.id)}
        >
          <span className={styles.name}>{w.name}</span>
          {active && <span className={styles.dot} title={t(lang, 'settings.watchlists.active')} aria-label={t(lang, 'settings.watchlists.active')} />}
        </button>
        {selected && (
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.iconButton}
              data-testid="rename-watchlist"
              aria-label={renameLabel}
              title={renameLabel}
              onClick={() => setMode({ kind: 'rename', id: w.id, name: w.name })}
            >
              <PenIcon size={14} />
            </button>
            <button
              type="button"
              className={`${styles.iconButton} ${styles.dangerIcon}`}
              data-testid="delete-watchlist"
              disabled={onlyOne}
              aria-label={deleteLabel}
              title={deleteLabel}
              onClick={() => setMode({ kind: 'delete', id: w.id })}
            >
              <TrashIcon size={14} />
            </button>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className={styles.root}>
      <ul className={styles.list} data-testid="watchlists">
        {settings.watchlists.map((w) => (
          <li
            key={w.id}
            className={`${styles.row} ${w.id === selectedId ? styles.selected : ''}`}
            data-testid="watchlist-row"
            data-id={w.id}
            data-name={w.name}
          >
            {row(w)}
          </li>
        ))}
      </ul>
      <form className={styles.create} onSubmit={(e) => void create(e)}>
        <input
          className={styles.input}
          data-testid="new-watchlist-input"
          aria-label={t(lang, 'settings.watchlists.new')}
          placeholder={t(lang, 'settings.watchlists.namePlaceholder')}
          value={newName}
          maxLength={64}
          onChange={(e) => setNewName(e.target.value)}
        />
        <button
          type="submit"
          className={styles.iconButton}
          data-testid="create-watchlist"
          aria-label={t(lang, 'settings.watchlists.create')}
          title={t(lang, 'settings.watchlists.create')}
        >
          <AddCircleIcon size={16} />
        </button>
      </form>
    </div>
  )
}
