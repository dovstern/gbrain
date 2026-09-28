/** The fence write in takes-write.ts must land in git, the same as every
 * other durable write-through path (put_page/delete_page/restore_page) —
 * not just sit on disk. Regression coverage for the gap where addTakeToPage
 * et al. wrote the file but never committed it.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { makeGitFixture, type GitFixture } from './helpers/git-fixture.ts';
import { serializePageToMarkdown } from '../src/core/markdown.ts';
import { addTakeToPage, updateTakeOnPage, type TakesWriteTarget } from '../src/core/takes-write.ts';

let engine: PGLiteEngine;
let repo: string;
let fixture: GitFixture;

function commitCount(): number {
  return Number(execFileSync('git', ['-C', repo, 'rev-list', '--count', 'HEAD'], { encoding: 'utf8' }).trim());
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  repo = mkdtempSync(join(tmpdir(), 'gbrain-takes-commit-'));
  fixture = await makeGitFixture(repo);
});
afterAll(async () => { await engine.disconnect(); rmSync(repo, { recursive: true, force: true }); });

test('addTakeToPage commits the fence write to git, not just the filesystem', async () => {
  const slug = 'notes/commit-through-example';
  await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: 'about it' });
  const snapshot = (await engine.readPageSnapshot(slug))!;
  const path = join(repo, `${slug}.md`);
  execFileSync('mkdir', ['-p', join(repo, 'notes')]);
  await Bun.write(path, serializePageToMarkdown(snapshot.page, snapshot.tags));
  fixture.commitAll('seed page');
  const before = commitCount();

  const target: TakesWriteTarget = { engine, slug, brainDir: repo };
  const result = await addTakeToPage(target, { claim: 'this take should be committed', kind: 'take', holder: 'world' });

  expect(result.mirror.commit_warning).toBeUndefined();
  expect(commitCount()).toBe(before + 1);
  const log = execFileSync('git', ['-C', repo, 'log', '-1', '--format=%s'], { encoding: 'utf8' }).trim();
  expect(log).toContain(slug);
  // Working tree must be clean — the write-through commit, not a pending diff.
  expect(execFileSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8' }).trim()).toBe('');

  // A second mutation (updateTakeOnPage) must also commit its own write.
  const before2 = commitCount();
  const update = await updateTakeOnPage(target, result.rowNum, { weight: 0.9 });
  expect(update.mirror.commit_warning).toBeUndefined();
  expect(commitCount()).toBe(before2 + 1);
});

test('a non-git writeRoot surfaces commit_warning without failing the write', async () => {
  const plainDir = mkdtempSync(join(tmpdir(), 'gbrain-takes-nogit-'));
  try {
    const slug = 'notes/no-git-root';
    await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: 'about it' });
    const snapshot = (await engine.readPageSnapshot(slug))!;
    await Bun.write(join(plainDir, `${slug}.md`), serializePageToMarkdown(snapshot.page, snapshot.tags));
    const target: TakesWriteTarget = { engine, slug, brainDir: plainDir };
    const result = await addTakeToPage(target, { claim: 'still written even without git', kind: 'take', holder: 'world' });
    expect(result.mirror.written).toBe(true);
    expect(result.mirror.commit_warning).toContain('commit_failed');
  } finally { rmSync(plainDir, { recursive: true, force: true }); }
});
