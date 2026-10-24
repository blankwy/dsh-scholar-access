// Local forward proxy used to carry child processes (git, npm, curl, pnpm, pip,
// huggingface-cli, node scripts) over the academic channel.
//
// It is a plain HTTP proxy on 127.0.0.1: `CONNECT host:443` is tunneled to the
// address our DoH resolver picked, so TLS stays end-to-end between the child and
// the channel proxy and no certificate is minted locally. Plain absolute-URI
// HTTP requests are forwarded the same way.

import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import { isChannelAddress, isChannelCandidate } from './network.js';

const HOP_BY_HOP = new Set([
  'connection',
  'proxy-connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function splitHostPort(value, fallbackPort) {
  const trimmed = String(value || '').trim();
  const bracket = /^\[(.+)\]:(\d+)$/.exec(trimmed);
  if (bracket) return { host: bracket[1], port: Number(bracket[2]) };
  const index = trimmed.lastIndexOf(':');
  if (index > 0 && trimmed.indexOf(':') === index) {
    return { host: trimmed.slice(0, index), port: Number(trimmed.slice(index + 1)) || fallbackPort };
  }
  return { host: trimmed, port: fallbackPort };
}

export function createChannelProxy({ resolver, logger, host = '127.0.0.1', port = 0, onEvent } = {}) {
  const stats = { connect: 0, forward: 0, errors: 0, channel: 0 };

  const server = http.createServer((request, response) => {
    let target;
    try {
      target = new URL(request.url || '');
    } catch {
      response.writeHead(400, { 'content-type': 'text/plain' });
      response.end('scholar-access proxy: absolute URL required');
      return;
    }
    if (target.protocol !== 'http:') {
      response.writeHead(400, { 'content-type': 'text/plain' });
      response.end('scholar-access proxy: only http:// forward requests are supported here');
      return;
    }
    stats.forward += 1;
    resolver
      .resolve(target.hostname)
      .then((resolution) => {
        if (resolution.channel) stats.channel += 1;
        onEvent?.({ kind: 'forward', hostname: target.hostname, resolution });
        const headers = {};
        for (const [key, value] of Object.entries(request.headers)) {
          if (HOP_BY_HOP.has(key.toLowerCase())) continue;
          headers[key] = value;
        }
        headers.host = target.host;
        const upstream = http.request(
          {
            host: resolution.address,
            port: Number(target.port || 80),
            path: `${target.pathname}${target.search}`,
            method: request.method,
            headers,
            lookup: (_hostname, _options, callback) => callback(null, resolution.address, 4),
          },
          (upstreamResponse) => {
            response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
            upstreamResponse.pipe(response);
          }
        );
        upstream.on('error', (error) => {
          stats.errors += 1;
          if (!response.headersSent) response.writeHead(502, { 'content-type': 'text/plain' });
          response.end(`scholar-access proxy upstream error: ${error.message}`);
        });
        request.pipe(upstream);
      })
      .catch((error) => {
        stats.errors += 1;
        response.writeHead(502, { 'content-type': 'text/plain' });
        response.end(`scholar-access proxy resolve error: ${error.message}`);
      });
  });

  server.on('connect', (request, clientSocket, head) => {
    const { host, port: targetPort } = splitHostPort(request.url, 443);
    stats.connect += 1;
    clientSocket.on('error', () => {});
    const fail = (error) => {
      stats.errors += 1;
      logger?.debug?.(`[scholar-access] proxy CONNECT ${host} failed: ${error.message}`);
      if (!clientSocket.destroyed) {
        clientSocket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain\r\n\r\n' + error.message);
      }
    };
    resolver
      .resolve(host)
      .then((resolution) => {
        if (resolution.channel) stats.channel += 1;
        onEvent?.({ kind: 'connect', hostname: host, resolution });
        const upstream = net.connect({ host: resolution.address, port: targetPort }, () => {
          clientSocket.write('HTTP/1.1 200 Connection Established\r\nProxy-Agent: dsh-scholar-access\r\n\r\n');
          if (head && head.length) upstream.write(head);
          upstream.pipe(clientSocket);
          clientSocket.pipe(upstream);
        });
        upstream.on('error', fail);
        clientSocket.on('close', () => upstream.destroy());
        upstream.on('close', () => clientSocket.destroy());
      })
      .catch(fail);
  });

  server.on('clientError', (error, socket) => {
    if (!socket.destroyed) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const address = server.address();
      const actualPort = typeof address === 'object' && address ? address.port : port;
      resolve({
        server,
        port: actualPort,
        url: `http://${host}:${actualPort}`,
        stats,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections?.();
            server.close(() => done());
          }),
      });
    });
  });
}

export { isChannelAddress, isChannelCandidate };
