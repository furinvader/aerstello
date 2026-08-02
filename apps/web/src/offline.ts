import Dexie, { type EntityTable } from 'dexie';
import type { LocalizedText } from '@sky-bar/shared';
import { ApiError, api, json } from './api';

export type QueuedMutationDisplay = {
  kind: 'order';
  guestId: string;
  guestName: string;
  roomName: string;
  items: { productId: string; productName: LocalizedText; unitPriceCents: number; quantity: number }[];
} | {
  kind: 'void';
  guestId: string;
  guestName: string;
  roomName: string;
  productName: LocalizedText;
  quantity: number;
};

export interface QueuedMutation {
  id: string;
  hostId: string;
  legacyOwnershipVerified?: boolean;
  path: string;
  method: 'POST';
  body: unknown;
  createdAt: string;
  status?: 'pending' | 'conflict';
  errorCode?: string;
  lastError?: string;
  display?: QueuedMutationDisplay;
}

type LegacyQueuedMutation = Omit<QueuedMutation, 'hostId'> & { hostId?: string };
export const LEGACY_UNASSIGNED_HOST_ID = '00000000-0000-0000-0000-000000000000';

function objectBody(body: unknown): Record<string, unknown> | undefined {
  return typeof body === 'object' && body !== null && !Array.isArray(body) ? body as Record<string, unknown> : undefined;
}

export function migrateLegacyMutation(mutation: LegacyQueuedMutation): QueuedMutation {
  const body = objectBody(mutation.body);
  const originHostId = typeof body?.originHostId === 'string' ? body.originHostId : undefined;
  return {
    ...mutation,
    hostId: mutation.hostId ?? originHostId ?? LEGACY_UNASSIGNED_HOST_ID,
    legacyOwnershipVerified: Boolean(mutation.hostId ?? originHostId),
    status: 'conflict',
    errorCode: 'LEGACY_MUTATION_REVIEW',
    lastError: 'Review this preserved mutation before retrying it.',
  };
}

const db = new Dexie('sky-bar') as Dexie & { mutations: EntityTable<QueuedMutation, 'id'> };
db.version(1).stores({ mutations: 'id,createdAt' });
db.version(2).stores({ mutations: 'id,hostId,[hostId+createdAt],createdAt' }).upgrade((transaction) =>
  transaction.table('mutations').toCollection().modify((mutation: LegacyQueuedMutation) => {
    Object.assign(mutation, migrateLegacyMutation(mutation));
  }),
);
db.version(3).stores({ mutations: 'id,hostId,status,[hostId+status],[hostId+createdAt],createdAt' }).upgrade((transaction) =>
  transaction.table('mutations').toCollection().modify((mutation: QueuedMutation) => { mutation.status ??= 'pending'; }),
);
db.version(4).stores({ mutations: 'id,hostId,status,[hostId+status],[hostId+createdAt],createdAt' }).upgrade((transaction) =>
  transaction.table('mutations').toCollection().modify((mutation: QueuedMutation) => {
    if (mutation.errorCode !== 'LEGACY_MUTATION_REVIEW' || mutation.legacyOwnershipVerified) return;
    const legacyBody = objectBody(mutation.body);
    if (legacyBody && 'originHostId' in legacyBody) {
      const { originHostId: _originHostId, ...bodyWithoutClaimedHost } = legacyBody;
      mutation.body = bodyWithoutClaimedHost;
    }
    mutation.hostId = LEGACY_UNASSIGNED_HOST_ID;
  }),
);

export function isPermanentSyncConflict(error: unknown): error is ApiError {
  return error instanceof ApiError
    && error.status >= 400
    && error.status < 500
    && ![401, 408, 429].includes(error.status);
}

interface ReplayHandlers {
  send: (mutation: QueuedMutation) => Promise<void>;
  remove: (id: string) => Promise<void>;
  update: (id: string, changes: Partial<QueuedMutation>) => Promise<void>;
}

export async function replayQueuedMutations(pending: QueuedMutation[], handlers: ReplayHandlers): Promise<number> {
  let completed = 0;
  for (const mutation of pending) {
    try {
      await handlers.send(mutation);
      await handlers.remove(mutation.id);
      completed += 1;
    } catch (error) {
      const failure = {
        errorCode: error instanceof ApiError ? error.code : 'SYNC_FAILED',
        lastError: error instanceof Error ? error.message : 'Sync failed',
      };
      if (isPermanentSyncConflict(error)) {
        await handlers.update(mutation.id, { ...failure, status: 'conflict' });
        continue;
      }
      await handlers.update(mutation.id, failure);
      break;
    }
  }
  return completed;
}

export async function submitOrQueue<T>(mutation: QueuedMutation): Promise<{ queued: boolean; data?: T }> {
  try {
    const data = await api<T>(mutation.path, { method: mutation.method, body: json(mutation.body) });
    return { queued: false, data };
  } catch (error) {
    if (navigator.onLine) throw error;
    const { errorCode: _errorCode, lastError: _lastError, ...freshMutation } = mutation;
    await db.mutations.put({ ...freshMutation, status: 'pending' });
    return { queued: true };
  }
}

export async function flushQueue(hostId: string): Promise<number> {
  if (!navigator.onLine) return 0;
  const pending = await db.mutations.where('[hostId+status]').equals([hostId, 'pending']).sortBy('createdAt');
  return replayQueuedMutations(pending, {
    send: async (mutation) => { await api(mutation.path, { method: mutation.method, body: json(mutation.body) }); },
    remove: async (mutationId) => { await db.mutations.delete(mutationId); },
    update: async (mutationId, changes) => { await db.mutations.update(mutationId, changes); },
  });
}

export const pendingMutationCount = (hostId: string) => db.mutations.where('[hostId+status]').equals([hostId, 'pending']).count();
export const mutationConflicts = (hostId: string) => db.mutations
  .filter((mutation) => mutation.status === 'conflict'
    && (mutation.hostId === hostId || mutation.hostId === LEGACY_UNASSIGNED_HOST_ID))
  .sortBy('createdAt');
export async function discardMutationConflict(id: string, hostId: string): Promise<void> {
  const mutation = await db.mutations.get(id);
  if (mutation?.status === 'conflict'
    && (mutation.hostId === hostId || mutation.hostId === LEGACY_UNASSIGNED_HOST_ID)) await db.mutations.delete(id);
}

export async function retryMutationConflict(id: string, hostId: string): Promise<void> {
  const mutation = await db.mutations.get(id);
  if (mutation?.hostId === hostId && mutation.status === 'conflict') {
    await db.mutations.update(id, { status: 'pending', errorCode: '', lastError: '' });
  }
}
