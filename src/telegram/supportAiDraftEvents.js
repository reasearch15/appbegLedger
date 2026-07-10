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
  const resolvedGenerationId = generationId || draft?.generation_id || null;
  const payload = {
    draft,
    generationId: resolvedGenerationId,
    contact_id: contact.id,
    contactId: contact.id,
    draft_id: draft?.id || null,
    customer_message_id: draft?.incoming_message_id || null,
    generation_id: resolvedGenerationId,
    status: 'ready'
  };
  emitSupportAiDraftEvent(io, contact, 'ready', payload);
  io.emit('staff-ai-draft:changed', payload);
}

export function emitSupportAiDraftStale(io, contact, { generationId } = {}) {
  emitSupportAiDraftEvent(io, contact, 'stale', { generationId });
}
