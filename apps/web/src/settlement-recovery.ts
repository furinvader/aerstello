import { settleTabSchema } from '@sky-bar/shared';

type SettleTabCommand = ReturnType<typeof settleTabSchema.parse>;

export interface PendingSettlement {
  storageVersion: 1;
  hostId: string;
  tabId: string;
  guestId: string;
  guestName: string;
  roomName: string;
  createdAt: string;
  command: SettleTabCommand;
}

interface SettlementStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const pendingSettlementKey = (hostId: string) => `skybar-pending-settlement:${hostId}`;

function isPendingSettlement(value: unknown, hostId: string): value is PendingSettlement {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<PendingSettlement>;
  return candidate.storageVersion === 1
    && candidate.hostId === hostId
    && typeof candidate.tabId === 'string' && uuidPattern.test(candidate.tabId)
    && typeof candidate.guestId === 'string' && uuidPattern.test(candidate.guestId)
    && typeof candidate.guestName === 'string'
    && typeof candidate.roomName === 'string'
    && typeof candidate.createdAt === 'string' && !Number.isNaN(Date.parse(candidate.createdAt))
    && settleTabSchema.safeParse(candidate.command).success;
}

export function loadPendingSettlement(
  hostId: string,
  storage: SettlementStorage = localStorage,
): PendingSettlement | null {
  const key = pendingSettlementKey(hostId);
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    const candidate: unknown = JSON.parse(raw);
    if (isPendingSettlement(candidate, hostId)) return candidate;
  } catch { /* Remove malformed or unreadable recovery state below. */ }
  storage.removeItem(key);
  return null;
}

export function persistPendingSettlement(
  hostId: string,
  settlement: PendingSettlement | null,
  storage: SettlementStorage = localStorage,
): void {
  const key = pendingSettlementKey(hostId);
  if (!settlement) {
    storage.removeItem(key);
    return;
  }
  if (!isPendingSettlement(settlement, hostId)) throw new Error('Invalid settlement recovery command.');
  storage.setItem(key, JSON.stringify(settlement));
}
