import '@fontsource-variable/inter'
import '../styles/tokens.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Bar } from './Bar'

async function boot(): Promise<void> {
  // Theme and language are set before the first paint, so there is no wrong-theme flash.
  const state = await window.ticker.getState()
  document.documentElement.dataset.theme = state.resolvedTheme
  document.documentElement.lang = state.settings.language
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <Bar initial={state} />
    </StrictMode>
  )
}

void boot()
