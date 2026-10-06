import { pgliteOAuthTransaction } from './helpers/oauth.ts';
/**
 * DCR default source: a self-registered client lands on the `default` source
 * unless the operator names another one with `oauth.dcr_default_source`.
 *
 * Covers the store boundary (what `registerClient` persists) and the startup
 * resolver (`resolveDcrDefaultSource`: config read + source validation).
 * Setup mirrors test/oauth-dcr-ttl.test.ts (in-memory PGLite).
 */
import { describe, test, expect, beforeAll, afterAll, spyOn } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { GBrainOAuthProvider, resolveDcrDefaultSource } from '../src/core/oauth-provider.ts';
import { PGLITE_SCHEMA_SQL } from '../src/core/pglite-schema.ts';
import { KNOWN_CONFIG_KEYS } from '../src/core/config.ts';

let db: PGlite;
let sql: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<any>;

beforeAll(async () => {
  db = new PGlite({ extensions: { vector, pg_trgm } });
  await db.exec(PGLITE_SCHEMA_SQL);
  sql = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.reduce((acc, str, i) => acc + str + (i < values.length ? `$${i + 1}` : ''), '');
    const result = await db.query(query, values as any[]);
    return result.rows;
  };
  await db.query(`INSERT INTO sources (id, name) VALUES ('wiki', 'wiki'), ('retired', 'retired')`);
  await db.query(`UPDATE sources SET archived = true WHERE id = 'retired'`);
}, 30_000);

afterAll(async () => {
  if (db) await db.close();
}, 15_000);

const DCR_METADATA = {
  client_name: 'dcr-default-source-test',
  redirect_uris: ['https://example.test/callback'],
  grant_types: ['authorization_code', 'refresh_token'],
  scope: 'read',
  token_endpoint_auth_method: 'none',
} as any;

function makeProvider(dcrDefaultSourceId?: string) {
  return new GBrainOAuthProvider({ transaction: pgliteOAuthTransaction(db), sql, tokenTtl: 60, dcrDefaultSourceId });
}

async function registeredScope(provider: GBrainOAuthProvider) {
  const info = await provider.clientsStore.registerClient!({ ...DCR_METADATA });
  const [row] = await sql`SELECT source_id, federated_read FROM oauth_clients WHERE client_id = ${info.client_id}`;
  return row;
}

describe('registerClient source', () => {
  test('unset: the client lands on the default source (unchanged behavior)', async () => {
    const row = await registeredScope(makeProvider());
    expect(row.source_id).toBe('default');
    expect(row.federated_read).toEqual(['default']);
  });

  test('configured: the client writes to and reads from the named source', async () => {
    const row = await registeredScope(makeProvider('wiki'));
    expect(row.source_id).toBe('wiki');
    expect(row.federated_read).toEqual(['wiki']);
  });
});

describe('resolveDcrDefaultSource', () => {
  const engineWith = (value: string | null) => ({
    getConfig: async (key: string) => (key === 'oauth.dcr_default_source' ? value : null),
    executeRaw: async <T>(query: string, params?: unknown[]) =>
      (await db.query(query, params as any[])).rows as T[],
  });

  test('unset or blank resolves to undefined (provider falls back to default)', async () => {
    expect(await resolveDcrDefaultSource(engineWith(null))).toBeUndefined();
    expect(await resolveDcrDefaultSource(engineWith('  '))).toBeUndefined();
  });

  test('an existing source resolves to its id', async () => {
    expect(await resolveDcrDefaultSource(engineWith('wiki'))).toBe('wiki');
  });

  test('a missing or archived source warns and resolves to undefined', async () => {
    const warn = spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await resolveDcrDefaultSource(engineWith('ghost'))).toBeUndefined();
      expect(await resolveDcrDefaultSource(engineWith('retired'))).toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(2);
      expect(String(warn.mock.calls[0]![0])).toContain('oauth.dcr_default_source');
    } finally {
      warn.mockRestore();
    }
  });

  test('the key is registered so `gbrain config set` accepts it', () => {
    expect(KNOWN_CONFIG_KEYS).toContain('oauth.dcr_default_source');
  });
});
