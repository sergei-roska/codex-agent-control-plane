'use strict';
const { ConcurrentDeliveryEngine } = require('../../../../src/concurrent-delivery-engine');
const original = ConcurrentDeliveryEngine.prototype.shutdown;
ConcurrentDeliveryEngine.prototype.shutdown = async function (...args) {
  const start = Date.now();
  const rows = this.roleService.projection();
  console.error('DIAGNOSTIC shutdown start', JSON.stringify({ active: this.roleService.active.size, rows,
    controllers: this.controllers.size, storedRuns: this.db.prepare('SELECT count(*) AS n FROM concurrent_delivery_runs').get().n }));
  try {
    const result = await original.apply(this, args);
    console.error('DIAGNOSTIC shutdown result', Date.now() - start, result.safeToRelease);
    return result;
  } catch (cause) {
    console.error('DIAGNOSTIC shutdown refusal', Date.now() - start, cause.code);
    throw cause;
  }
};
