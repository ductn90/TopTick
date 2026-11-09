import { useEffect, useState } from 'react'
import { t } from '../../shared/i18n'
import type { BarSettings, Language, ScrollSpeed, Settings, ThemeSetting } from '../../shared/types'
import { ChevronDownIcon } from '../icons'
import { Segmented } from './Segmented'
import type { Run } from './Settings'
import styles from './Preferences.module.css'

const THEMES: ThemeSetting[] = ['light', 'dark', 'system']
const SPEEDS: ScrollSpeed[] = ['slow', 'normal', 'fast']
const LANGUAGES: Language[] = ['en', 'vi']

interface PreferencesProps {
  settings: Settings
  run: Run
  lang: Language
}

/** macOS-style grouped form: label on the left, control on the right, hairline separators. */
export function Preferences({ settings, run, lang }: PreferencesProps): React.JSX.Element {
  const { bar } = settings
  // Optimistic copy so controlled inputs do not snap back while the command is in flight.
  const [local, setLocal] = useState(bar)
  useEffect(() => setLocal(bar), [bar])

  const setBar = (partial: Partial<BarSettings>): void => {
    setLocal((prev) => ({ ...prev, ...partial }))
    void run({ type: 'setBar', bar: partial })
  }

  const toggle = (key: 'locked' | 'clickThrough' | 'visible', label: string, testId: string): React.JSX.Element => (
    <label className={styles.row}>
      <span className={styles.label}>{label}</span>
      <input
        type="checkbox"
        role="switch"
        className={styles.switch}
        data-testid={testId}
        checked={local[key]}
        onChange={(e) => setBar({ [key]: e.target.checked })}
      />
    </label>
  )

  return (
    <div className={styles.root}>
      <section className={styles.section} aria-labelledby="prefs-general">
        <h2 className={styles.heading} id="prefs-general">
          {t(lang, 'prefs.section.general')}
        </h2>
        <div className={styles.group}>
          <div className={styles.row}>
            <label className={styles.label} htmlFor="pref-language">
              {t(lang, 'prefs.language')}
            </label>
            <div className={styles.popup}>
              <select
                id="pref-language"
                className={styles.select}
                data-testid="pref-language"
                value={settings.language}
                onChange={(e) => void run({ type: 'setLanguage', lang: e.target.value as Language })}
              >
                {LANGUAGES.map((l) => (
                  <option key={l} value={l}>
                    {t(lang, `language.${l}`)}
                  </option>
                ))}
              </select>
              <ChevronDownIcon size={12} className={styles.popupChevron} />
            </div>
          </div>
          <div className={styles.row}>
            <span className={styles.label}>{t(lang, 'prefs.theme')}</span>
            <Segmented
              label={t(lang, 'prefs.theme')}
              value={settings.theme}
              testId="pref-theme"
              options={THEMES.map((v) => ({ value: v, label: t(lang, `theme.${v}`) }))}
              onChange={(theme) => void run({ type: 'setTheme', theme })}
            />
          </div>
        </div>
      </section>

      <section className={styles.section} aria-labelledby="prefs-bar">
        <h2 className={styles.heading} id="prefs-bar">
          {t(lang, 'prefs.section.bar')}
        </h2>
        <div className={styles.group}>
          <div className={styles.row}>
            <span className={styles.label}>{t(lang, 'prefs.speed')}</span>
            <Segmented
              label={t(lang, 'prefs.speed')}
              value={local.speed}
              testId="pref-speed"
              options={SPEEDS.map((v) => ({ value: v, label: t(lang, `speed.${v}`) }))}
              onChange={(speed) => setBar({ speed })}
            />
          </div>
          {toggle('visible', t(lang, 'prefs.showBar'), 'pref-show-bar')}
          {toggle('locked', t(lang, 'prefs.lock'), 'pref-lock')}
          {toggle('clickThrough', t(lang, 'prefs.clickThrough'), 'pref-click-through')}
        </div>
        <p className={styles.hint}>{t(lang, 'prefs.barHint')}</p>
      </section>
    </div>
  )
}
