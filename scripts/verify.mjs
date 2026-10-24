// Standalone self-check — no DSH process, no Host, no browser.
//
// It verifies exactly the three assumptions the plugin is built on:
//   1. the channel DoH resolver answers a whitelisted host inside 205.164.0.0/16
//   2. a TLS connection to that address verifies against the pinned root
//   3. the root of the live chain matches the pinned fingerprint
//
// Usage:
//   node scripts/verify.mjs                # github.com, huggingface.co, registry.npmjs.org
//   node scripts/verify.mjs pypi.org arxiv.org
//
// Exit code 0 = every target reached and verified, 1 = something failed.
import { createResolver, probeUrl, buildCaBundle } from '../lib/network.js';
import { SCHOLAR_CA } from '../lib/scholar-ca.js';

const DOH = process.env.SCHOLAR_DOH || 'https://doh.scholar.work/dns-query';
const args = process.argv.slice(2);
const targets = args.length ? args : ['github.com', 'huggingface.co', 'registry.npmjs.org'];

const pad = (value, width) => String(value).padEnd(width);
const resolver = createResolver({ endpoint: DOH });
const ca = buildCaBundle();

console.log(`DoH endpoint : ${DOH}`);
console.log(`pinned root  : ${SCHOLAR_CA.fingerprint256}  (${SCHOLAR_CA.validTo})`);
console.log('');
console.log(`${pad('host', 26)}${pad('status', 8)}${pad('ip', 17)}${pad('channel', 9)}${pad('pin', 10)}ms`);
console.log('-'.repeat(80));

let failures = 0;
for (const target of targets) {
  const url = /^https?:\/\//i.test(target) ? target : `https://${target}/`;
  const host = new URL(url).hostname;
  let result;
  try {
    result = await probeUrl(url, { resolver, ca, verify: true, pinnedFingerprint: SCHOLAR_CA.fingerprint256 });
  } catch (error) {
    result = { ok: false, error: error?.message || String(error) };
  }
  if (!result.ok) failures += 1;
  const status = result.ok ? String(result.status ?? '') : `ERR`;
  const pin = result.cert ? (result.cert.matchesPin ? 'ok' : 'MISMATCH') : '-';
  console.log(
    `${pad(host, 26)}${pad(status, 8)}${pad(result.ip || '-', 17)}${pad(result.channel ? 'yes' : 'no', 9)}${pad(pin, 10)}${result.ms ?? '-'}`
  );
  if (!result.ok && result.error) console.log(`  ↳ ${result.error}`);
}

console.log('');
if (failures === 0) {
  console.log(`OK — ${targets.length}/${targets.length} verified against the pinned root.`);
} else {
  console.log(`FAILED — ${failures}/${targets.length} unreachable or unverified.`);
  console.log('If every target fails: you are probably not on the campus network, or the channel is closed.');
  console.log('If the pin says MISMATCH: the channel rotated its certificate; re-capture lib/scholar-ca.js before trusting it.');
}
process.exit(failures === 0 ? 0 : 1);
