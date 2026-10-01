'use strict';

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function key(ref) {
  return `${ref.sourceKind}\0${ref.originId}\0${ref.externalId}`;
}

function createFixtureSourceProvider({ documents = [] } = {}) {
  const records = new Map();
  for (const document of documents) {
    if (!document || !['jira', 'confluence'].includes(document.sourceKind)
      || typeof document.originId !== 'string' || typeof document.externalId !== 'string') {
      throw new TypeError('Fixture documents require a typed source identity');
    }
    records.set(key(document), clone(document));
    if (document.sourceKind === 'jira' && typeof document.displayKey === 'string') {
      records.set(key({ ...document, externalId: document.displayKey }), clone(document));
    }
  }
  return Object.freeze({
    async read(ref) {
      const document = records.get(key(ref));
      return document
        ? clone(document)
        : { ...clone(ref), availability: 'missing', title: 'Source context missing', text: '', links: [] };
    },
  });
}

module.exports = { createFixtureSourceProvider };
