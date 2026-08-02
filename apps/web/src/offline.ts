import Dexie, { type EntityTable } from 'dexie';
import { api, json } from './api';

export interface QueuedMutation {
  id: string;
  hostId: string;
  path: string;
  method: 'POST';
  body: unknown;
  createdAt: string;
  lastError?: string;
}

const db = new Dexie('sky-bar') as Dexie & { mutations: EntityTable<QueuedMutation, 'id'> };
db.version(1).stores({ mutations: 'id,createdAt' });
db.version(2).stores({ mutations: 'id,hostId,[hostId+createdAt],createdAt' }).upgrade((transaction) =>
  transaction.table('mutations').clear(),
);

export async function submitOrQueue<T>(mutation: QueuedMutation): Promise<{ queued: boolean; data?: T }> {
  try {
    const data = await api<T>(mutation.path, { method: mutation.method, body: json(mutation.body) });
    return { queued: false, data };
  } catch (error) {
    if (navigator.onLine) throw error;
    await db.mutations.put(mutation);
    return { queued: true };
  }
}

export async function flushQueue(hostId: string): Promise<number> {
  if (!navigator.onLine) return 0;
  const pending = await db.mutations.where('hostId').equals(hostId).sortBy('createdAt');
  let completed = 0;
  for (const mutation of pending) {
    try {
      await api(mutation.path, { method: mutation.method, body: json(mutation.body) });
      await db.mutations.delete(mutation.id);
      completed += 1;
    } catch (error) {
      await db.mutations.update(mutation.id, { lastError: error instanceof Error ? error.message : 'Sync failed' });
      break;
    }
  }
  return completed;
}

export const pendingMutationCount = (hostId: string) => db.mutations.where('hostId').equals(hostId).count();
