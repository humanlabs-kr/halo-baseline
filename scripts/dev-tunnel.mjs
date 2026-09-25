#!/usr/bin/env node
// Cloudflare named-tunnel runner for local development.
//
// Halo runs inside World App / MiniPay / Kaia webviews, which will not load
// http://localhost. A public https origin is required to test on a real device.
//
// The tunnel token is the only configuration: hostnames, ingress rules and
// routing live in the Cloudflare dashboard, not in this repo. That keeps internal
// hostnames out of version control and lets every developer use their own.
//
// Set CLOUDFLARE_TUNNEL_TOKEN in .env.local (gitignored). Without it this is a
// no-op so `pnpm dev` still works for anyone who does not need a tunnel.

import { config as loadEnv } from 'dotenv';
import { Tunnel } from 'cloudflared';
import path from 'node:path';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

loadEnv({ path: path.join(root, '.env') });
loadEnv({ path: path.join(root, '.env.local'), override: true });

const token = process.env.CLOUDFLARE_TUNNEL_TOKEN;
if (!token) {
  console.log('[tunnel] CLOUDFLARE_TUNNEL_TOKEN not set in .env.local — skipping tunnel.');
  process.exit(0);
}

// Default to http2: QUIC handshakes are blocked on many corporate networks and
// the failure mode is a silent hang. Override with CLOUDFLARE_TUNNEL_PROTOCOL.
const protocol = process.env.CLOUDFLARE_TUNNEL_PROTOCOL || 'http2';

console.log(`[tunnel] starting cloudflared (protocol=${protocol})…`);
const tunnel = Tunnel.withToken(token, { '--protocol': protocol });

tunnel.on('stdout', (data) => process.stdout.write(`[tunnel] ${data}`));
tunnel.on('stderr', (data) => process.stderr.write(`[tunnel] ${data}`));
tunnel.on('connected', (conn) => console.log(`[tunnel] connected (${conn.location} / ${conn.id})`));
tunnel.on('disconnected', (conn) => console.log(`[tunnel] disconnected (${conn.id})`));
tunnel.on('error', (err) => console.error('[tunnel] error:', err));
tunnel.on('exit', (code, signal) => {
  console.log(`[tunnel] exit (code=${code}, signal=${signal})`);
  process.exit(code ?? 0);
});

const shutdown = () => {
  console.log('[tunnel] stopping…');
  try {
    tunnel.stop();
  } catch {
    /* already stopped */
  }
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
