import { describe, expect, it } from 'vitest';
import { loadPendingSettlement, pendingSettlementKey, persistPendingSettlement, type PendingSettlement } from './settlement-recovery';

const hostId = '10000000-0000-4000-8000-000000000001';
const settlement: PendingSettlement = {
  storageVersion: 1,
  hostId,
  tabId: '20000000-0000-4000-8000-000000000002',
  guestId: '30000000-0000-4000-8000-000000000003',
  guestName: 'Anna Berger',
  roomName: '101',
  createdAt: '2026-08-03T10:00:00.000Z',
  command: {
    mutationId: '40000000-0000-4000-8000-000000000004',
    expectedItemCount: 2,
    expectedTotalCents: 840,
    paymentMethod: 'other',
    note: 'Voucher 12',
  },
};

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
    values,
  };
}

describe('settlement recovery storage', () => {
  it('round-trips the exact frozen command for its originating host', () => {
    const storage = memoryStorage();
    persistPendingSettlement(hostId, settlement, storage);

    expect(loadPendingSettlement(hostId, storage)).toEqual(settlement);
    expect(JSON.parse(storage.values.get(pendingSettlementKey(hostId))!)).toEqual(settlement);
  });

  it('does not expose one host settlement through another host key', () => {
    const storage = memoryStorage();
    persistPendingSettlement(hostId, settlement, storage);

    expect(loadPendingSettlement('50000000-0000-4000-8000-000000000005', storage)).toBeNull();
    expect(loadPendingSettlement(hostId, storage)).toEqual(settlement);
  });

  it('removes malformed state instead of constructing a different command', () => {
    const storage = memoryStorage();
    storage.setItem(pendingSettlementKey(hostId), JSON.stringify({ ...settlement, command: { ...settlement.command, expectedTotalCents: -1 } }));

    expect(loadPendingSettlement(hostId, storage)).toBeNull();
    expect(storage.getItem(pendingSettlementKey(hostId))).toBeNull();
  });

  it('clears recovery only when explicitly requested', () => {
    const storage = memoryStorage();
    persistPendingSettlement(hostId, settlement, storage);
    persistPendingSettlement(hostId, null, storage);

    expect(loadPendingSettlement(hostId, storage)).toBeNull();
  });
});
