import { useCallback, useEffect, useState } from 'react'
import { errorMessage, t } from '../../shared/i18n'
import type { AppState, Command, CommandResult, ErrorCode, Settings as SettingsModel } from '../../shared/types'
import { ChecklistIcon, TuningIcon } from '../icons'
import { ItemList } from './ItemList'
import { Preferences } from './Preferences'
import { SymbolSearch } from './SymbolSearch'
import { WatchlistList } from './WatchlistList'
import styles from './Settings.module.css'

export type Run = (cmd: Command, opts?: { quiet?: boolean }) => Promise<CommandResult<SettingsModel>>

type Tab = 'watchlists' | 'preferences'

export function Settings({ initial }: { initial: AppState }): React.JSX.Element {
  const [settings, setSettings] = useState(initial.settings)
  const [tab, setTab] = useState<Tab>('watchlists')
  const [selectedId, setSelectedId] = useState(initial.settings.activeWatchlistId)
  const [error, setError] = useState<ErrorCode | null>(null)
  const lang = settings.language

  useEffect(() => {
    const offSettings = window.ticker.onSettings(setSettings)
    const offTheme = window.ticker.onTheme((theme) => {
      document.documentElement.dataset.theme = theme
    })
    return () => {
      offSettings()
      offTheme()
    }
  }, [])

  useEffect(() => {
    document.documentElement.lang = lang
    document.title = t(lang, 'settings.title')
  }, [lang])

  const run: Run = useCallback(async (cmd, opts) => {
    const result = await window.ticker.command(cmd)
    if (result.ok) {
      setSettings(result.settings)
      setError(null)
    } else if (!opts?.quiet) {
      setError(result.code)
    }
    return result
  }, [])

  const selected = settings.watchlists.find((w) => w.id === selectedId) ?? settings.watchlists[0]!
  const isActive = selected.id === settings.activeWatchlistId

  const tabButton = (id: Tab, label: string, icon: React.JSX.Element): React.JSX.Element => (
    <button
      type="button"
      role="tab"
      id={`tab-${id}`}
      aria-selected={tab === id}
      aria-controls={`panel-${id}`}
      className={styles.tab}
      data-testid={`tab-${id}`}
      onClick={() => {
        setTab(id)
        setError(null)
      }}
    >
      {icon}
      <span>{label}</span>
    </button>
  )

  return (
    <div className={styles.app} data-platform={initial.platform}>
      <header className={styles.toolbar}>
        <div role="tablist" className={styles.tabs} aria-label={t(lang, 'settings.title')}>
          {tabButton('watchlists', t(lang, 'settings.tab.watchlists'), <ChecklistIcon size={20} />)}
          {tabButton('preferences', t(lang, 'settings.tab.preferences'), <TuningIcon size={20} />)}
        </div>
      </header>

      {error && (
        <div className={styles.error} role="alert" data-testid="error">
          {errorMessage(lang, error)}
        </div>
      )}

      {tab === 'watchlists' ? (
        <div className={styles.panes} role="tabpanel" id="panel-watchlists" aria-labelledby="tab-watchlists">
          <aside className={styles.left}>
            <WatchlistList settings={settings} selectedId={selected.id} onSelect={setSelectedId} run={run} lang={lang} />
          </aside>
          <section className={styles.right} aria-label={selected.name}>
            <div className={styles.listHeader}>
              <h2 className={styles.listTitle} data-testid="selected-name">
                {selected.name}
              </h2>
              {isActive ? (
                <span className={styles.activeBadge}>{t(lang, 'settings.watchlists.active')}</span>
              ) : (
                <button
                  type="button"
                  className={styles.primary}
                  data-testid="set-active"
                  onClick={() => void run({ type: 'setActiveWatchlist', id: selected.id })}
                >
                  {t(lang, 'settings.watchlists.showOnBar')}
                </button>
              )}
            </div>
            <SymbolSearch watchlist={selected} run={run} lang={lang} />
            <ItemList watchlist={selected} instruments={settings.instruments} run={run} lang={lang} />
          </section>
        </div>
      ) : (
        <div className={styles.prefs} role="tabpanel" id="panel-preferences" aria-labelledby="tab-preferences">
          <Preferences settings={settings} run={run} lang={lang} />
        </div>
      )}
    </div>
  )
}
