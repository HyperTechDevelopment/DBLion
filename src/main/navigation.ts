/**
 * Navigation and external-link policy for the renderer window.
 *
 * The renderer runs with the preload bridge attached. Any page loaded into the
 * same window inherits that bridge, so navigation is restricted to the app's
 * own document and external links are restricted to protocols a browser can
 * handle safely. A `file:` or custom-scheme link would otherwise hand the
 * bridge to a local document or trigger a protocol handler.
 */

const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])

export function isAllowedExternalUrl(url: string): boolean {
  try {
    return EXTERNAL_PROTOCOLS.has(new URL(url).protocol)
  } catch {
    return false
  }
}

export function isAllowedAppNavigation(url: string, appUrl: string, devUrl?: string): boolean {
  if (stripFragment(url) === appUrl) return true
  if (!devUrl) return false
  try {
    return new URL(url).origin === new URL(devUrl).origin
  } catch {
    return false
  }
}

function stripFragment(url: string): string {
  const index = url.indexOf('#')
  return index === -1 ? url : url.slice(0, index)
}
