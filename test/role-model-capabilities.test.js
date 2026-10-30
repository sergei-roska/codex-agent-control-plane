'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { normalizeModelCapability, resolveServiceTierForTurn } = require('../src/model-capabilities');

describe('model capability projection', () => {
  it('normalizes installed reasoning options and advertised tiers', () => {
    assert.deepEqual(normalizeModelCapability({
      id: 'model-x',
      defaultReasoningEffort: null,
      supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Fast' }, { reasoningEffort: 'high', description: 'Deep' }],
      serviceTiers: [{ id: 'tier-2', name: 'Rapid', description: 'Fast service' }],
      serviceTiersKnown: true,
      defaultServiceTier: 'tier-1',
    }), {
      id: 'model-x',
      defaultReasoningEffort: null,
      supportedReasoningEfforts: ['low', 'high'],
      serviceTiers: [{ id: 'tier-2', name: 'Rapid', description: 'Fast service' }],
      serviceTiersKnown: true,
      defaultServiceTier: 'tier-1',
    });
  });

  it('maps Fast off to the documented default and Fast on to an advertised tier id', () => {
    const model = { serviceTiers: [{ id: 'fast', name: 'Fast', description: 'Accelerated service tier' }] };
    assert.equal(resolveServiceTierForTurn('off', model), 'default');
    assert.equal(resolveServiceTierForTurn('on', model), 'fast');
    assert.equal(resolveServiceTierForTurn('inherit', model), null);
  });

  it('rejects Fast on when metadata is unknown or no fast tier is advertised', () => {
    assert.throws(() => resolveServiceTierForTurn('on', null), /unknown/);
    assert.throws(() => resolveServiceTierForTurn('on', { serviceTiers: [], serviceTiersKnown: false }), /unknown/);
    assert.throws(() => resolveServiceTierForTurn('on', { serviceTiers: [{ id: 'standard', name: 'Standard', description: 'Fast tier is unavailable on this plan' }] }), /unavailable/);
    assert.throws(() => resolveServiceTierForTurn('on', { serviceTiers: [{ id: 'fast' }, { id: 'FAST' }] }), /ambiguous/);
  });
});
