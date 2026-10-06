/**
 * `oauth.dcr_default_source` through the production startup path: the config
 * key is stored in the brain, `buildServeHttpApp` resolves it and hands it to
 * the OAuth provider, and a client that self-registers over real HTTP
 * (`POST /register`) is persisted on that source.
 *
 * Fails when: `buildServeHttpApp` stops resolving the key, drops the provider
 * option, or the registration route stops using the provider's source. The
 * unit tests in oauth-dcr-default-source.test.ts pass the option by hand and
 * would stay green through any of those.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Server } from 'node:http';
import express from 'express';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { buildServeHttpApp } from '../src/commands/serve-http.ts';

let engine: PGLiteEngine;
const closers: Array<() => Promise<void>> = [];

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('wiki', 'wiki')`);
});

afterAll(async () => {
  for (const close of closers) await close();
  await engine.disconnect();
});

async function startApp(): Promise<string> {
  const app = express();
  const server: Server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('expected a TCP address');
  const base = `http://127.0.0.1:${address.port}`;
  await buildServeHttpApp(app, engine, {
    port: address.port, tokenTtl: 3600, enableDcr: true, publicUrl: base,
  });
  closers.push(() => new Promise(resolve => { server.closeAllConnections?.(); server.close(() => resolve()); }));
  return base;
}

async function selfRegister(base: string): Promise<{ source_id: string; federated_read: string[] }> {
  const res = await fetch(`${base}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'dcr-default-source-route-test',
      redirect_uris: ['https://example.test/callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      scope: 'read',
      token_endpoint_auth_method: 'none',
    }),
  });
  expect(res.status).toBe(201);
  const { client_id } = (await res.json()) as { client_id: string };
  const [row] = await engine.executeRaw<{ source_id: string; federated_read: string[] }>(
    'SELECT source_id, federated_read FROM oauth_clients WHERE client_id = $1',
    [client_id],
  );
  return row!;
}

describe('POST /register source', () => {
  test('oauth.dcr_default_source set: the registered client lands on that source', async () => {
    await engine.setConfig('oauth.dcr_default_source', 'wiki');
    const row = await selfRegister(await startApp());
    expect(row.source_id).toBe('wiki');
    expect(row.federated_read).toEqual(['wiki']);
  });

  test('oauth.dcr_default_source unset: the registered client lands on default', async () => {
    await engine.unsetConfig('oauth.dcr_default_source');
    const row = await selfRegister(await startApp());
    expect(row.source_id).toBe('default');
    expect(row.federated_read).toEqual(['default']);
  });
});
