import { afterEach, describe, expect, it } from 'vitest';

import {
  ComposioAuthError,
  ComposioConnectionExpiredError,
  ComposioRateLimitError,
  _setToolExecutor,
  asNum,
  classifyExecError,
  executeTool,
  findRecord,
  findString,
} from './composio-exec.js';

afterEach(() => _setToolExecutor(null));

describe('classifyExecError', () => {
  it('maps auth, expiry and rate limits', () => {
    expect(classifyExecError(Object.assign(new Error('nope'), { status: 401 }))).toBeInstanceOf(ComposioAuthError);
    expect(classifyExecError(new Error('Error validating access token: Session has expired'))).toBeInstanceOf(ComposioConnectionExpiredError);
    expect(classifyExecError(new Error('{"error":{"code":"access_token_invalid"}}'))).toBeInstanceOf(ComposioConnectionExpiredError);
    expect(classifyExecError(new Error('ToolRouterV2_NoActiveConnection'))).toBeInstanceOf(ComposioConnectionExpiredError);
    expect(classifyExecError(Object.assign(new Error('slow down'), { status: 429 }))).toBeInstanceOf(ComposioRateLimitError);
  });

  it('"expired" about media is not an expired connection', () => {
    const e = classifyExecError(new Error('The media container has expired, create a new one'));
    expect(e).not.toBeInstanceOf(ComposioConnectionExpiredError);
    expect(e.message).toMatch(/container/);
    expect(classifyExecError(new Error('upload url expired'))).not.toBeInstanceOf(ComposioConnectionExpiredError);
  });
});

describe('executeTool', () => {
  it('runs through the injected executor and classifies its errors', async () => {
    _setToolExecutor(async (slug, args, target) => ({ slug, args, target }));
    expect(await executeTool('X', { a: 1 }, { connectionId: 'c', entityId: 'e' })).toEqual({ slug: 'X', args: { a: 1 }, target: { connectionId: 'c', entityId: 'e' } });
    _setToolExecutor(async () => { throw new Error('Session has expired, please reauthorize'); });
    await expect(executeTool('X', {}, { connectionId: 'c', entityId: 'e' })).rejects.toBeInstanceOf(ComposioConnectionExpiredError);
  });
});

describe('response helpers', () => {
  it('finds fields under the usual wrappers', () => {
    expect(findString({ data: { data: { publish_id: 'p1' } } }, ['publish_id'])).toBe('p1');
    expect(findString({ response_data: { id: 42 } }, ['id'])).toBe('42');
    expect(findRecord({ data: [{ username: 'x' }] }, ['username'])).toEqual({ username: 'x' });
    expect(findString({}, ['id'])).toBeNull();
    expect(asNum('12')).toBe(12);
    expect(asNum('')).toBeNull();
    expect(asNum(null)).toBeNull();
  });
});
