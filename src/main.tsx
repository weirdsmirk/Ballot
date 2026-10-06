import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { boot } from './lib/theme'
import './index.css'

/*
 * The stored theme, applied from the app as well as from the inline script.
 *
 * The inline script in index.html is what actually prevents the flash, because it
 * runs before the document has painted. This call is the belt to its braces: it is
 * what puts the theme back if that script was blocked, if the markup was cached
 * without it, or if a test renders `<App />` into a document that never went through
 * index.html at all. Both call the same `boot()`, so there is one definition of the
 * storage key rather than two that can drift.
 */
boot()

const root = document.getElementById('root')
if (!root) throw new Error('Root element not found')

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
