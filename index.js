// dsh-scholar-access — carry a DSH client over the CERNET academic channel.
//
// Everything here works without scholartools.exe running: name resolution goes
// through the channel's DoH resolver, and TLS to the channel's reverse proxy is
// verified against a pinned root CA that was taken from the live chain and is
// re-verified on every status call.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createResolver,
  buildCaBundle,
  describeScholarCa,
  installFetchPatch,
  probeUrl,
  dohResolve,
  isChannelAddress,
  isChannelCandidate,
} from './lib/network.js';
import { createChannelProxy } from './lib/proxy.js';
import { scanSystemStores, removeFromUserStore, removeFromMachineStore, setSystemDisallowed } from './lib/certstore.js';
import { SCHOLAR_CA, SCHOLAR_CA_PEM } from './lib/scholar-ca.js';

// Peer packages resolve inside the Harness process. Probe them instead of
// hard-failing when a plugin is loaded outside a full DSH install.
let defineTool = null;
try {
  ({ defineTool } = await import('@deepseek-ai/dsh-tools'));
} catch {
  defineTool = null;
}
let z = null;
try {
  ({ default: z } = await import('@deepseek-ai/schemastery'));
} catch {
  z = null;
}

const PLUGIN_VERSION = '1.0.0';
const ROUTE_PREFIX = '/api/scholar-access';
const DEFAULT_DOH = 'https://doh.scholar.work/dns-query';
const DEFAULT_TEST_HOSTS = [
  'github.com',
  'api.github.com',
  'raw.githubusercontent.com',
  'huggingface.co',
  'cdn-lfs.huggingface.co',
  'registry.npmjs.org',
  'pypi.org',
  'scholar.edu.cn',
];
// Windows resolves environment names case-insensitively, so writing both
// HTTPS_PROXY and https_proxy creates one variable under whichever casing was
// written last, and reading the other casing returns the value just written.
// That is why the snapshot below is taken once, before anything is injected,
// and why Windows only ever writes the upper-case names.
const CERT_ENV_KEYS = ['SSL_CERT_FILE', 'CURL_CA_BUNDLE', 'GIT_SSL_CAINFO', 'REQUESTS_CA_BUNDLE', 'NODE_EXTRA_CA_CERTS'];
const PROXY_ENV_KEYS =
  process.platform === 'win32'
    ? ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY']
    : ['https_proxy', 'http_proxy', 'no_proxy', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY'];
// NOTE: NODE_USE_ENV_PROXY is deliberately NOT injected. Node 24 makes
// http(s).request honour HTTPS_PROXY when that flag is set, and this plugin's own
// channel requests run inside the same process — the flag would route them back
// into this plugin's local proxy and break the channel path it is building.
// Node child scripts that need it can opt in themselves.
const ENV_KEYS = [...PROXY_ENV_KEYS, ...CERT_ENV_KEYS];

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const CONFIG_DEFAULTS = {
  enabled: true,
  dohEndpoint: DEFAULT_DOH,
  mode: 'auto',
  patchHostFetch: true,
  startProxy: true,
  proxyPort: 0,
  injectEnv: true,
  extraHosts: [],
  testHosts: DEFAULT_TEST_HOSTS,
};

export const Config = z
  ? z.object({
      enabled: z.boolean().default(CONFIG_DEFAULTS.enabled).description('通道总开关初值（可在插件页即时切换）'),
      dohEndpoint: z.string().default(DEFAULT_DOH).description('通道 DoH 解析地址'),
      mode: z
        .union([z.const('auto'), z.const('always')])
        .default('auto')
        .description('auto: 仅白名单域名走通道；always: 所有域名都先走 DoH 解析'),
      patchHostFetch: z.boolean().default(true).description('接管 DSH 宿主进程的 fetch（插件、AI、插件市场索引源）'),
      startProxy: z.boolean().default(true).description('启动本地转发代理，供命令行工具（git/npm/curl/pip）使用'),
      proxyPort: z.natural().default(0).description('本地代理端口，0 表示自动分配'),
      injectEnv: z.boolean().default(true).description('把代理与 CA 注入子进程环境变量'),
      extraHosts: z.array(z.string()).default([]).description('额外需要走通道的域名'),
      testHosts: z.array(z.string()).default(DEFAULT_TEST_HOSTS).description('可访问性测试的默认域名列表'),
    })
  : undefined;

function normalizeConfig(input) {
  const raw = input && typeof input === 'object' ? input : {};
  const mode = raw.mode === 'always' ? 'always' : 'auto';
  return {
    enabled: raw.enabled === undefined ? CONFIG_DEFAULTS.enabled : Boolean(raw.enabled),
    dohEndpoint: typeof raw.dohEndpoint === 'string' && raw.dohEndpoint.trim() ? raw.dohEndpoint.trim() : DEFAULT_DOH,
    mode,
    patchHostFetch: raw.patchHostFetch === undefined ? true : Boolean(raw.patchHostFetch),
    startProxy: raw.startProxy === undefined ? true : Boolean(raw.startProxy),
    proxyPort: Number.isInteger(raw.proxyPort) && raw.proxyPort > 0 ? raw.proxyPort : 0,
    injectEnv: raw.injectEnv === undefined ? true : Boolean(raw.injectEnv),
    extraHosts: Array.isArray(raw.extraHosts) ? raw.extraHosts.map(String).filter(Boolean) : [],
    testHosts: Array.isArray(raw.testHosts) && raw.testHosts.length ? raw.testHosts.map(String) : DEFAULT_TEST_HOSTS,
  };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function dataDirectory() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const dir = path.join(home, 'scholar-access');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function readJsonFile(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonFile(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return String(url || '').replace(/^[a-z]+:\/\//i, '').split('/')[0];
  }
}

function normalizeTargets(targets) {
  const list = Array.isArray(targets) && targets.length ? targets : null;
  if (!list) return null;
  return list
    .map((target) => String(target || '').trim())
    .filter(Boolean)
    .map((target) => (/^https?:\/\//i.test(target) ? target : `https://${target.replace(/^\/+/, '')}/`));
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export function apply(ctx, rawConfig) {
  const cfg = normalizeConfig(rawConfig);
  const dir = dataDirectory();
  const stateFile = path.join(dir, 'state.json');
  const caFile = path.join(dir, 'ca-bundle.pem');
  const scholarCaFile = path.join(dir, 'scholar-root.pem');
  const logger = ctx.logger;
  const persisted = readJsonFile(stateFile, {});

  const runtime = {
    enabled: typeof persisted.enabled === 'boolean' ? persisted.enabled : cfg.enabled,
    mode: persisted.mode === 'always' || persisted.mode === 'auto' ? persisted.mode : cfg.mode,
    // Trust is an explicit, revocable decision. It starts false even though the
    // plugin ships the root certificate: shipping a PEM is not a trust act, and
    // nothing uses it until the user turns channel traffic on.
    trusted: persisted.trusted === true,
    startedAt: new Date().toISOString(),
  };

  // Channel traffic is only possible when the user both wants it (enabled) and
  // has accepted the channel's root certificate (trusted).
  function isActive() {
    return runtime.enabled && runtime.trusted;
  }

  function caFilesPresent() {
    return fs.existsSync(caFile) && fs.existsSync(scholarCaFile);
  }

  function writeCaFiles() {
    fs.writeFileSync(caFile, buildCaBundle(), 'utf8');
    fs.writeFileSync(scholarCaFile, `${SCHOLAR_CA_PEM}\n`, 'utf8');
  }

  // Removing these two files removes every copy of the certificate this plugin
  // ever writes. The PEM in lib/scholar-ca.js stays in the package as data; it
  // has no effect until it is loaded into a TLS trust list or an env var.
  function removeCaFiles() {
    for (const file of [caFile, scholarCaFile]) {
      try {
        fs.rmSync(file, { force: true });
      } catch (error) {
        logger?.warn?.(`[scholar-access] failed to remove ${file}: ${error.message}`);
      }
    }
  }

  if (runtime.trusted) writeCaFiles();

  const resolver = createResolver({
    endpoint: cfg.dohEndpoint,
    logger,
    preferDoh: true,
  });

  // Original values, captured once before the first injection. Kept across
  // enable/disable cycles so re-enabling can never mistake an injected value
  // for the original one.
  const envSnapshot = new Map();
  function takeEnvSnapshot() {
    if (envSnapshot.size > 0) return;
    for (const key of ENV_KEYS) envSnapshot.set(key, process.env[key]);
  }

  let proxyHandle = null;
  let removeFetchPatch = null;
  let extraHosts = [...cfg.extraHosts];
  // Bumped on every start/stop so an in-flight start can tell that the plugin
  // was torn down (or restarted) while it was probing the resolver.
  let generation = 0;

  // Observable proof of scope: every fetch the host makes after the patch is
  // recorded here, so the settings page can show what actually travelled over
  // the channel instead of only claiming that it does.
  const traffic = { channel: 0, direct: 0, failed: 0, hosts: {}, last: null };
  function recordCall(event) {
    if (!event || !event.hostname) return;
    if (event.action === 'channel') traffic.channel += 1;
    else if (event.action === 'failed') traffic.failed += 1;
    else traffic.direct += 1;
    const entry = traffic.hosts[event.hostname] || { channel: 0, direct: 0, failed: 0, channelAddress: null };
    entry[event.action] = (entry[event.action] || 0) + 1;
    if (event.resolution?.address) entry.channelAddress = event.resolution.address;
    traffic.hosts[event.hostname] = entry;
    traffic.last = { hostname: event.hostname, action: event.action, at: new Date().toISOString(), status: event.status, error: event.error };
  }

  function injectEnv() {
    if (!cfg.injectEnv) return;
    takeEnvSnapshot();
    const proxyUrl = proxyHandle?.url;
    const values = {
      SSL_CERT_FILE: caFile,
      CURL_CA_BUNDLE: caFile,
      GIT_SSL_CAINFO: caFile,
      REQUESTS_CA_BUNDLE: caFile,
      NODE_EXTRA_CA_CERTS: scholarCaFile,
    };
    if (proxyUrl) {
      for (const key of PROXY_ENV_KEYS) values[key] = key === 'NO_PROXY' || key === 'no_proxy' ? 'localhost,127.0.0.1,::1' : proxyUrl;
    }
    for (const [key, value] of Object.entries(values)) process.env[key] = value;
  }

  function restoreEnv() {
    if (envSnapshot.size === 0) return;
    for (const [key, value] of envSnapshot.entries()) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  async function start() {
    if (removeFetchPatch) return;
    const gen = ++generation;
    // Probe once before taking traffic: an unreachable channel resolver should
    // cost one short request, not a timeout on every new host.
    const health = await dohHealth();
    if (gen !== generation) return;
    resolver.setPreferDoh(health.ok);
    if (!health.ok) logger?.warn?.(`[scholar-access] DoH resolver unreachable (${health.error}); using system DNS`);
    if (cfg.startProxy) {
      try {
        proxyHandle = await createChannelProxy({ resolver, logger, port: cfg.proxyPort });
        logger?.info?.(`[scholar-access] local proxy listening on ${proxyHandle.url}`);
      } catch (error) {
        proxyHandle = null;
        logger?.warn?.(`[scholar-access] local proxy failed to start: ${error.message}`);
      }
    }
    injectEnv();
    if (cfg.patchHostFetch) {
      removeFetchPatch = installFetchPatch({
        resolver,
        ca: buildCaBundle(),
        mode: runtime.mode,
        extraHosts,
        logger,
        onCall: recordCall,
      });
    }
  }

  async function stop() {
    generation += 1;
    if (removeFetchPatch) {
      removeFetchPatch();
      removeFetchPatch = null;
    }
    restoreEnv();
    if (proxyHandle) {
      await proxyHandle.close().catch(() => {});
      proxyHandle = null;
    }
  }

  function persistState() {
    writeJsonFile(stateFile, {
      enabled: runtime.enabled,
      mode: runtime.mode,
      trusted: runtime.trusted,
      updatedAt: new Date().toISOString(),
    });
  }

  async function setEnabled(enabled) {
    const next = Boolean(enabled);
    if (next === runtime.enabled) return runtime.enabled;
    runtime.enabled = next;
    if (next && runtime.trusted) await start();
    else await stop();
    persistState();
    return runtime.enabled;
  }

  // Accepting the channel's root certificate. Nothing is written to the OS
  // trust stores: this only decides whether channel connections are verified
  // against the pinned root within this process (and the children it spawns).
  async function setTrusted(trusted) {
    const next = Boolean(trusted);
    if (next === runtime.trusted) return runtime.trusted;
    await stop();
    runtime.trusted = next;
    if (next) writeCaFiles();
    else removeCaFiles();
    if (runtime.enabled && runtime.trusted) await start();
    persistState();
    logger?.[next ? 'info' : 'warn']?.(`[scholar-access] channel root certificate ${next ? 'trusted' : 'revoked'}`);
    return runtime.trusted;
  }

  async function describe() {
    return {
      ok: true,
      version: PLUGIN_VERSION,
      enabled: runtime.enabled,
      trusted: runtime.trusted,
      active: isActive(),
      mode: runtime.mode,
      doh: { endpoint: cfg.dohEndpoint, preferDoh: resolver.isPreferDoh(), cacheSize: resolver.size() },
      proxy: proxyHandle ? { running: true, url: proxyHandle.url, port: proxyHandle.port, stats: proxyHandle.stats } : { running: false },
      hostFetchPatched: Boolean(removeFetchPatch),
      env: {
        injected: Boolean(process.env.SSL_CERT_FILE && process.env.SSL_CERT_FILE === caFile),
        keys: ENV_KEYS.filter((key) => process.env[key] !== undefined && process.env[key] !== envSnapshot.get(key)),
        snapshotTaken: envSnapshot.size > 0,
      },
      ca: {
        pinned: SCHOLAR_CA,
        live: describeScholarCa(),
        files: { bundle: caFile, scholarRoot: scholarCaFile },
        filesPresent: caFilesPresent(),
        trusted: runtime.trusted,
      },
      extraHosts,
      testHosts: cfg.testHosts,
      traffic: {
        channel: traffic.channel,
        direct: traffic.direct,
        failed: traffic.failed,
        hosts: traffic.hosts,
        last: traffic.last,
      },
      dataDir: dir,
    };
  }

  async function dohHealth(attempts = 3) {
    let last;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const started = Date.now();
      try {
        // Probe a channel host: the resolver answers for whitelisted names, so
        // this also proves the whitelist is reachable, not just the endpoint.
        const result = await dohResolve(cfg.dohEndpoint, 'github.com', { timeoutMs: 5000 });
        if (result.addresses.length > 0) {
          return { ok: true, ms: Date.now() - started, addresses: result.addresses };
        }
        last = { ok: false, ms: Date.now() - started, error: 'no A records' };
      } catch (error) {
        last = { ok: false, ms: Date.now() - started, error: error?.message || String(error) };
      }
      if (attempt < attempts - 1) await new Promise((resolve) => setTimeout(resolve, 400));
    }
    return last || { ok: false, error: 'no attempt made' };
  }

  async function runTests(targets) {
    const urls = normalizeTargets(targets) || cfg.testHosts.map((host) => (/^https?:\/\//i.test(host) ? host : `https://${host}/`));
    const results = [];
    // Before the user accepts the certificate, the probe still completes the
    // handshake but does not verify it, and reports the chain fingerprint so the
    // decision can be made on evidence rather than on trust-me.
    const verify = runtime.trusted;
    await Promise.all(
      urls.map(async (url) => {
        const result = await probeUrl(url, {
          resolver,
          ca: verify ? buildCaBundle() : undefined,
          verify,
          pinnedFingerprint: SCHOLAR_CA.fingerprint256,
          timeoutMs: 20_000,
        });
        results.push({ ...result, host: hostOf(url) });
      })
    );
    results.sort((left, right) => urls.findIndex((url) => hostOf(url) === left.host) - urls.findIndex((url) => hostOf(url) === right.host));
    return {
      ok: results.every((result) => result.ok),
      at: new Date().toISOString(),
      enabled: runtime.enabled,
      trusted: runtime.trusted,
      active: isActive(),
      results,
    };
  }

  async function resolveHost(host) {
    const started = Date.now();
    try {
      const resolution = await resolver.resolve(host);
      return { ok: true, host, ...resolution, ms: Date.now() - started };
    } catch (error) {
      return { ok: false, host, error: error?.message || String(error), ms: Date.now() - started };
    }
  }

  // --- effects: apply current runtime state, tear everything down on unload ---
  ctx.effect(() => {
    if (isActive()) start();
    return () => {
      stop();
    };
  }, 'scholar-access: channel runtime');

  // --- tools -----------------------------------------------------------------
  const toolSpecs = [
    {
      name: 'scholar_access_test',
      description:
        'Test whether the campus academic channel can reach international resources (GitHub, Hugging Face, npm, PyPI) from this DSH client. Resolves each host through the doh.scholar.work resolver, connects to the channel reverse proxy, and reports status, IP and latency per host.',
      parameters: {
        targets: {
          type: 'array',
          description: 'Hostnames or URLs to test. Defaults to the plugin settings test list (GitHub, Hugging Face, npm, PyPI, scholar.edu.cn).',
          items: { type: 'string' },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            enabled: { type: 'boolean' },
            at: { type: 'string' },
            results: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  host: { type: 'string' },
                  url: { type: 'string' },
                  ok: { type: 'boolean' },
                  status: { type: 'number' },
                  ip: { type: 'string' },
                  channel: { type: 'boolean' },
                  source: { type: 'string' },
                  ms: { type: 'number' },
                  server: { type: 'string' },
                  error: { type: 'string' },
                },
              },
            },
          },
        },
      },
      async execute(args) {
        return runTests(args?.targets);
      },
    },
    {
      name: 'scholar_access_status',
      description:
        'Report the academic channel state: whether it is enabled, the DoH resolver health, the local proxy, injected environment variables, and the pinned Scholar root CA fingerprint.',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: true },
      },
      async execute() {
        const status = await describe();
        const health = await dohHealth();
        if (health.ok && !resolver.isPreferDoh()) resolver.setPreferDoh(true);
        return { ...status, dohHealth: health };
      },
    },
    {
      name: 'scholar_resolve',
      description:
        'Resolve a hostname through the campus academic DoH resolver (doh.scholar.work) and report whether the answer points into the channel reverse-proxy range 205.164.0.0/16.',
      parameters: {
        host: { type: 'string', description: 'Hostname to resolve, e.g. github.com.' },
      },
      async execute(args) {
        const host = typeof args?.host === 'string' ? args.host.trim() : '';
        if (!host) return { ok: false, error: 'host is required' };
        return resolveHost(host);
      },
    },
  ];

  ctx.inject(['tools'], (sctx) => {
    const disposers = [];
    for (const spec of toolSpecs) {
      let definition;
      try {
        definition = typeof defineTool === 'function' ? defineTool(spec) : spec;
      } catch (error) {
        logger?.warn?.(`[scholar-access] tool ${spec.name} definition rejected: ${error.message}`);
        continue;
      }
      disposers.push(sctx.tools.register(definition));
    }
    sctx.effect(() => () => {
      for (const dispose of disposers) {
        try {
          dispose();
        } catch {
          /* already gone */
        }
      }
    }, 'scholar-access: tools');
  });

  // --- settings bridge (used by the plugin page and the client card) ----------
  function sendJson(response, status, value) {
    const body = JSON.stringify(value);
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
    });
    response.end(body);
  }

  async function readJsonBody(request) {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    if (chunks.length === 0) return {};
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return undefined;
    }
  }

  const routes = [
    {
      kind: 'exact',
      path: `${ROUTE_PREFIX}/status`,
      handler: async (request, response) => {
        if (request.method !== 'GET') {
          sendJson(response, 405, { ok: false, error: 'method not allowed' });
          return;
        }
        const status = await describe();
        const health = await dohHealth();
        // Reading the status is also the self-heal point: a resolver that came
        // back after a transport failure is re-armed here.
        if (health.ok && !resolver.isPreferDoh()) resolver.setPreferDoh(true);
        sendJson(response, 200, { ...status, dohHealth: health });
      },
    },
    {
      kind: 'exact',
      path: `${ROUTE_PREFIX}/test`,
      handler: async (request, response) => {
        if (request.method !== 'POST') {
          sendJson(response, 405, { ok: false, error: 'method not allowed' });
          return;
        }
        const body = await readJsonBody(request);
        if (body === undefined) {
          sendJson(response, 400, { ok: false, error: 'malformed JSON body' });
          return;
        }
        sendJson(response, 200, await runTests(body.targets));
      },
    },
    {
      kind: 'exact',
      path: `${ROUTE_PREFIX}/config`,
      handler: async (request, response) => {
        if (request.method !== 'POST') {
          sendJson(response, 405, { ok: false, error: 'method not allowed' });
          return;
        }
        const body = await readJsonBody(request);
        if (body === undefined) {
          sendJson(response, 400, { ok: false, error: 'malformed JSON body' });
          return;
        }
        if (body.mode === 'auto' || body.mode === 'always') runtime.mode = body.mode;
        if (Array.isArray(body.extraHosts)) {
          extraHosts = body.extraHosts.map(String).filter(Boolean);
        }
        if (typeof body.enabled === 'boolean' && body.enabled !== runtime.enabled) {
          // A fresh start reads the new mode/extra hosts, so no reload is needed.
          await setEnabled(body.enabled);
        } else if (isActive()) {
          // The fetch patch captured the old mode and host set; reinstall it.
          await stop();
          await start();
        }
        persistState();
        sendJson(response, 200, { ok: true, enabled: runtime.enabled, trusted: runtime.trusted, active: isActive(), mode: runtime.mode });
      },
    },
    {
      kind: 'exact',
      path: `${ROUTE_PREFIX}/trust`,
      handler: async (request, response) => {
        if (request.method !== 'POST') {
          sendJson(response, 405, { ok: false, error: 'method not allowed' });
          return;
        }
        const body = await readJsonBody(request);
        if (body === undefined || typeof body.trusted !== 'boolean') {
          sendJson(response, 400, { ok: false, error: 'body must be { "trusted": boolean }' });
          return;
        }
        const trusted = await setTrusted(body.trusted);
        sendJson(response, 200, { ok: true, trusted, enabled: runtime.enabled, active: isActive(), caFilesPresent: caFilesPresent() });
      },
    },
    {
      kind: 'exact',
      path: `${ROUTE_PREFIX}/system-certs`,
      handler: async (request, response) => {
        if (request.method !== 'GET') {
          sendJson(response, 405, { ok: false, error: 'method not allowed' });
          return;
        }
        try {
          sendJson(response, 200, { ok: true, ...(await scanSystemStores()) });
        } catch (error) {
          sendJson(response, 500, { ok: false, error: error?.message || String(error) });
        }
      },
    },
    {
      kind: 'exact',
      path: `${ROUTE_PREFIX}/system-trust`,
      handler: async (request, response) => {
        if (request.method !== 'POST') {
          sendJson(response, 405, { ok: false, error: 'method not allowed' });
          return;
        }
        const body = await readJsonBody(request);
        if (body === undefined || typeof body.disabled !== 'boolean') {
          sendJson(response, 400, { ok: false, error: 'body must be { "disabled": boolean }' });
          return;
        }
        const result = await setSystemDisallowed(body.disabled);
        const after = await scanSystemStores();
        sendJson(response, result.ok ? 200 : 500, {
          ok: result.ok,
          result,
          // Trust is off when the certificate is in Disallowed, regardless of
          // whether it is still installed in Root.
          systemDisabled: after.systemDisabled,
          after,
        });
      },
    },
    {
      kind: 'exact',
      path: `${ROUTE_PREFIX}/system-certs/remove`,
      handler: async (request, response) => {
        if (request.method !== 'POST') {
          sendJson(response, 405, { ok: false, error: 'method not allowed' });
          return;
        }
        const body = await readJsonBody(request);
        if (body === undefined) {
          sendJson(response, 400, { ok: false, error: 'malformed JSON body' });
          return;
        }
        // Only ever touches a store that actually holds a certificate with our
        // exact thumbprint. The user store needs no elevation; the machine store
        // goes through one UAC prompt and removes nothing if it is declined.
        const scan = await scanSystemStores();
        const requestedStore = body.store === 'CA' ? 'CA' : 'Root';
        const machine = body.scope === 'machine';
        const target = scan.results.find(
          (entry) => entry.present && entry.withinUserScope === !machine && entry.store === requestedStore
        );
        if (!target) {
          sendJson(response, 404, { ok: false, error: '该证书库里没有这个根证书', scan });
          return;
        }
        const removed = machine ? await removeFromMachineStore(SCHOLAR_CA_PEM, target.store) : await removeFromUserStore(SCHOLAR_CA_PEM, target.store);
        const after = await scanSystemStores();
        sendJson(response, removed.ok ? 200 : 500, { ok: removed.ok, removed, after });
      },
    },
    {
      kind: 'exact',
      path: `${ROUTE_PREFIX}/ca.pem`,
      handler: async (request, response) => {
        const body = `${SCHOLAR_CA_PEM}\n`;
        response.writeHead(200, {
          'content-type': 'application/x-pem-file',
          'content-disposition': 'attachment; filename="scholar-root-ca.pem"',
          'content-length': Buffer.byteLength(body),
        });
        response.end(body);
      },
    },
    {
      kind: 'exact',
      path: `${ROUTE_PREFIX}/resolve`,
      handler: async (request, response) => {
        const url = new URL(request.url || '/', 'http://localhost');
        const host = url.searchParams.get('host') || '';
        if (!host) {
          sendJson(response, 400, { ok: false, error: 'host query parameter is required' });
          return;
        }
        sendJson(response, 200, await resolveHost(host));
      },
    },
  ];

  ctx.inject(['webServer'], (sctx) => {
    sctx.effect(() => {
      const disposers = routes.map((route) => sctx.webServer.register(route));
      return () => {
        for (const dispose of disposers) dispose();
      };
    }, 'scholar-access: settings bridge');
  });

  // The auto-generated config form would duplicate the plugin page's own
  // controls, so opt out of it when the settings service is present.
  ctx.inject(['settings'], (sctx) => {
    sctx.effect(() => sctx.settings.configure({ auto: false }, ctx.fiber), 'scholar-access: settings page');
  });

  logger?.info?.(`[scholar-access] ready (enabled=${runtime.enabled}, mode=${runtime.mode})`);
}

export const inject = [];
export const name = 'scholar-access';
