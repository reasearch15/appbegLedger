/** Emit live-update events for the Ongoing dashboard. */
export function emitOngoingChanged(io, payload = {}) {
  if (!io) return;
  io.emit('ongoing:changed', payload);
}
