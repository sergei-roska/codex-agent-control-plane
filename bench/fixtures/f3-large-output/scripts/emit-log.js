'use strict';

// Prints about EMIT_LOG_MB MiB (default 20) of fixed-width log lines with
// exactly one "ERROR E4711" line at a pseudo-random, seed-fixed depth.

const mb = Number(process.env.EMIT_LOG_MB || 20);
const LINE_BYTES = 128;
const totalLines = Math.max(10, Math.floor((mb * 1024 * 1024) / LINE_BYTES));

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(4711);
const errorLine = Math.floor(totalLines * (0.2 + rand() * 0.6));
const services = ['api', 'auth', 'billing', 'cache', 'queue', 'search'];
const messages = [
  'request completed',
  'cache refreshed',
  'heartbeat ok',
  'job scheduled',
  'connection pooled',
  'payload validated',
];

function format(i) {
  const svc = services[Math.floor(rand() * services.length)];
  const msg = messages[Math.floor(rand() * messages.length)];
  const ms = Math.floor(rand() * 900) + 10;
  const ts = new Date(Date.UTC(2026, 0, 1) + i * 37).toISOString();
  const body = i === errorLine
    ? 'ERROR E4711 unrecoverable state in settlement handler'
    : `INFO ${svc} ${msg} in ${ms}ms`;
  const line = `${ts} ${body}`;
  return line.padEnd(LINE_BYTES - 1, ' ') + '\n';
}

let next = 0;
function pump() {
  while (next < totalLines) {
    let chunk = '';
    const end = Math.min(totalLines, next + 4096);
    for (; next < end; next += 1) chunk += format(next);
    if (!process.stdout.write(chunk)) {
      process.stdout.once('drain', pump);
      return;
    }
  }
}
pump();
