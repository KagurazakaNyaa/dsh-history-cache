/**
 * Host half of the history-cache bundle.
 *
 * The behaviour is entirely Client-side: `client.js` keeps recently opened
 * sessions resident so switching back reuses their already-loaded history
 * window instead of asking the Host for it again. Nothing is registered here.
 */
export function apply() {}
