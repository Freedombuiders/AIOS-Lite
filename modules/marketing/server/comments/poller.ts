/**
 * Comment poller: per Page, one FACEBOOK_GET_PAGE_POSTS call, then
 * FACEBOOK_GET_COMMENTS only for posts whose comment count changed.
 *
 * Facebook's post comment summary counts top-level comments only, so a reply
 * to a comment would not change it; posts younger than RECHECK_POST_AGE are
 * therefore re-read at most once an hour even when the count is unchanged.
 */

import {
  fbCommentExists,
  getFbCommentWatch,
  insertFbCommentIfNew,
  isFbOwnReplyId,
  upsertFbCommentWatch,
  type FbCommentPageRow,
} from '../store.js';
import { execute, graphAsPage } from '../../../_lib/composio.js';
import type { ReplyRuleConfig } from '../types.js';
import { targetFor } from './common.js';
import { extractList, nextCursor, parseComment, parsePost, type ParsedPost } from './extract.js';
import { STALE_REASON } from './limits.js';
import { getAutoReplySince } from './state.js';

const nowSec = (): number => Math.floor(Date.now() / 1000);

const POSTS_PER_POLL = 25;
const COMMENTS_PER_PAGE = 50;
/** Pages of comments read per post per poll (newest first, stops earlier at a known comment). */
const MAX_COMMENT_PAGES = 4;
/** Max GET_COMMENTS calls per Page per poll; the rest stay "changed" for the next poll. */
const MAX_POST_FETCHES = 10;
const RECHECK_POST_AGE = 48 * 3600;
const RECHECK_INTERVAL = 3600;

export interface PollResult {
  /** Customer comments stored by this poll (including backlog stored as skipped). */
  fetched: number;
  postsChecked: number;
}

function needsFetch(post: ParsedPost, now: number): boolean {
  if (post.commentCount <= 0) return false;
  const watch = getFbCommentWatch(post.id);
  if (!watch || watch.comment_count !== post.commentCount || watch.last_checked_at == null) return true;
  const young = post.createdAt == null || now - post.createdAt < RECHECK_POST_AGE;
  return young && now - watch.last_checked_at >= RECHECK_INTERVAL;
}

/**
 * Stores the new comments of one post, newest first, paging with `after`
 * until the first comment already known. Read as the Page: the Composio
 * FACEBOOK_GET_COMMENTS tool is refused (pages_read_engagement) but the
 * Graph edge with the Page token works and returns `from`.
 */
async function ingestPost(page: FbCommentPageRow, post: ParsedPost, now: number): Promise<number> {
  const since = getAutoReplySince(page.id);
  let stored = 0;
  let after: string | undefined;
  for (let pageNo = 0; pageNo < MAX_COMMENT_PAGES; pageNo++) {
    const res = await graphAsPage(page.id, {
      method: 'GET',
      path: `/${post.id}/comments`,
      query: {
        filter: 'stream',
        order: 'reverse_chronological',
        limit: COMMENTS_PER_PAGE,
        fields: 'id,from{id,name},message,created_time,parent{id}',
        ...(after ? { after } : {}),
      },
    }, targetFor(page));

    for (const raw of extractList(res.data)) {
      const c = parseComment(raw, post.id);
      if (!c) continue;
      if (fbCommentExists(c.id)) return stored;

      const created = c.createdAt ?? now;
      const fromPage = c.authorId === page.id || isFbOwnReplyId(c.id);
      let status = 'new';
      let reason = '';
      if (fromPage) { status = 'skipped'; reason = 'Bình luận của Page'; }
      else if (since == null || created < since) { status = 'skipped'; reason = STALE_REASON; }
      else if (c.isHidden) { status = 'skipped'; reason = 'Bình luận đã bị ẩn'; }

      const added = insertFbCommentIfNew({
        id: c.id,
        page_id: page.id,
        post_id: post.id,
        parent_id: c.parentId,
        author_id: c.authorId,
        author_name: c.authorName,
        message: c.message,
        created_time: created,
        fetched_at: now,
        from_page: fromPage ? 1 : 0,
        step: status === 'skipped' ? 'skip' : '',
        rule_ref: '',
        reason,
        reply_text: '',
        private_text: '',
        status,
        send_after: null,
        reply_comment_id: null,
        private_sent: 0,
        attempts: 0,
        error: '',
        topic: '',
        decided_at: status === 'skipped' ? now : null,
        sent_at: null,
      });
      if (added && !fromPage) stored++;
    }

    after = nextCursor(res.data) ?? undefined;
    if (!after) break;
  }
  return stored;
}

/**
 * Runs one poll for a Page. Throws Composio errors (expired connection, rate
 * limit, budget) for the caller to handle; progress made so far is kept.
 */
export async function pollPage(page: FbCommentPageRow, rules: ReplyRuleConfig, now: number = nowSec()): Promise<PollResult> {
  const data = await execute('FACEBOOK_GET_PAGE_POSTS', {
    page_id: page.id,
    limit: POSTS_PER_POLL,
    since: String(now - rules.maxPostAgeDays * 86400),
    fields: 'id,message,created_time,permalink_url,comments.summary(true)',
  }, targetFor(page));

  const cutoff = now - rules.maxPostAgeDays * 86400;
  const posts = extractList(data)
    .map(parsePost)
    .filter((p): p is ParsedPost => p !== null && (p.createdAt == null || p.createdAt >= cutoff))
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));

  let fetched = 0;
  let fetchCalls = 0;
  for (const post of posts) {
    const watch = getFbCommentWatch(post.id);
    const base = {
      post_id: post.id,
      page_id: page.id,
      post_created_at: post.createdAt,
      message: post.message,
      permalink: post.permalink,
    };
    if (!needsFetch(post, now) || fetchCalls >= MAX_POST_FETCHES) {
      // Remember the post without touching the count we last read comments at.
      upsertFbCommentWatch({
        ...base,
        comment_count: post.commentCount <= 0 ? 0 : watch?.comment_count ?? 0,
        last_checked_at: null,
      });
      continue;
    }
    fetchCalls++;
    fetched += await ingestPost(page, post, now);
    upsertFbCommentWatch({ ...base, comment_count: post.commentCount, last_checked_at: now });
  }
  return { fetched, postsChecked: posts.length };
}
