/**
 * A Git effect's push must recover when the remote branch moved after the
 * checkout's last push. A plain `git push` is rejected non-fast-forward, and
 * because the effect worker never pulls, every later push is rejected the same
 * way: write-through commits strand locally and their effects park.
 * Protects: publishGitEffect publishes through the shared-checkout protocol
 * (src/core/git/commit-push.ts, #6530): the rejected push is merged with the
 * remote in memory and the merge is pushed. The effect's own commit is never
 * rewritten and the checkout never moves (remote files reach it only through
 * `gbrain sources refresh`, which can fast-forward once the merge lands). A same-file change on both sides
 * stops with integrate_conflict and leaves the remote and the checkout as they
 * were. A managed canonical worktree (whose persistence owner is the effect
 * worker) gets the same recovery.
 * Seams: none; real repositories and a bare remote.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishGitEffect } from '../src/core/persistence/effect-git.ts';
import { gitChildEnv } from '../src/core/git-env.ts';

const dirs: string[] = [];
const clean = gitChildEnv();
const git = (root: string, ...args: string[]) =>
  execFileSync('git', ['-C', root, '-c', 'protocol.file.allow=always', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: clean }).trim();
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function clone(origin: string, name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `gbrain-diverged-${name}-`));
  dirs.push(dir);
  git(dir, 'clone', '-q', origin, '.');
  git(dir, 'config', 'user.name', name); git(dir, 'config', 'user.email', `${name}@example.invalid`);
  return dir;
}

/** A pushed base, then another writer advances the remote: `brain` is now behind it. */
function diverged(managed: boolean, otherPath: string) {
  const origin = mkdtempSync(join(tmpdir(), 'gbrain-diverged-origin-'));
  dirs.push(origin);
  git(origin, 'init', '-q', '--bare', '-b', 'main');
  const brain = clone(origin, 'brain');
  writeFileSync(join(brain, 'page.md'), 'base\n');
  git(brain, 'add', 'page.md'); git(brain, 'commit', '-qm', 'base'); git(brain, 'push', '-q', 'origin', 'HEAD:main');
  if (managed) writeFileSync(join(brain, '.git', 'gbrain-managed.json'), '{}\n');
  const other = clone(origin, 'other');
  writeFileSync(join(other, otherPath), 'from the other writer\n');
  git(other, 'add', otherPath); git(other, 'commit', '-qm', 'other writer'); git(other, 'push', '-q', 'origin', 'HEAD:main');
  return { origin, brain, base: git(brain, 'rev-parse', 'HEAD'), remote: git(other, 'rev-parse', 'HEAD') };
}

for (const managed of [false, true]) {
  describe(managed ? 'managed canonical worktree' : 'unmanaged checkout', () => {
    test('a push rejected because the remote moved is merged in memory and published on the same attempt', async () => {
      const { origin, brain, base, remote } = diverged(managed, 'other.md');
      writeFileSync(join(brain, 'page.md'), 'changed\n');
      expect(await publishGitEffect(brain, 'page.md', undefined, true)).toMatchObject({ git: 'committed', push: 'committed' });
      const committed = git(brain, 'rev-parse', 'HEAD');
      // The effect's commit is published as made (not rebased), merged with the other writer's commit.
      expect(git(brain, 'log', '-1', '--format=%P %s', committed)).toBe(`${base} gbrain: persist canonical memory update`);
      const tip = git(origin, 'rev-parse', 'main');
      expect(git(origin, 'rev-list', '--parents', '-n', '1', tip)).toBe(`${tip} ${committed} ${remote}`);
      // The worker never imports remote files: the checkout stays on its own commit, untouched.
      expect(existsSync(join(brain, 'other.md'))).toBe(false);
      expect(git(brain, 'status', '--porcelain')).toBe('');

      // The next effect publishes over the published merge the same way.
      writeFileSync(join(brain, 'next.md'), 'next\n');
      expect(await publishGitEffect(brain, 'next.md', undefined, true)).toMatchObject({ git: 'committed', push: 'committed' });
      const next = git(brain, 'rev-parse', 'HEAD');
      expect(git(brain, 'log', '-1', '--format=%P', next)).toBe(committed);
      const second = git(origin, 'rev-parse', 'main');
      expect(git(origin, 'rev-list', '--parents', '-n', '1', second)).toBe(`${second} ${next} ${tip}`);

      // History no longer diverges: the checkout fast-forwards to the remote (what `gbrain sources refresh` runs).
      git(brain, 'fetch', '-q', 'origin');
      git(brain, 'merge', '--ff-only', '-q', 'origin/main');
      expect(readFileSync(join(brain, 'other.md'), 'utf8')).toBe('from the other writer\n');
    });

    test('a same-file change on both sides stops with integrate_conflict and changes nothing', async () => {
      const { origin, brain, remote } = diverged(managed, 'page.md');
      writeFileSync(join(brain, 'page.md'), 'changed here\n');
      await expect(publishGitEffect(brain, 'page.md', undefined, true)).rejects.toMatchObject({ code: 'integrate_conflict' });
      expect(git(origin, 'rev-parse', 'main')).toBe(remote);
      expect(git(brain, 'log', '-1', '--format=%s')).toBe('gbrain: persist canonical memory update');
      expect(readFileSync(join(brain, 'page.md'), 'utf8')).toBe('changed here\n');
      expect(existsSync(join(brain, '.git', 'MERGE_HEAD'))).toBe(false);
    });
  });
}
