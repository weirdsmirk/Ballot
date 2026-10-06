/**
 * The theme control.
 *
 * One button, not a menu, and the label does the work a menu's layout would.
 *
 * The alternative is a popover listing System / Light / Dark. It is more discoverable
 * and it is worse here: this product's headers are already dense — the console's
 * carries a role pill, a search button, an alert bell with an unread dot and a sign
 * out — and a control that opens a floating panel is a control that has to be closed,
 * trapped, dismissed on Escape, positioned against the viewport edge, and kept in
 * step with focus. All of that to pick one of three values, when the button can simply
 * say what it is and what pressing it does.
 *
 * So it cycles System → Light → Dark → System, and states both in the accessible
 * name: "Theme: follows your system. Switch to light." A sighted reader gets the
 * icon and the tooltip; a screen-reader reader gets both facts in words, which is the
 * one a cycle control usually loses.
 *
 * The icon shows the theme that pressing it will *arrive at*, not the one in force.
 * That is the opposite of what a status indicator would do, and it is deliberate: the
 * icon on a control is a label for the action, and an icon that describes state
 * instead makes the reader work out what it does. When following the system, the icon
 * is the display rather than a sun or a moon, because "a sun" would claim the system
 * is in light mode, which it may not be.
 *
 * No animation on the change, and this is a considered absence rather than an
 * oversight. Cross-fading fifty-odd rules from one palette to another means putting a
 * `transition` on colour and background on effectively the whole document, which
 * animates every hover state in the product at the same time and adds a second job to
 * a stylesheet that already has to prove it respects reduced motion. A theme is a
 * preference, not a place: the page did not move and nothing needs explaining.
 */

import { useCallback, useEffect, useState } from 'react'
import { Icon } from './Icon'
import * as theme from '../lib/theme'

const NEXT: Record<theme.Theme, theme.Theme> = {
  system: 'light',
  light: 'dark',
  dark: 'system',
}

const NAME: Record<theme.Theme, string> = {
  system: 'follows your system',
  light: 'light',
  dark: 'dark',
}

const ICON: Record<theme.Theme, 'monitor' | 'sun' | 'moon'> = {
  system: 'monitor',
  light: 'sun',
  dark: 'moon',
}

export function ThemeToggle({ className }: { className?: string }) {
  const [choice, setChoice] = useState<theme.Theme>('system')

  /*
   * Read the stored choice after the first paint rather than during the first
   * render, and the reason is the same one as the inline script in index.html.
   * Reading during render would paint a "follows your system" button and then swap it
   * for "light" a moment later, which on a reader who chose light is a visible lie
   * about their own setting on every load. The button mounting with the right label
   * is worth one extra render, and the theme itself is already correct before React
   * runs, so nothing about the page flashes.
   */
  useEffect(() => {
    setChoice(theme.current())
  }, [])

  // A reader following the system should see the app follow it. One listener, and it
  // is torn down with the component.
  useEffect(() => theme.watchSystem(() => setChoice(theme.current())), [])

  const advance = useCallback(() => {
    const next = NEXT[choice]
    theme.set(next)
    setChoice(next)
  }, [choice])

  const next = NEXT[choice]
  const label = `Theme: ${NAME[choice]}. Switch to ${NAME[next]}.`

  return (
    <button
      type="button"
      className={className ? `btn-icon ${className}` : 'btn-icon'}
      onClick={advance}
      aria-label={label}
      title={label}
      data-theme-choice={choice}
    >
      <Icon name={ICON[choice]} />
    </button>
  )
}