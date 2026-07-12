/**
 * Pure helpers for payments table horizontal scroll sync.
 */

export function shouldShowPaymentTopScrollbar(scrollWidth, clientWidth) {
  return Number(scrollWidth) > Number(clientWidth) + 1;
}

/**
 * Apply a scrollLeft change to peer without feedback loops.
 * Returns the next flag + peer scrollLeft to set.
 */
export function syncScrollPair({ sourceScrollLeft, syncing }) {
  if (syncing) {
    return { syncing: true, peerScrollLeft: null };
  }
  return { syncing: false, peerScrollLeft: sourceScrollLeft };
}
