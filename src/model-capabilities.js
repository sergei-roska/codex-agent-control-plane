'use strict';

function normalizeModelCapability(model) {
  return {
    id: model.id,
    defaultReasoningEffort: typeof model.defaultReasoningEffort === 'string' ? model.defaultReasoningEffort : null,
    supportedReasoningEfforts: Array.isArray(model.supportedReasoningEfforts)
      ? model.supportedReasoningEfforts.map((option) => typeof option === 'string' ? option : option.reasoningEffort).filter((value) => typeof value === 'string')
      : [],
    serviceTiers: Array.isArray(model.serviceTiers)
      ? model.serviceTiers.map((tier) => ({ id: tier.id, name: tier.name, description: tier.description }))
      : [],
    serviceTiersKnown: Array.isArray(model.serviceTiers),
    defaultServiceTier: typeof model.defaultServiceTier === 'string' ? model.defaultServiceTier : null,
  };
}

function resolveServiceTierForTurn(fastMode, model) {
  if (fastMode === 'inherit' || !fastMode) return null;
  if (fastMode === 'off') return 'default';
  if (fastMode !== 'on') throw new TypeError('fastMode must be inherit, off, or on');
  if (!model || model.serviceTiersKnown === false || (!Array.isArray(model.serviceTiers) && model.serviceTiersKnown !== true)) {
    throw new Error('Service tier capability is unknown for this model');
  }
  const matches = (model.serviceTiers || []).filter((entry) => typeof entry.id === 'string' && entry.id.trim().toLowerCase() === 'fast');
  if (matches.length > 1) throw new Error('Fast service tier metadata is ambiguous for this model');
  if (matches.length === 0) throw new Error('Fast service tier is unavailable for this model');
  return matches[0].id;
}

module.exports = { normalizeModelCapability, resolveServiceTierForTurn };
