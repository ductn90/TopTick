import '@fontsource-variable/inter'
import '../styles/tokens.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { t } from '../../shared/i18n'
import { Settings } from './Settings'

async function boot(): Promise<void> {
  // Theme and language are set before the first paint, so there is no wrong-theme flash.
  const state = await window.ticker.getState()
  document.documentElement.dataset.theme = state.resolvedTheme
  document.documentElement.lang = state.settings.language
  document.title = t(state.settings.language, 'settings.title')
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <Settings initial={state} />
    </StrictMode>
  )
}

void boot()
