import { describe, expect, it, vi } from 'vitest';
import { ApiError } from './api';
import { isPermanentSyncConflict, replayQueuedMutations, type QueuedMutation } from './offline';

const mutation = (id: string): QueuedMutation => ({
  id,
  hostId: 'host-a',
  path: '/order-batches',
  method: 'POST',
  body: {},
  createdAt: `2026-08-02T00:00:0${id}Z`,
  status: 'pending',
});

describe('offline mutation replay', () => {
  it('quarantines permanent conflicts and continues later mutations', async () => {
    const remove = vi.fn(async () => undefined);
    const update = vi.fn(async () => undefined);
    const send = vi.fn(async (entry: QueuedMutation) => {
      if (entry.id === '1') throw new ApiError('CATALOG_CONFLICT', 'Changed', 409);
    });

    await expect(replayQueuedMutations([mutation('1'), mutation('2')], { send, remove, update })).resolves.toBe(1);
    expect(send).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenCalledWith('1', expect.objectContaining({ status: 'conflict', errorCode: 'CATALOG_CONFLICT' }));
    expect(remove).toHaveBeenCalledWith('2');
  });

  it('keeps transient failures pending and stops replay', async () => {
    const remove = vi.fn(async () => undefined);
    const update = vi.fn(async () => undefined);
    const send = vi.fn(async () => { throw new ApiError('UNAVAILABLE', 'Retry later', 503); });

    await expect(replayQueuedMutations([mutation('1'), mutation('2')], { send, remove, update })).resolves.toBe(0);
    expect(send).toHaveBeenCalledOnce();
    expect(update).toHaveBeenCalledWith('1', expect.not.objectContaining({ status: 'conflict' }));
    expect(remove).not.toHaveBeenCalled();
  });

  it('treats retryable client responses as transient', () => {
    expect(isPermanentSyncConflict(new ApiError('UNAUTHENTICATED', 'Sign in', 401))).toBe(false);
    expect(isPermanentSyncConflict(new ApiError('RATE_LIMITED', 'Slow down', 429))).toBe(false);
  });
});
