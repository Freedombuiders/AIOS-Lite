import { beforeEach, describe, expect, it, vi } from 'vitest';

const execute = vi.fn();
const initiate = vi.fn();
const createAuthConfig = vi.fn();
const listConnections = vi.fn();
const hasComposioKey = vi.fn();
const recordEmailApiCall = vi.fn();
const countEmailApiCallsSince = vi.fn();

vi.mock('../../_lib/composio.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../_lib/composio.js')>();
  return {
    ...orig,
    getComposio: () => ({
      tools: { execute },
      connectedAccounts: { link: initiate },
      authConfigs: { create: createAuthConfig },
    }),
    listConnections: (...a: unknown[]) => listConnections(...a),
    hasComposioKey: () => hasComposioKey(),
  };
});

import { ComposioAuthError, ComposioConnectionExpiredError, ComposioRateLimitError } from '../../_lib/composio.js';
import { EmailBudgetExceeded, createGmailApi } from './gmail.js';
import type { ModuleContext } from '../../../src/modules/sdk.js';
import type { EmailStore } from './store.js';
const api = createGmailApi({ connections: { secret: () => 'test-key' }, log: { info: vi.fn() } } as unknown as ModuleContext, {
  getEmailProtectionSettings: () => ({ apiBudgetPerHour: 10 }), countEmailApiCallsSince, recordEmailApiCall,
} as unknown as EmailStore);
const { gmailExecute, fetchGmailProfile, fetchGmailMessages, sendGmailReply, startGmailConnect } = api;
import { rawMessage } from './test-fixtures.js';

const target = { connectionId: 'ca_1', entityId: 'user_1' };

beforeEach(() => {
  vi.clearAllMocks();
  countEmailApiCallsSince.mockReturnValue(0);
  hasComposioKey.mockReturnValue(true);

});

describe('gmailExecute', () => {
  it('runs the tool for the connection and returns data', async () => {
    execute.mockResolvedValue({ successful: true, data: { ok: 1 } });
    const data = await gmailExecute('GMAIL_GET_PROFILE', { user_id: 'me' }, target, 'profile');
    expect(data).toEqual({ ok: 1 });
    expect(execute).toHaveBeenCalledWith('GMAIL_GET_PROFILE', {
      userId: 'user_1', connectedAccountId: 'ca_1', arguments: { user_id: 'me' }, dangerouslySkipVersionCheck: true,
    });
    expect(recordEmailApiCall).toHaveBeenCalledWith('profile', true);
  });

  it('refuses without calling Composio when the hourly budget is spent', async () => {
    countEmailApiCallsSince.mockReturnValue(10);
    await expect(gmailExecute('X', {}, target, 'sync')).rejects.toBeInstanceOf(EmailBudgetExceeded);
    expect(execute).not.toHaveBeenCalled();
    expect(recordEmailApiCall).not.toHaveBeenCalled();
  });

  it('counts failed calls and classifies the error', async () => {
    execute.mockResolvedValue({ successful: false, error: 'Connected account expired' });
    await expect(gmailExecute('X', {}, target, 'sync')).rejects.toBeInstanceOf(ComposioConnectionExpiredError);
    expect(recordEmailApiCall).toHaveBeenCalledWith('sync', false);

    execute.mockRejectedValue(Object.assign(new Error('slow down'), { statusCode: 429 }));
    await expect(gmailExecute('X', {}, target, 'sync')).rejects.toBeInstanceOf(ComposioRateLimitError);
  });

  it('treats a revoked Google token as an expired connection', async () => {
    execute.mockResolvedValue({ successful: false, error: 'invalid_grant: Token has been revoked' });
    await expect(gmailExecute('X', {}, target, 'sync')).rejects.toBeInstanceOf(ComposioConnectionExpiredError);
  });
});

describe('fetchGmailProfile', () => {
  it('reads data.emailAddress lower-cased', async () => {
    execute.mockResolvedValue({ successful: true, data: { emailAddress: 'Shop@Gmail.com' } });
    expect(await fetchGmailProfile(target)).toEqual({ emailAddress: 'shop@gmail.com' });
  });

  it('reads data.response_data.emailAddress', async () => {
    execute.mockResolvedValue({ successful: true, data: { response_data: { emailAddress: 'a@b.com' } } });
    expect(await fetchGmailProfile(target)).toEqual({ emailAddress: 'a@b.com' });
  });
});

describe('fetchGmailMessages', () => {
  it('sends the documented arguments and normalizes the messages', async () => {
    execute.mockResolvedValue({
      successful: true,
      data: {
        messages: [rawMessage({ id: 'm1', threadId: 't1', plain: 'xin chào' }), { junk: true }],
        nextPageToken: '',
        resultSizeEstimate: 2,
      },
    });
    const res = await fetchGmailMessages(target, { query: 'after:1 {in:inbox in:sent}', maxResults: 25 });
    expect(execute.mock.calls[0][1].arguments).toEqual({
      user_id: 'me', query: 'after:1 {in:inbox in:sent}', max_results: 25, include_payload: true, verbose: true,
    });
    expect(res.messages.map((m) => m.gmailMessageId)).toEqual(['m1']);
    expect(res.nextPageToken).toBeNull();
    expect(recordEmailApiCall).toHaveBeenCalledWith('sync', true);
  });

  it('passes page_token and returns the next token', async () => {
    execute.mockResolvedValue({ successful: true, data: { messages: [], nextPageToken: 'tok2' } });
    const res = await fetchGmailMessages(target, { query: 'q', maxResults: 25, pageToken: 'tok1' });
    expect(execute.mock.calls[0][1].arguments.page_token).toBe('tok1');
    expect(res.nextPageToken).toBe('tok2');
  });
});

describe('sendGmailReply', () => {
  it('replies to the thread and returns the sent ids', async () => {
    execute.mockResolvedValue({ successful: true, data: { response_data: { id: 'sent1', threadId: 't1', labelIds: ['SENT'] } } });
    const res = await sendGmailReply(target, { gmailThreadId: 't1', to: 'khach@example.com', body: 'Dạ shop trả lời' });
    expect(execute.mock.calls[0][0]).toBe('GMAIL_REPLY_TO_THREAD');
    expect(execute.mock.calls[0][1].arguments).toEqual({
      user_id: 'me', thread_id: 't1', recipient_email: 'khach@example.com', cc: [], message_body: 'Dạ shop trả lời', is_html: false,
    });
    expect(res).toEqual({ gmailMessageId: 'sent1', gmailThreadId: 't1' });
    expect(recordEmailApiCall).toHaveBeenCalledWith('send', true);
  });

  it('accepts data.id and throws when Gmail returns no id', async () => {
    execute.mockResolvedValueOnce({ successful: true, data: { id: 'sent2' } });
    expect((await sendGmailReply(target, { gmailThreadId: 't1', to: 'a@b.com', cc: ['c@d.com'], body: 'x' })).gmailMessageId).toBe('sent2');
    expect(execute.mock.calls[0][1].arguments.cc).toEqual(['c@d.com']);
    execute.mockResolvedValueOnce({ successful: true, data: {} });
    await expect(sendGmailReply(target, { gmailThreadId: 't1', to: 'a@b.com', body: 'x' })).rejects.toThrow();
  });
});

describe('startGmailConnect', () => {
  it('throws ComposioAuthError without a key', async () => {
    hasComposioKey.mockReturnValue(false);
    await expect(startGmailConnect()).rejects.toBeInstanceOf(ComposioAuthError);
  });

  it('reuses the auth config of an existing gmail connection', async () => {
    listConnections.mockResolvedValue([{ id: 'ca_1', toolkit: 'gmail', status: 'ACTIVE', alias: null, entityId: 'u', authConfigId: 'ac_1' }]);
    initiate.mockResolvedValue({ redirectUrl: 'https://connect.composio.dev/x' });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    expect(await startGmailConnect()).toEqual({ redirectUrl: 'https://connect.composio.dev/x' });
    expect(initiate).toHaveBeenCalledWith('aios-gmail', 'ac_1', { allowMultiple: true });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('falls back to the first project auth config over REST', async () => {
    listConnections.mockResolvedValue([]);
    initiate.mockResolvedValue({ redirectUrl: 'https://connect.composio.dev/y' });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ items: [{ id: 'ac_rest' }] }), { status: 200 }));
    await startGmailConnect();
    expect(String(fetchSpy.mock.calls[0][0])).toContain('auth_configs?toolkit_slug=gmail');
    expect((fetchSpy.mock.calls[0][1] as { headers: Record<string, string> }).headers['x-api-key']).toBe('test-key');
    expect(initiate).toHaveBeenCalledWith('aios-gmail', 'ac_rest', { allowMultiple: true });
    fetchSpy.mockRestore();
  });

  it('creates a Composio-managed auth config as a last resort and rejects a missing redirect', async () => {
    listConnections.mockResolvedValue([]);
    createAuthConfig.mockResolvedValue({ id: 'ac_new' });
    initiate.mockResolvedValue({ redirectUrl: null });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ items: [] }), { status: 200 }));
    await expect(startGmailConnect()).rejects.toThrow();
    expect(createAuthConfig).toHaveBeenCalledWith('gmail', { type: 'use_composio_managed_auth', name: 'AIOS Gmail' });
    expect(initiate).toHaveBeenCalledWith('aios-gmail', 'ac_new', { allowMultiple: true });
    expect(recordEmailApiCall).toHaveBeenCalledWith('connect', false);
    fetchSpy.mockRestore();
  });
});
