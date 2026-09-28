/**
 * #5660: a take row promoted onto a page's physical markdown fence via
 * takes-write.ts's file-only write-through (e.g. `takes propose --accept`,
 * which calls addTakeToPage directly) never lands in pages.compiled_truth --
 * only the file and the `takes` table get it. prepareTakesMutation used to
 * reconstruct its working body from compiled_truth, so any such row was
 * invisible to a later takes_update/supersede/resolve, which always failed
 * with a spurious row_not_found ("Row #N not found") even though the row
 * genuinely existed on disk and in the takes table.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { withEnv } from './helpers/with-env.ts';
import { makeGitFixture } from './helpers/git-fixture.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall as dispatchToolCallImpl } from '../src/mcp/dispatch.ts';
import { runSources } from '../src/commands/sources.ts';
import { upsertTakeRow } from '../src/core/takes-fence.ts';

let engine: PGLiteEngine;
let repoDir: string;
const home = mkdtempSync(join(tmpdir(), 'gbrain-takes-fence-desync-'));
const SRC = 'takesdesyncsrc';
const SLUG = 'notes/takes-fence-desync';

async function dispatchToolCall(...args: Parameters<typeof dispatchToolCallImpl>) {
  return withEnv({ GBRAIN_HOME: home }, async () => {
    try { return await dispatchToolCallImpl(...args); }
    finally { await disposePersistenceConsumer(args[0]); }
  });
}
function payload(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0]!.text);
}
const LOCAL_CLI = { remote: false, sourceId: SRC };

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  mkdirSync(join(home, '.gbrain'));
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', embedding_disabled: true }));
  repoDir = mkdtempSync(join(tmpdir(), 'gbrain-takes-fence-desync-repo-'));
  const fixture = await makeGitFixture(repoDir);
  writeFileSync(join(repoDir, 'README.md'), '# fixture\n');
  fixture.commitAll('seed');
  await runSources(engine, ['add', SRC, '--path', repoDir, '--no-federated']);
}, 120_000);

afterAll(async () => {
  await disposePersistenceConsumer(engine);
  await engine.disconnect();
  rmSync(home, { recursive: true, force: true });
  rmSync(repoDir, { recursive: true, force: true });
}, 30_000);

test('a take fence written straight to the file (compiled_truth left untouched) is still visible to takes_update', async () => {
  const created = await dispatchToolCall(engine, 'put_page', { slug: SLUG, content: '# Desync repro\nbody text' }, LOCAL_CLI);
  expect(created.isError).toBeUndefined();

  const path = join(repoDir, `${SLUG}.md`);
  const before = readFileSync(path, 'utf-8');
  // Same fence-insertion primitive addTakeToPage itself calls, so the
  // injected fence (including its "## Takes" heading) exactly matches what
  // production's file-only write-through actually produces.
  const { body: withFence, rowNum } = upsertTakeRow(before, {
    claim: 'a take promoted straight to the file', kind: 'take', holder: 'world', weight: 0.5, active: true,
  });
  writeFileSync(path, withFence);

  const pageId = payload(await dispatchToolCall(engine, 'get_page', { slug: SLUG }, LOCAL_CLI)).id;
  await engine.addTakesBatch([{
    page_id: pageId, row_num: rowNum, claim: 'a take promoted straight to the file',
    kind: 'take', holder: 'world', weight: 0.5, active: true,
  }]);

  // Confirms the desync: the DB's compiled_truth genuinely never got the fence.
  const snapshot = await engine.readPageSnapshot(SLUG, { sourceId: SRC });
  expect(snapshot?.page.compiled_truth.includes('gbrain:takes:begin')).toBe(false);

  const updated = await dispatchToolCall(engine, 'takes_update', {
    slug: SLUG, row_num: rowNum, weight: 0.9,
  }, LOCAL_CLI);
  expect(updated.isError).toBeUndefined();
});
