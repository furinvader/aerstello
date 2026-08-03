import { describe, expect, it, vi } from 'vitest';
import { ApiError } from './api';
import { isPermanentSyncConflict, LEGACY_UNASSIGNED_HOST_ID, migrateLegacyMutation, replayQueuedMutations, submitOrQueue, type QueuedMutation } from './offline';

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
  it('persists an online transient failure before preserving its uncertain result', async () => {
    const transient = new TypeError('Response lost');
    const body = { mutationId: 'mutation-1', reason: 'Original correction', expectedBillingVersion: 3 };
    const entry = { ...mutation('1'), path: '/order-items/item-1/void', body };
    const put = vi.fn(async () => undefined);
    const remove = vi.fn(async () => undefined);

    await expect(submitOrQueue(entry, {
      send: async () => { throw transient; },
      put,
      remove,
      isOnline: () => true,
    })).rejects.toBe(transient);

    expect(put).toHaveBeenCalledWith(expect.objectContaining({
      id: entry.id,
      hostId: entry.hostId,
      path: entry.path,
      body,
      status: 'pending',
    }));
    expect(remove).not.toHaveBeenCalled();
  });

  it('removes durable recovery after the original command succeeds', async () => {
    const put = vi.fn(async () => undefined);
    const remove = vi.fn(async () => undefined);

    await expect(submitOrQueue(mutation('1'), {
      send: async () => ({ recovered: true }),
      put,
      remove,
      isOnline: () => true,
    })).resolves.toEqual({ queued: false, data: { recovered: true } });

    expect(remove).toHaveBeenCalledWith('1');
    expect(put).not.toHaveBeenCalled();
  });

  it('does not persist a definitive submission rejection', async () => {
    const conflict = new ApiError('ITEM_BILLING_CONFLICT', 'Review the tab', 409);
    const put = vi.fn(async () => undefined);
    const remove = vi.fn(async () => undefined);

    await expect(submitOrQueue(mutation('1'), {
      send: async () => { throw conflict; },
      put,
      remove,
      isOnline: () => true,
    })).rejects.toBe(conflict);

    expect(put).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

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

  it('quarantines an item command that crossed billing', async () => {
    const remove = vi.fn(async () => undefined);
    const update = vi.fn(async () => undefined);
    const send = vi.fn(async () => { throw new ApiError('ITEM_BILLING_CONFLICT', 'Review the tab', 409); });

    await expect(replayQueuedMutations([mutation('1')], { send, remove, update })).resolves.toBe(0);
    expect(update).toHaveBeenCalledWith('1', expect.objectContaining({ status: 'conflict', errorCode: 'ITEM_BILLING_CONFLICT' }));
    expect(remove).not.toHaveBeenCalled();
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

  it('quarantines version-one mutations without deleting their command', () => {
    const legacy = {
      id: 'legacy-order',
      path: '/order-batches',
      method: 'POST' as const,
      body: { mutationId: 'legacy-order', guestId: 'guest-a', items: [{ productId: 'product-a', quantity: 1 }] },
      createdAt: '2026-08-02T00:00:00.000Z',
    };

    const migrated = migrateLegacyMutation(legacy);
    expect(migrated).toEqual(expect.objectContaining({
      id: legacy.id,
      hostId: LEGACY_UNASSIGNED_HOST_ID,
      path: legacy.path,
      body: legacy.body,
      status: 'conflict',
      errorCode: 'LEGACY_MUTATION_REVIEW',
      legacyOwnershipVerified: false,
    }));
    expect(migrated.body).not.toEqual(expect.objectContaining({ originHostId: expect.anything() }));
  });

  it('preserves a legacy mutation ownership claim recorded by its command', () => {
    const migrated = migrateLegacyMutation({
      id: 'owned-order',
      path: '/order-batches',
      method: 'POST',
      body: { mutationId: 'owned-order', originHostId: 'host-a' },
      createdAt: '2026-08-02T00:00:00.000Z',
    });

    expect(migrated.hostId).toBe('host-a');
    expect(migrated.legacyOwnershipVerified).toBe(true);
  });
});
