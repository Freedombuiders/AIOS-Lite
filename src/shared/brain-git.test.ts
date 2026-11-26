import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { authorIdent, combineMessages, createBrainGit, createCommitQueue, type BrainGit, type CommitResult } from './brain-git.js';
import { testLog, tmpDir, writeFile } from './test-kit.js';

const git = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();

function repo(): string {
  const dir = tmpDir('aios-git-');
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.name', 'Chủ shop');
  git(dir, 'config', 'user.email', 'chu@example.test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  writeFile(path.join(dir, 'a.md'), 'một\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'đầu tiên');
  return dir;
}

const count = (dir: string) => Number(git(dir, 'rev-list', '--count', 'HEAD'));

describe('brain git', () => {
  it('commits exactly the given paths, with the actor as author', async () => {
    const dir = repo();
    const g = createBrainGit();
    expect(await g.isRepo(dir)).toBe(true);
    writeFile(path.join(dir, 'a.md'), 'hai\n');
    writeFile(path.join(dir, 'moi/b.md'), 'mới\n');
    writeFile(path.join(dir, 'cua-chu.md'), 'chủ đang viết dở\n'); // not ours: must stay out of the commit
    const r = await g.commit(dir, ['a.md', 'moi/b.md'], 'Bot cập nhật', 'agent:bot-cham');
    expect(r.status).toBe('committed');
    expect(count(dir)).toBe(2);
    expect(git(dir, 'show', '--name-only', '--format=%an|%ae|%s', 'HEAD').split('\n')).toEqual(['agent:bot-cham|agent-bot-cham@aios.local|Bot cập nhật', '', 'a.md', 'moi/b.md']);
    expect(git(dir, 'status', '--porcelain')).toBe('?? cua-chu.md');
    // nothing changed → no empty commit
    expect((await g.commit(dir, ['a.md'], 'lại', 'system')).status).toBe('nothing');
    // a deleted file is committed as a deletion
    fs.unlinkSync(path.join(dir, 'moi/b.md'));
    expect((await g.commit(dir, ['moi/b.md'], 'xoá', 'owner')).status).toBe('committed');
    expect(git(dir, 'ls-files')).toBe('a.md');
  });

  it('does nothing outside a repo, and never commits into a parent repo', async () => {
    const g = createBrainGit();
    const plain = tmpDir();
    writeFile(path.join(plain, 'a.md'), 'x');
    expect(await g.isRepo(plain)).toBe(false);
    expect(await g.commit(plain, ['a.md'], 'x', 'system')).toEqual({ status: 'not-repo' });
    expect(fs.existsSync(path.join(plain, '.git'))).toBe(false);
    const dir = repo();
    writeFile(path.join(dir, 'con/c.md'), 'x');
    expect(await g.isRepo(path.join(dir, 'con'))).toBe(false);
    expect((await g.commit(path.join(dir, 'con'), ['c.md'], 'x', 'system')).status).toBe('not-repo');
    expect(count(dir)).toBe(1);
    expect(g.history(plain, 'a.md')).toEqual([]);
  });

  it('passes messages and names with shell characters through untouched', async () => {
    const dir = repo();
    const g = createBrainGit();
    const msg = 'Sửa "giá"; rm -rf / && echo $(whoami) `id` | cat > /tmp/x \'nháy\' \\\n\ndòng hai';
    const name = 'tên lạ; $(id) `x`.md';
    writeFile(path.join(dir, name), 'x\n');
    writeFile(path.join(dir, '-n.md'), 'x\n');
    const r = await g.commit(dir, [name, '-n.md'], msg, 'agent:a"b<c>');
    expect(r.status).toBe('committed');
    expect(git(dir, 'log', '-1', '--format=%B')).toBe(msg.trim());
    expect(git(dir, 'log', '-1', '--format=%an')).toBe('agent:a"bc');
    expect(git(dir, '-c', 'core.quotepath=false', 'show', '--name-only', '--format=', 'HEAD').split('\n').sort()).toEqual(['-n.md', name].sort());
  });

  it('reads history and the content before a commit', async () => {
    const dir = repo();
    const g = createBrainGit();
    writeFile(path.join(dir, 'a.md'), 'hai\n');
    const r = (await g.commit(dir, ['a.md'], 'lần hai', 'system')) as Extract<CommitResult, { status: 'committed' }>;
    const h = g.history(dir, 'a.md');
    expect(h.map((c) => c.message)).toEqual(['lần hai', 'đầu tiên']);
    expect(h[0]).toMatchObject({ hash: r.hash, author: 'system' });
    expect(g.contentBefore(dir, 'a.md', r.hash)).toBe('một\n');
    expect(g.contentBefore(dir, 'khong-co.md', r.hash)).toBeUndefined();
    expect(() => g.contentBefore(dir, 'a.md', '--all')).toThrow();
    expect(() => g.contentBefore(dir, 'a.md', 'deadbeef')).toThrow();
  });

  it('serialises quick commits in the same repo', async () => {
    const dir = repo();
    const g = createBrainGit();
    const all = await Promise.all(
      Array.from({ length: 6 }, (_, i) => {
        writeFile(path.join(dir, `f${i}.md`), `${i}\n`);
        return g.commit(dir, [`f${i}.md`], `ghi ${i}`, 'system');
      }),
    );
    expect(all.map((r) => r.status)).toEqual(Array(6).fill('committed'));
    expect(count(dir)).toBe(7);
  });

  it('builds a git ident from any actor', () => {
    expect(authorIdent('module:crm')).toBe('module:crm <module-crm@aios.local>');
    expect(authorIdent('<>')).toBe('aios <aios@aios.local>');
  });
});

describe('commit queue', () => {
  it('coalesces writes within the window into one commit', async () => {
    const dir = repo();
    const q = createCommitQueue({ git: createBrainGit(), log: testLog, windowMs: 60_000 });
    for (const n of ['x', 'y', 'z']) {
      writeFile(path.join(dir, `${n}.md`), n);
      q.add(dir, [`${n}.md`], `ghi ${n}`, 'module:crm');
    }
    expect(count(dir)).toBe(1);
    await q.flush();
    expect(count(dir)).toBe(2);
    expect(git(dir, 'log', '-1', '--format=%an|%s')).toBe('module:crm|AIOS ghi 3 ghi chú');
    expect(git(dir, 'log', '-1', '--format=%b')).toBe('- ghi x\n- ghi y\n- ghi z');
  });

  it('commits after the window by itself', async () => {
    const dir = repo();
    const q = createCommitQueue({ git: createBrainGit(), log: testLog, windowMs: 30 });
    writeFile(path.join(dir, 'x.md'), 'x');
    q.add(dir, ['x.md'], 'ghi x', 'owner');
    await new Promise((r) => setTimeout(r, 400));
    await q.flush();
    expect(git(dir, 'log', '-1', '--format=%s')).toBe('ghi x');
  });

  it('keeps failed paths for the next commit and reports the failure once', async () => {
    const calls: string[][] = [];
    let fail = 2;
    const fake: BrainGit = {
      isRepo: async () => true,
      commit: async (_d, paths) => {
        calls.push([...paths].sort());
        return fail-- > 0 ? { status: 'failed', error: 'index.lock' } : { status: 'committed', hash: 'abc' };
      },
      history: () => [],
      contentBefore: () => undefined,
    };
    const errors: string[] = [];
    const recovered: string[] = [];
    const q = createCommitQueue({ git: fake, log: testLog, windowMs: 60_000, onError: (d, e) => errors.push(`${d}:${e}`), onRecovered: (d) => recovered.push(d) });
    q.add('/v', ['a.md'], 'a', 'x');
    await q.flush();
    q.add('/v', ['b.md'], 'b', 'x');
    await q.flush();
    expect(errors).toEqual(['/v:index.lock']);
    expect(await q.commitNow('/v', ['c.md'], 'lô', 'x')).toEqual({ status: 'committed', hash: 'abc' });
    expect(calls).toEqual([['a.md'], ['a.md', 'b.md'], ['a.md', 'b.md', 'c.md']]);
    expect(recovered).toEqual(['/v']);
  });

  it('summarises several messages', () => {
    expect(combineMessages(['a', 'a'], 2)).toBe('a');
    expect(combineMessages(['a', 'b'], 2)).toBe('AIOS ghi 2 ghi chú\n\n- a\n- b');
  });
});
