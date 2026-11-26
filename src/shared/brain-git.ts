// Git history for brain folders, so machine writes can be undone.
//
// - git runs through execFile with an argument array, never a shell.
// - A folder counts as a repo only when it is itself the top of a git work tree: we never `git init`, and never
//   commit into a parent repo (the app's own checkout holds the sample brain).
// - Only the paths the notes service wrote are staged; never `git add -A` on the folder.
// - Commands are serialised per folder (no race on .git/index.lock), and writes inside a short window are
//   coalesced into one commit (createCommitQueue). A failed commit leaves the files as written; its paths are
//   retried with the next commit.
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Logger } from '../core/log.js';

export interface BrainCommit {
  hash: string;
  at: string;
  author: string;
  message: string;
}

export type CommitResult =
  | { status: 'committed'; hash: string }
  | { status: 'nothing' }
  | { status: 'not-repo' }
  | { status: 'failed'; error: string };

export interface BrainGit {
  /** true when `dir` is the top level of a git work tree */
  isRepo(dir: string): Promise<boolean>;
  /** Stage exactly `paths` (relative to dir; new, changed or deleted) and commit them, nothing else. */
  commit(dir: string, paths: string[], message: string, author: string): Promise<CommitResult>;
  /** Newest first; `[]` when dir is not a repo. Commits still queued are not included. */
  history(dir: string, relPath: string, limit?: number): BrainCommit[];
  /** File content just before commit `hash` (at hash^), or undefined when it did not exist there. Throws on a bad hash. */
  contentBefore(dir: string, relPath: string, hash: string): string | undefined;
}

const GIT_TIMEOUT_MS = 30_000;
const HASH_RE = /^[0-9a-f]{4,64}$/i;
/** no prompts, no pager, no editor */
const SAFE_ENV = { GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', GIT_EDITOR: 'true' };
/** no signing prompt; paths printed as-is (Vietnamese file names) */
const SAFE_CONFIG = ['-c', 'commit.gpgsign=false', '-c', 'core.quotepath=false'];

/** `bot-cham` → `bot-cham <bot-cham@aios.local>`; strips what would break the ident format. */
export function authorIdent(actor: string): string {
  const name = actor.replace(/[<>\r\n\0]/g, '').trim() || 'aios';
  const local = name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'aios';
  return `${name} <${local}@aios.local>`;
}

interface Out {
  code: number;
  stdout: string;
  stderr: string;
}

function run(dir: string, args: string[], env: Record<string, string> = {}): Promise<Out> {
  return new Promise((resolve) => {
    execFile(
      'git',
      [...SAFE_CONFIG, ...args],
      { cwd: dir, timeout: GIT_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, ...SAFE_ENV, ...env }, windowsHide: true },
      (err, stdout, stderr) => {
        const code = !err ? 0 : typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : -1;
        resolve({ code, stdout: String(stdout), stderr: code === -1 && err ? `${err.message}\n${String(stderr)}` : String(stderr) });
      },
    );
  });
}

function runSync(dir: string, args: string[]): string | undefined {
  try {
    return execFileSync('git', [...SAFE_CONFIG, ...args], {
      cwd: dir,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, ...SAFE_ENV },
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    }).toString('utf8');
  } catch {
    return undefined;
  }
}

function realOf(dir: string): string {
  try {
    return fs.realpathSync(dir);
  } catch {
    return dir;
  }
}

function isTopLevel(dir: string, top: string | undefined): boolean {
  return !!top && realOf(top.trim()) === realOf(dir);
}

export function createBrainGit(): BrainGit {
  const lanes = new Map<string, Promise<unknown>>();

  /** one git command chain at a time per repo */
  function serial<T>(dir: string, job: () => Promise<T>): Promise<T> {
    const key = realOf(dir);
    const next = (lanes.get(key) ?? Promise.resolve()).then(job, job);
    const tail = next.then(
      () => undefined,
      () => undefined,
    );
    lanes.set(key, tail);
    void tail.then(() => {
      if (lanes.get(key) === tail) lanes.delete(key);
    });
    return next;
  }

  async function isRepo(dir: string): Promise<boolean> {
    const r = await run(dir, ['rev-parse', '--show-toplevel']);
    return r.code === 0 && isTopLevel(dir, r.stdout);
  }

  /** git refuses to commit without an identity: give the committer one only when the repo has none */
  async function committerEnv(dir: string): Promise<Record<string, string>> {
    const [email, name] = await Promise.all([run(dir, ['config', 'user.email']), run(dir, ['config', 'user.name'])]);
    const env: Record<string, string> = {};
    if (email.code !== 0 || !email.stdout.trim()) env.GIT_COMMITTER_EMAIL = 'aios@aios.local';
    if (name.code !== 0 || !name.stdout.trim()) env.GIT_COMMITTER_NAME = 'AIOS';
    return env;
  }

  return {
    isRepo,

    commit(dir, paths, message, author) {
      return serial(dir, async (): Promise<CommitResult> => {
        if (!(await isRepo(dir))) return { status: 'not-repo' };
        const files = [...new Set(paths)].filter(Boolean);
        if (!files.length) return { status: 'nothing' };
        const present = files.filter((p) => fs.existsSync(path.join(dir, p)));
        const gone = files.filter((p) => !present.includes(p));
        if (present.length) {
          const add = await run(dir, ['add', '--', ...present]);
          if (add.code !== 0) return { status: 'failed', error: add.stderr.trim() };
        }
        if (gone.length) {
          const rm = await run(dir, ['rm', '--cached', '--ignore-unmatch', '-q', '--', ...gone]);
          if (rm.code !== 0) return { status: 'failed', error: rm.stderr.trim() };
        }
        const changed = await run(dir, ['diff', '--cached', '--name-only', '-z', '--', ...files]);
        if (changed.code !== 0) return { status: 'failed', error: changed.stderr.trim() };
        const toCommit = changed.stdout.split('\0').filter(Boolean);
        if (!toCommit.length) return { status: 'nothing' };
        const env = await committerEnv(dir);
        // `commit -- <paths>` commits only these paths, whatever else the person has staged
        const c = await run(dir, ['commit', '--no-verify', '-q', '-m', message.trim() || 'AIOS ghi ghi chú', `--author=${authorIdent(author)}`, '--', ...toCommit], env);
        if (c.code !== 0) return { status: 'failed', error: (c.stderr || c.stdout).trim().slice(0, 500) };
        const head = await run(dir, ['rev-parse', 'HEAD']);
        return head.code === 0 ? { status: 'committed', hash: head.stdout.trim() } : { status: 'failed', error: head.stderr.trim() };
      });
    },

    history(dir, relPath, limit = 20) {
      if (!isTopLevel(dir, runSync(dir, ['rev-parse', '--show-toplevel']))) return [];
      const n = Math.max(1, Math.min(200, Math.floor(limit)));
      const out = runSync(dir, ['log', `-n${n}`, '--format=%H%x1f%aI%x1f%an%x1f%s%x1e', '--', relPath]);
      if (!out) return [];
      return out
        .split('\x1e')
        .map((r) => r.trim())
        .filter(Boolean)
        .map((r) => {
          const [hash = '', at = '', a = '', msg = ''] = r.split('\x1f');
          return { hash, at, author: a, message: msg };
        });
    },

    contentBefore(dir, relPath, hash) {
      if (!HASH_RE.test(hash)) throw new Error('Mã commit không hợp lệ.');
      if (!isTopLevel(dir, runSync(dir, ['rev-parse', '--show-toplevel']))) throw new Error('Thư mục brain chưa là kho git.');
      if (runSync(dir, ['cat-file', '-e', `${hash}^{commit}`]) === undefined) throw new Error(`Không có commit ${hash}.`);
      return runSync(dir, ['show', `${hash}^:${relPath}`]);
    },
  };
}

// ---------------------------------------------------------------- coalescing queue

export interface CommitQueue {
  /** Queue paths written in `dir`; committed together with everything else written within the window. */
  add(dir: string, paths: string[], message: string, author: string): void;
  /** Commit these paths now, as one commit with this message (notes.batch). */
  commitNow(dir: string, paths: string[], message: string, author: string): Promise<CommitResult>;
  /** Commit everything queued, now (shutdown, tests). */
  flush(): Promise<void>;
  /** flush, then stop scheduling */
  stop(): Promise<void>;
}

export interface CommitQueueOptions {
  git: BrainGit;
  log: Logger;
  /** default 2000 ms */
  windowMs?: number;
  /** a commit failed (the files are written; paths are retried with the next commit) */
  onError?(dir: string, error: string): void;
  /** a commit (or a retry) went through after an error */
  onRecovered?(dir: string): void;
}

interface Pending {
  paths: Set<string>;
  messages: string[];
  authors: Set<string>;
  timer?: NodeJS.Timeout;
}

/** One message for several writes: the message itself when they agree, else a summary with one line each. */
export function combineMessages(messages: string[], count: number): string {
  const uniq = [...new Set(messages.map((m) => m.trim()).filter(Boolean))];
  if (uniq.length === 1) return uniq[0]!;
  const lines = uniq.slice(0, 50).map((m) => `- ${m.split('\n')[0]}`);
  if (uniq.length > 50) lines.push(`- … và ${uniq.length - 50} thay đổi khác`);
  return `AIOS ghi ${count} ghi chú\n\n${lines.join('\n')}`;
}

export function createCommitQueue(opts: CommitQueueOptions): CommitQueue {
  const { git, log } = opts;
  const windowMs = opts.windowMs ?? 2000;
  const pending = new Map<string, Pending>();
  const failing = new Set<string>();
  const notRepo = new Set<string>();
  const inflight = new Set<Promise<unknown>>();
  let stopped = false;

  function report(dir: string, r: CommitResult, retry: { paths: Iterable<string>; messages: string[]; authors: Iterable<string> }): void {
    if (r.status === 'not-repo') {
      if (!notRepo.has(dir)) {
        notRepo.add(dir);
        log.info({ dir }, 'Thư mục brain chưa là kho git, bỏ qua bước commit');
      }
      return;
    }
    notRepo.delete(dir);
    if (r.status === 'failed') {
      log.warn({ dir, err: r.error }, 'git commit lỗi; file đã ghi vẫn giữ, sẽ thử lại ở lần commit sau');
      // keep the paths for the next commit in this folder
      const p = pending.get(dir) ?? { paths: new Set<string>(), messages: [], authors: new Set<string>() };
      for (const x of retry.paths) p.paths.add(x);
      p.messages.push(...retry.messages);
      for (const a of retry.authors) p.authors.add(a);
      pending.set(dir, p);
      if (!failing.has(dir)) {
        failing.add(dir);
        opts.onError?.(dir, r.error);
      }
      return;
    }
    if (failing.delete(dir)) opts.onRecovered?.(dir);
  }

  function track<T>(p: Promise<T>): Promise<T> {
    inflight.add(p);
    void p.finally(() => inflight.delete(p));
    return p;
  }

  function take(dir: string): Pending | undefined {
    const p = pending.get(dir);
    if (!p) return undefined;
    if (p.timer) clearTimeout(p.timer);
    pending.delete(dir);
    return p;
  }

  async function commitPending(dir: string): Promise<void> {
    const p = take(dir);
    if (!p || !p.paths.size) return;
    const authors = [...p.authors];
    const r = await git.commit(dir, [...p.paths], combineMessages(p.messages, p.paths.size), authors.length === 1 ? authors[0]! : 'aios');
    report(dir, r, { paths: p.paths, messages: p.messages, authors: p.authors });
  }

  async function flush(): Promise<void> {
    await Promise.all([...pending.keys()].map((d) => track(commitPending(d))));
    while (inflight.size) await Promise.all([...inflight]);
  }

  return {
    add(dir, paths, message, author) {
      const p = pending.get(dir) ?? { paths: new Set<string>(), messages: [], authors: new Set<string>() };
      for (const x of paths) p.paths.add(x);
      p.messages.push(message);
      p.authors.add(author);
      pending.set(dir, p);
      if (!p.timer && !stopped) {
        p.timer = setTimeout(() => void track(commitPending(dir)), windowMs);
        p.timer.unref?.();
      }
    },

    commitNow(dir, paths, message, author) {
      // whatever is already waiting in this folder (incl. failed retries) goes along, under one message
      const p = take(dir);
      const all = new Set([...(p?.paths ?? []), ...paths]);
      const msgs = p?.messages.length ? [message, ...p.messages] : [message];
      const authors = new Set([...(p?.authors ?? []), author]);
      return track(
        git.commit(dir, [...all], p?.messages.length ? combineMessages(msgs, all.size) : message, authors.size === 1 ? author : 'aios').then((r) => {
          report(dir, r, { paths: all, messages: msgs, authors });
          return r;
        }),
      );
    },

    flush,

    async stop() {
      stopped = true;
      await flush();
    },
  };
}
