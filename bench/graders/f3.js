'use strict';

const { run } = require('./common');

run('F3', ({ finalText }) => (
  finalText.includes('E4711') ? [] : ['final text does not contain E4711']
));
