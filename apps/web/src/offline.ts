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
  path: string;
  method: 'POST';
  body: unknown;
  createdAt: string;
  status?: 'pending' | 'conflict';
  errorCode?: string;
  lastError?: string;
  display?: QueuedMutationDisplay;
}

const db = new Dexie('sky-bar') as Dexie & { mutations: EntityTable<QueuedMutation, 'id'> };
db.version(1).stores({ mutations: 'id,hostId,status,[hostId+status],[hostId+createdAt],createdAt' });

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

export interface SubmitOrQueueHandlers<T> {
  send: (mutation: QueuedMutation) => Promise<T>;
  put: (mutation: QueuedMutation) => Promise<void>;
  remove: (id: string) => Promise<void>;
  isOnline: () => boolean;
}

export async function submitOrQueue<T>(
  mutation: QueuedMutation,
  handlers: SubmitOrQueueHandlers<T> = {
    send: (entry) => api<T>(entry.path, { method: entry.method, body: json(entry.body) }),
    put: async (entry) => { await db.mutations.put(entry); },
    remove: async (id) => { await db.mutations.delete(id); },
    isOnline: () => navigator.onLine,
  },
): Promise<{ queued: boolean; data?: T }> {
  try {
    const data = await handlers.send(mutation);
    await handlers.remove(mutation.id);
    return { queued: false, data };
  } catch (error) {
    if (isPermanentSyncConflict(error)) throw error;
    const { errorCode: _errorCode, lastError: _lastError, ...freshMutation } = mutation;
    await handlers.put({ ...freshMutation, status: 'pending' });
    if (handlers.isOnline()) throw error;
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
  .filter((mutation) => mutation.status === 'conflict' && mutation.hostId === hostId)
  .sortBy('createdAt');
export async function discardMutationConflict(id: string, hostId: string): Promise<void> {
  const mutation = await db.mutations.get(id);
  if (mutation?.status === 'conflict' && mutation.hostId === hostId) await db.mutations.delete(id);
}

export async function retryMutationConflict(id: string, hostId: string): Promise<void> {
  const mutation = await db.mutations.get(id);
  if (mutation?.hostId === hostId && mutation.status === 'conflict') {
    await db.mutations.update(id, { status: 'pending', errorCode: '', lastError: '' });
  }
}
