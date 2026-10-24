// Scholar Access — network core.
//
// Three capabilities, all independent of the scholartools.exe client:
//   1. DNS over HTTPS against the CERNET academic channel resolver
//      (default https://doh.scholar.work/dns-query): whitelisted academic
//      domains come back inside 205.164.0.0/16, the channel's reverse proxy.
//   2. TLS trust: the channel proxy presents "Scholar Service" chained to the
//      pinned "Scholar Root CA v1". Connections to channel addresses verify
//      against a merged bundle (Node's Mozilla roots + the pinned root), so
//      every other host still verifies normally.
//   3. A fetch-compatible dispatcher that pins the DoH answer for the socket
//      while keeping SNI = the real hostname.

import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { SCHOLAR_CA_PEM } from './scholar-ca.js';

// ---------------------------------------------------------------------------
// Channel address space
// ---------------------------------------------------------------------------

// The academic channel answers whitelisted domains with 205.164.0.0/16
// (observed: 205.164.50.201-209). Anything else is ordinary internet.
export function isChannelAddress(address) {
  if (typeof address !== 'string') return false;
  const parts = address.split('.');
  if (parts.length !== 4) return false;
  return parts[0] === '205' && parts[1] === '164';
}

// Domains the channel is meant to open up. Used only to decide whether a DoH
// lookup is worth one round trip; a lookup that answers outside the channel
// range simply falls through to a normal connection.
const CHANNEL_SUFFIXES = [
  'github.com',
  'githubusercontent.com',
  'githubassets.com',
  'github.io',
  'githubcopilot.com',
  'huggingface.co',
  'hf.co',
  'huggingface.tech',
  'cdn-lfs.huggingface.co',
  'google.com',
  'googleapis.com',
  'gstatic.com',
  'googleusercontent.com',
  'googlesource.com',
  'wikipedia.org',
  'wikimedia.org',
  'wikidata.org',
  'docker.com',
  'docker.io',
  'ghcr.io',
  'npmjs.org',
  'npmjs.com',
  'yarnpkg.com',
  'pypi.org',
  'pythonhosted.org',
  'anaconda.org',
  'conda.io',
  'crates.io',
  'golang.org',
  'proxy.golang.org',
  'rubygems.org',
  'packagist.org',
  'nuget.org',
  'nodejs.org',
  'archlinux.org',
  'openai.com',
  'anthropic.com',
  'claude.ai',
  'mistral.ai',
  'groq.com',
  'x.ai',
  'arxiv.org',
  'biorxiv.org',
  'medrxiv.org',
  'nature.com',
  'science.org',
  'sciencedirect.com',
  'springer.com',
  'wiley.com',
  'tandfonline.com',
  'sagepub.com',
  'jstor.org',
  'ieee.org',
  'acm.org',
  'aclweb.org',
  'semanticscholar.org',
  'openreview.net',
  'paperswithcode.com',
  'doi.org',
  'crossref.org',
  'orcid.org',
  'web.archive.org',
  'archive.org',
  'zenodo.org',
  'figshare.com',
  'dataverse.org',
  'huggingface.cdn',
  'transformerlens.org',
  'pytorch.org',
  'tensorflow.org',
  'jax.readthedocs.io',
  'readthedocs.io',
  'readthedocs.org',
  'stackoverflow.com',
  'stackexchange.com',
  'gitlab.com',
  'bitbucket.org',
  'sourceforge.net',
  'maven.org',
  'apache.org',
  'jetbrains.com',
  'vscode.dev',
  'notion.so',
  'figma.com',
];

export function isChannelCandidate(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
  if (!host || net.isIP(host)) return false;
  for (const suffix of CHANNEL_SUFFIXES) {
    if (host === suffix || host.endsWith('.' + suffix)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// DNS wire format (the DoH endpoint speaks application/dns-message only)
// ---------------------------------------------------------------------------

const TYPES = { A: 1, AAAA: 28, CNAME: 5 };

function encodeName(name) {
  const chunks = [];
  for (const label of String(name).split('.')) {
    if (!label) continue;
    const bytes = Buffer.from(label, 'latin1');
    chunks.push(Buffer.from([bytes.length]), bytes);
  }
  chunks.push(Buffer.from([0]));
  return Buffer.concat(chunks);
}

export function buildDnsQuery(name, type = 'A', id = crypto.randomInt(1, 0xffff)) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(0x0100, 2); // standard query, recursion desired
  header.writeUInt16BE(1, 4); // one question
  header.writeUInt16BE(0, 6);
  header.writeUInt16BE(0, 8);
  header.writeUInt16BE(0, 10);
  const qtype = TYPES[type] || 1;
  const tail = Buffer.alloc(4);
  tail.writeUInt16BE(qtype, 0);
  tail.writeUInt16BE(1, 2); // IN
  return Buffer.concat([header, encodeName(name), tail]);
}

function readName(buf, offset) {
  const labels = [];
  let cursor = offset;
  let guard = 0;
  while (cursor < buf.length) {
    if (++guard > 128) break;
    const length = buf[cursor];
    if (length === 0) {
      cursor += 1;
      break;
    }
    if ((length & 0xc0) === 0xc0) {
      const pointer = ((length & 0x3f) << 8) | buf[cursor + 1];
      const nested = readName(buf, pointer);
      if (nested.name) labels.push(nested.name);
      cursor += 2;
      return { name: labels.join('.'), offset: cursor };
    }
    labels.push(buf.subarray(cursor + 1, cursor + 1 + length).toString('latin1'));
    cursor += length + 1;
  }
  return { name: labels.join('.'), offset: cursor };
}

export function parseDnsResponse(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) throw new Error('short DNS response');
  const flags = buf.readUInt16BE(2);
  const rcode = flags & 0x0f;
  const questionCount = buf.readUInt16BE(4);
  const answerCount = buf.readUInt16BE(6);
  let offset = 12;
  for (let i = 0; i < questionCount; i += 1) {
    const q = readName(buf, offset);
    offset = q.offset + 4;
  }
  const answers = [];
  for (let i = 0; i < answerCount; i += 1) {
    const owner = readName(buf, offset);
    offset = owner.offset;
    if (offset + 10 > buf.length) break;
    const type = buf.readUInt16BE(offset);
    const ttl = buf.readUInt32BE(offset + 4);
    const rdlength = buf.readUInt16BE(offset + 8);
    offset += 10;
    const rdata = buf.subarray(offset, offset + rdlength);
    offset += rdlength;
    if (type === TYPES.A && rdlength === 4) {
      answers.push({ name: owner.name, type: 'A', ttl, data: [...rdata].join('.') });
    } else if (type === TYPES.AAAA && rdlength === 16) {
      const groups = [];
      for (let g = 0; g < 16; g += 2) groups.push(rdata.readUInt16BE(g).toString(16));
      answers.push({ name: owner.name, type: 'AAAA', ttl, data: groups.join(':') });
    } else if (type === TYPES.CNAME) {
      answers.push({ name: owner.name, type: 'CNAME', ttl, data: readName(buf, offset - rdlength).name });
    }
  }
  return { rcode, answers };
}

// ---------------------------------------------------------------------------
// One plain HTTPS POST helper that never goes through the patched fetch
// ---------------------------------------------------------------------------

export function rawHttpsPost(url, { body, headers = {}, timeoutMs = 6000, signal } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const request = https.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || 443,
        path: `${target.pathname}${target.search}`,
        method: 'POST',
        headers,
        timeout: timeoutMs,
        signal,
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () =>
          resolve({ statusCode: response.statusCode || 0, headers: response.headers, body: Buffer.concat(chunks) })
        );
        response.on('error', reject);
      }
    );
    request.on('timeout', () => request.destroy(new Error(`DoH request timed out after ${timeoutMs} ms`)));
    request.on('error', reject);
    if (body) request.write(body);
    request.end();
  });
}

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

export async function dohResolve(endpoint, hostname, { type = 'A', timeoutMs = 6000, signal } = {}) {
  const query = buildDnsQuery(hostname, type);
  const started = Date.now();
  const response = await rawHttpsPost(endpoint, {
    body: query,
    headers: {
      'content-type': 'application/dns-message',
      accept: 'application/dns-message',
      'content-length': query.length,
    },
    timeoutMs,
    signal,
  });
  const elapsedMs = Date.now() - started;
  if (response.statusCode !== 200) {
    throw new Error(`DoH HTTP ${response.statusCode} (${elapsedMs} ms)`);
  }
  const parsed = parseDnsResponse(response.body);
  if (parsed.rcode !== 0) {
    const reasons = { 1: 'FORMERR', 2: 'SERVFAIL', 3: 'NXDOMAIN', 4: 'NOTIMP', 5: 'REFUSED' };
    throw new Error(`DoH ${reasons[parsed.rcode] || `rcode ${parsed.rcode}`} for ${hostname}`);
  }
  const wanted = type === 'AAAA' ? 'AAAA' : 'A';
  const addresses = parsed.answers.filter((answer) => answer.type === wanted).map((answer) => answer.data);
  return { addresses, answers: parsed.answers, elapsedMs };
}

async function systemResolve(hostname, family = 0) {
  const found = await dns.promises.lookup(hostname, { all: true, family, verbatim: true });
  return found.map((entry) => entry.address);
}

export function createResolver({ endpoint, timeoutMs = 6000, cacheTtlMs = 300_000, preferDoh = true, logger } = {}) {
  const cache = new Map();
  let dohEnabled = preferDoh !== false;
  // A channel that refuses or times out must not add a timeout to every first
  // request. One failed probe disables DoH for a while; a later success (or an
  // explicit setPreferDoh) re-arms it.
  let dohCooldownUntil = 0;

  function noteDohFailure() {
    dohEnabled = false;
  }

  function setPreferDoh(value) {
    dohEnabled = Boolean(value);
  }

  async function remember(key, promise) {
    const entry = { value: promise, expires: Date.now() + cacheTtlMs };
    cache.set(key, entry);
    promise.catch(() => cache.delete(key));
    return promise;
  }

  function cached(key) {
    const entry = cache.get(key);
    if (!entry) return undefined;
    if (entry.expires <= Date.now()) {
      cache.delete(key);
      return undefined;
    }
    return entry.value;
  }

  // Resolve one host to the best address, plus where the answer came from.
  async function resolve(hostname, { signal } = {}) {
    const key = `A:${hostname}`;
    const already = cached(key);
    if (already) return already;
    return remember(
      key,
      (async () => {
        let dohError;
        if (dohEnabled && endpoint) {
          try {
            const result = await dohResolve(endpoint, hostname, { timeoutMs, signal });
            if (result.addresses.length > 0) {
              const address = result.addresses[0];
              return {
                hostname,
                address,
                addresses: result.addresses,
                channel: isChannelAddress(address),
                source: 'doh',
                elapsedMs: result.elapsedMs,
              };
            }
            dohError = new Error('DoH returned no A records');
          } catch (error) {
            dohError = error;
            // A policy answer (REFUSED / SERVFAIL / NXDOMAIN) is a fast, single
            // host's answer — it must not switch the resolver off for the whole
            // session. Only a transport failure (timeout, unreachable) means the
            // endpoint itself is unusable, so system DNS becomes the default.
            const message = String(error?.message || '');
            if (!/REFUSED|SERVFAIL|NXDOMAIN|FORMERR|NOTIMP/.test(message)) noteDohFailure();
            logger?.debug?.(`[scholar-access] DoH lookup failed for ${hostname}: ${message}`);
          }
        }
        try {
          const addresses = await systemResolve(hostname);
          if (addresses.length === 0) throw new Error('system DNS returned no address');
          const address = addresses[0];
          return {
            hostname,
            address,
            addresses,
            channel: isChannelAddress(address),
            source: 'system',
            elapsedMs: 0,
            dohError: dohError ? dohError.message : undefined,
          };
        } catch (error) {
          if (dohError) throw new Error(`DoH: ${dohError.message}; system DNS: ${error.message}`);
          throw error;
        }
      })()
    );
  }

  function clear() {
    cache.clear();
  }

  return { resolve, clear, size: () => cache.size, setPreferDoh, isPreferDoh: () => dohEnabled };
}

// ---------------------------------------------------------------------------
// TLS trust: Mozilla roots + the pinned channel root
// ---------------------------------------------------------------------------

export function buildCaBundle() {
  const roots = Array.isArray(tls.rootCertificates) ? tls.rootCertificates : [];
  return `${roots.join('\n')}\n${SCHOLAR_CA_PEM}\n`;
}

export function describeScholarCa() {
  try {
    const certificate = new crypto.X509Certificate(SCHOLAR_CA_PEM);
    return {
      subject: certificate.subject,
      issuer: certificate.issuer,
      validFrom: certificate.validFrom,
      validTo: certificate.validTo,
      fingerprint256: certificate.fingerprint256,
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

// ---------------------------------------------------------------------------
// Channel-aware fetch
// ---------------------------------------------------------------------------

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function headersToObject(headers) {
  if (!headers) return {};
  if (typeof headers.forEach === 'function' && !Array.isArray(headers)) {
    const result = {};
    headers.forEach((value, key) => {
      result[key] = value;
    });
    return result;
  }
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  return { ...headers };
}

function normalizeBody(body) {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string' || Buffer.isBuffer(body) || body instanceof Uint8Array) return body;
  if (body instanceof URLSearchParams) return Buffer.from(body.toString(), 'utf8');
  return null; // streams and FormData: caller delegates to the original fetch
}

export function describePeerCert(peer) {
  const chain = [];
  const seen = new Set();
  let current = peer;
  while (current && current.raw && !seen.has(current.fingerprint256)) {
    seen.add(current.fingerprint256);
    chain.push({
      subject: current.subject && current.subject.CN,
      issuer: current.issuer && current.issuer.CN,
      fingerprint256: current.fingerprint256,
      validTo: current.valid_to,
      selfSigned: Boolean(current.subject && current.issuer && current.subject.CN === current.issuer.CN),
    });
    current = current.issuerCertificate;
  }
  return { chain, root: chain.length ? chain[chain.length - 1] : null };
}

/**
 * Perform one HTTP(S) request, connecting to `resolved.address` while keeping
 * SNI/Host equal to the real hostname. Returns a standard Response.
 */
export function channelFetch(url, init = {}, options = {}) {
  const { ca, resolver, channelOnly = false } = options;
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch (error) {
      reject(error);
      return;
    }
    const isHttps = target.protocol === 'https:';
    if (!isHttps && target.protocol !== 'http:') {
      reject(new Error(`unsupported protocol ${target.protocol}`));
      return;
    }
    const hostname = target.hostname;
    const method = (init.method || 'GET').toUpperCase();
    const headers = headersToObject(init.headers);
    const body = normalizeBody(init.body);
    if (body === null) {
      reject(Object.assign(new Error('streamed request bodies bypass the channel'), { code: 'CHANNEL_BODY_UNSUPPORTED' }));
      return;
    }
    if (body !== undefined && headers['content-length'] === undefined && headers['Content-Length'] === undefined) {
      headers['content-length'] = Buffer.byteLength(body);
    }
    if (!Object.keys(headers).some((key) => key.toLowerCase() === 'user-agent')) headers['user-agent'] = 'dsh-scholar-access';

    const attempt = (currentUrl, redirectsLeft) => {
      const current = new URL(currentUrl);
      resolver
        .resolve(current.hostname, { signal: init.signal })
        .then((resolution) => {
          if (channelOnly && !resolution.channel) {
            reject(Object.assign(new Error(`${current.hostname} is not on the academic channel`), { code: 'NOT_CHANNEL' }));
            return;
          }
          const requestHeaders = { ...headers, host: current.host };
          const requestOptions = {
            host: resolution.address,
            port: Number(current.port || (current.protocol === 'https:' ? 443 : 80)),
            path: `${current.pathname}${current.search}`,
            method,
            headers: requestHeaders,
            signal: init.signal,
            timeout: options.timeoutMs || 30_000,
            lookup: (_hostname, _options, callback) => callback(null, resolution.address, net.isIP(resolution.address) === 6 ? 6 : 4),
          };
          let request;
          try {
            request = (current.protocol === 'https:' ? https : http).request(
              current.protocol === 'https:'
                ? { ...requestOptions, servername: current.hostname, ca, rejectUnauthorized: options.rejectUnauthorized !== false }
                : requestOptions,
              (response) => {
                const status = response.statusCode || 0;
                const location = response.headers.location;
                if (REDIRECT_STATUSES.has(status) && location && redirectsLeft > 0) {
                  response.resume();
                  const nextUrl = new URL(location, current).href;
                  const nextMethod = status === 303 || ((status === 301 || status === 302) && method === 'POST') ? 'GET' : method;
                  if (nextMethod !== method) {
                    delete headers['content-length'];
                    delete headers['Content-Length'];
                  }
                  attempt(nextUrl, redirectsLeft - 1);
                  return;
                }
                const responseHeaders = new Headers();
                for (const [key, value] of Object.entries(response.headers)) {
                  if (value === undefined) continue;
                  if (Array.isArray(value)) for (const item of value) responseHeaders.append(key, String(item));
                  else responseHeaders.append(key, String(value));
                }
                const noBody = status === 204 || status === 304 || status === 101;
                const stream = noBody ? null : Readable.toWeb(response);
                resolve(
                  new Response(stream, { status, statusText: response.statusMessage || '', headers: responseHeaders })
                );
              }
            );
          } catch (error) {
            reject(error);
            return;
          }
          request.on('timeout', () => request.destroy(new Error(`request timed out: ${current.href}`)));
          request.on('error', reject);
          if (typeof options.onPeerCertificate === 'function') {
            request.on('socket', (socket) => {
              const grab = () => {
                try {
                  const certificate = socket.getPeerCertificate?.(true);
                  // An empty object means the handshake has not produced a chain yet.
                  if (certificate && certificate.raw) options.onPeerCertificate(describePeerCert(certificate));
                } catch {
                  /* no peer certificate available */
                }
              };
              if (socket.encrypted) {
                // A pooled TLS socket is already connected; a fresh one is not,
                // and reading it before secureConnect yields an empty object.
                if (socket.getPeerCertificate?.()?.raw) grab();
                else socket.once('secureConnect', grab);
              } else {
                socket.once('secureConnect', grab);
              }
            });
          }
          if (body !== undefined) request.write(body);
          request.end();
        })
        .catch(reject);
    };

    attempt(url, options.maxRedirects ?? 5);
  });
}

/**
 * Wrap the process-wide fetch. Only URLs whose host is a channel candidate are
 * affected; everything else reaches the original fetch untouched.
 */
export function installFetchPatch({ resolver, ca, mode, extraHosts, timeoutMs, logger, onCall, originalFetch }) {
  const base = originalFetch || globalThis.fetch;
  if (typeof base !== 'function') return () => {};
  const extra = new Set((extraHosts || []).map((host) => String(host).toLowerCase()));

  async function patched(input, init = {}) {
    let url;
    if (typeof input === 'string') url = input;
    else if (input instanceof URL) url = input.href;
    else if (input && typeof input.url === 'string') url = input.url;

    if (!url || !/^https?:/i.test(url)) return base(input, init);

    let hostname;
    try {
      hostname = new URL(url).hostname.toLowerCase();
    } catch {
      return base(input, init);
    }

    const candidate = extra.has(hostname) || isChannelCandidate(hostname);
    if (!candidate) {
      onCall?.({ hostname, url, action: 'direct', reason: 'not a channel candidate' });
      return base(input, init);
    }

    if (mode === 'always' || (mode === 'auto' && candidate)) {
      try {
        const resolution = await resolver.resolve(hostname, { signal: init.signal });
        // A candidate that resolves outside the channel range still works
        // through the channel path (it just talks to the real address), but
        // using the original fetch keeps normal TLS/pooling behavior intact.
        if (!resolution.channel && mode !== 'always') {
          onCall?.({ hostname, url, action: 'direct', reason: 'resolved outside the channel range', resolution });
          return base(input, init);
        }
        const response = await channelFetch(url, init, { resolver, ca, timeoutMs, rejectUnauthorized: true });
        onCall?.({ hostname, url, action: 'channel', resolution, status: response.status });
        return response;
      } catch (error) {
        logger?.warn?.(`[scholar-access] channel request failed for ${hostname}: ${error.message}`);
        onCall?.({ hostname, url, action: 'failed', error: error.message });
        if (mode === 'always') throw error;
        return base(input, init);
      }
    }
    onCall?.({ hostname, url, action: 'direct', reason: 'channel disabled' });
    return base(input, init);
  }

  const patchedFetch = Object.assign(patched, {
    preconnect: base.preconnect,
    __scholarAccessPatched: true,
  });
  globalThis.fetch = patchedFetch;
  return () => {
    if (globalThis.fetch === patchedFetch) globalThis.fetch = base;
  };
}

export async function probeUrl(url, { resolver, ca, timeoutMs = 15_000, signal, verify = true, pinnedFingerprint } = {}) {
  const started = Date.now();
  let peer = null;
  const certOf = () =>
    peer
      ? {
          rootSubject: peer.root && peer.root.subject,
          rootFingerprint256: peer.root && peer.root.fingerprint256,
          chainLength: peer.chain.length,
          matchesPin: pinnedFingerprint ? (peer.root && peer.root.fingerprint256) === pinnedFingerprint : undefined,
        }
      : undefined;
  try {
    const response = await channelFetch(url, { method: 'GET', signal, headers: { 'user-agent': 'dsh-scholar-access-probe' } }, {
      resolver,
      ca,
      timeoutMs,
      maxRedirects: 3,
      rejectUnauthorized: verify,
      onPeerCertificate: (captured) => {
        peer = captured;
      },
    });
    const reader = response.body ? response.body.getReader() : null;
    let bytes = 0;
    if (reader) {
      // Read just enough to prove the body flows, then cancel.
      while (bytes < 4096) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value?.byteLength || 0;
      }
      await reader.cancel().catch(() => {});
    }
    const resolution = await resolver.resolve(new URL(url).hostname, { signal }).catch(() => null);
    return {
      url,
      ok: response.status >= 200 && response.status < 400,
      status: response.status,
      ip: resolution?.address,
      channel: resolution?.channel ?? false,
      source: resolution?.source,
      verified: verify,
      ms: Date.now() - started,
      server: response.headers.get('server') || undefined,
      cert: certOf(),
    };
  } catch (error) {
    const resolution = await resolver.resolve(new URL(url).hostname, { signal }).catch(() => null);
    return {
      url,
      ok: false,
      error: error?.code || error?.message || String(error),
      ip: resolution?.address,
      channel: resolution?.channel ?? false,
      source: resolution?.source,
      verified: verify,
      ms: Date.now() - started,
      cert: certOf(),
    };
  }
}
