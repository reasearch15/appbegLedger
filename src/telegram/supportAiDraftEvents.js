export function buildSupportAiGenerationId({ contactId, messageId, jobId }) {
  return `gen-${contactId}-${messageId || jobId || 'na'}-${Date.now()}`;
}

export function emitSupportAiDraftEvent(io, contact, event, payload = {}) {
  if (!io || !contact) return;
  const base = {
    contactId: contact.id,
    userId: contact.id,
    ...payload
  };
  io.emit(`staff-ai-draft-${event}`, base);
  if (event === 'ready') {
    io.emit('staff-ai-draft:changed', {
      ...base,
      draft: payload.draft || null
    });
  }
}

export function emitSupportAiDraftCleared(io, contact) {
  emitSupportAiDraftEvent(io, contact, 'cleared', {});
}

export function emitSupportAiDraftGenerating(io, contact, { draft, generationId, customerMessage } = {}) {
  emitSupportAiDraftEvent(io, contact, 'generating', {
    draft,
    generationId: generationId || draft?.generation_id || null,
    customerMessage: customerMessage || draft?.customer_message || null
  });
}

export function emitSupportAiDraftReady(io, contact, { draft, generationId } = {}) {
  emitSupportAiDraftEvent(io, contact, 'ready', {
    draft,
    generationId: generationId || draft?.generation_id || null
  });
}

export function emitSupportAiDraftStale(io, contact, { generationId } = {}) {
  emitSupportAiDraftEvent(io, contact, 'stale', { generationId });
}
