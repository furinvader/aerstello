import { sql } from 'drizzle-orm';
import { bigint, boolean, index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

export const role = pgEnum('host_role', ['admin', 'staff']);
export const language = pgEnum('language', ['de', 'it', 'en']);
export const itemSource = pgEnum('item_source', ['host', 'guest']);
export const itemStatus = pgEnum('item_status', ['provisional', 'open', 'voided', 'billed']);
export const requestStatus = pgEnum('request_status', ['pending', 'approved', 'denied', 'expired']);
export const paymentMethod = pgEnum('payment_method', ['cash', 'card', 'other']);

export const venueSettings = pgTable('venue_settings', {
  id: integer('id').primaryKey().default(1),
  name: text('name').notNull().default(''),
  defaultLanguage: language('default_language').notNull().default('de'),
  timezone: text('timezone').notNull().default('Europe/Berlin'),
  catalogVersion: integer('catalog_version').notNull().default(1),
  version: integer('version').notNull().default(1),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const hosts = pgTable('hosts', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull(),
  name: text('name').notNull(),
  passwordHash: text('password_hash').notNull(),
  role: role('role').notNull().default('staff'),
  language: language('language').notNull().default('de'),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex('hosts_email_lower_uq').on(sql`lower(${t.email})`)]);

export const hostSessions = pgTable('host_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  hostId: uuid('host_id').notNull().references(() => hosts.id),
  tokenHash: text('token_hash').notNull().unique(),
  userAgent: text('user_agent').notNull().default('Unknown device'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
}, (t) => [index('host_sessions_host_idx').on(t.hostId)]);

export const rooms = pgTable('rooms', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  position: integer('position').notNull().default(0),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
  version: integer('version').notNull().default(1),
});

export const guests = pgTable('guests', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  roomId: uuid('room_id').notNull().references(() => rooms.id),
  language: language('language').notNull().default('de'),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
  version: integer('version').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('guests_room_idx').on(t.roomId)]);

export const categories = pgTable('categories', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: jsonb('name').notNull(),
  position: integer('position').notNull().default(0),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
  version: integer('version').notNull().default(1),
});

export const products = pgTable('products', {
  id: uuid('id').primaryKey().defaultRandom(),
  categoryId: uuid('category_id').notNull().references(() => categories.id),
  name: jsonb('name').notNull(),
  description: jsonb('description'),
  priceCents: integer('price_cents').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  selfServiceOnly: boolean('self_service_only').notNull().default(false),
  position: integer('position').notNull().default(0),
  catalogVersion: integer('catalog_version').notNull(),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
  version: integer('version').notNull().default(1),
});

export const productVersions = pgTable('product_versions', {
  productId: uuid('product_id').notNull().references(() => products.id),
  catalogVersion: integer('catalog_version').notNull(),
  name: jsonb('name').notNull(),
  priceCents: integer('price_cents').notNull(),
  enabled: boolean('enabled').notNull(),
  selfServiceOnly: boolean('self_service_only').notNull(),
}, (t) => [uniqueIndex('product_versions_uq').on(t.productId, t.catalogVersion)]);

export const orderTabs = pgTable('order_tabs', {
  id: uuid('id').primaryKey().defaultRandom(),
  guestId: uuid('guest_id').notNull().references(() => guests.id),
  status: text('status').notNull().default('open'),
  openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
  closedAt: timestamp('closed_at', { withTimezone: true }),
}, (t) => [uniqueIndex('one_open_tab_per_guest').on(t.guestId).where(sql`${t.status} = 'open'`)]);

export const orderBatches = pgTable('order_batches', {
  id: uuid('id').primaryKey().defaultRandom(),
  mutationId: uuid('mutation_id').notNull().unique(),
  tabId: uuid('tab_id').notNull().references(() => orderTabs.id),
  hostId: uuid('host_id').notNull().references(() => hosts.id),
  capturedAt: timestamp('captured_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const bills = pgTable('bills', {
  id: uuid('id').primaryKey().defaultRandom(),
  number: bigint('number', { mode: 'bigint' }).generatedAlwaysAsIdentity(),
  tabId: uuid('tab_id').notNull().references(() => orderTabs.id),
  guestId: uuid('guest_id').notNull().references(() => guests.id),
  hostId: uuid('host_id').notNull().references(() => hosts.id),
  mutationId: uuid('mutation_id').notNull().unique(),
  venueName: text('venue_name').notNull(),
  venueTimezone: text('venue_timezone').notNull(),
  guestName: text('guest_name').notNull(),
  roomName: text('room_name').notNull(),
  totalCents: integer('total_cents').notNull(),
  paymentMethod: paymentMethod('payment_method').notNull(),
  paymentNote: text('payment_note'),
  settledAt: timestamp('settled_at', { withTimezone: true }).notNull().defaultNow(),
  voidedAt: timestamp('voided_at', { withTimezone: true }),
  voidReason: text('void_reason'),
  voidedBy: uuid('voided_by').references(() => hosts.id),
  voidMutationId: uuid('void_mutation_id'),
}, (t) => [
  index('bills_settled_idx').on(t.settledAt),
  uniqueIndex('bills_void_mutation_uq').on(t.voidMutationId).where(sql`${t.voidMutationId} IS NOT NULL`),
]);

export const orderItems = pgTable('order_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  tabId: uuid('tab_id').notNull().references(() => orderTabs.id),
  batchId: uuid('batch_id').references(() => orderBatches.id),
  productId: uuid('product_id').notNull().references(() => products.id),
  productName: jsonb('product_name').notNull(),
  unitPriceCents: integer('unit_price_cents').notNull(),
  quantity: integer('quantity').notNull(),
  source: itemSource('source').notNull(),
  status: itemStatus('status').notNull().default('open'),
  submittedByHost: uuid('submitted_by_host').references(() => hosts.id),
  submittedByGuestSession: uuid('submitted_by_guest_session'),
  provisionalUntil: timestamp('provisional_until', { withTimezone: true }),
  guestMutationId: uuid('guest_mutation_id').unique(),
  billId: uuid('bill_id').references(() => bills.id),
  voidedAt: timestamp('voided_at', { withTimezone: true }),
  voidedByHost: uuid('voided_by_host').references(() => hosts.id),
  voidReason: text('void_reason'),
  hostVoidMutationId: uuid('host_void_mutation_id').unique(),
  guestUndoMutationId: uuid('guest_undo_mutation_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('order_items_guest_undo_mutation_uq').on(t.guestUndoMutationId).where(sql`${t.guestUndoMutationId} IS NOT NULL`),
]);

export const billItems = pgTable('bill_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  billId: uuid('bill_id').notNull().references(() => bills.id),
  originalOrderItemId: uuid('original_order_item_id').notNull().references(() => orderItems.id),
  productName: jsonb('product_name').notNull(),
  unitPriceCents: integer('unit_price_cents').notNull(),
  quantity: integer('quantity').notNull(),
  source: itemSource('source').notNull(),
});

export const accessRequests = pgTable('access_requests', {
  id: uuid('id').primaryKey().defaultRandom(),
  mutationId: uuid('mutation_id').notNull().unique(),
  name: text('name').notNull(),
  roomId: uuid('room_id').notNull().references(() => rooms.id),
  language: language('language').notNull().default('de'),
  status: requestStatus('status').notNull().default('pending'),
  statusTokenHash: text('status_token_hash').notNull().unique(),
  guestId: uuid('guest_id').references(() => guests.id),
  requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  resolvedBy: uuid('resolved_by').references(() => hosts.id),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  statusTokenConsumedAt: timestamp('status_token_consumed_at', { withTimezone: true }),
  grantExchangeId: uuid('grant_exchange_id'),
});

export const guestSessions = pgTable('guest_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  guestId: uuid('guest_id').notNull().references(() => guests.id),
  requestId: uuid('request_id').notNull().references(() => accessRequests.id),
  tokenHash: text('token_hash').notNull().unique(),
  userAgent: text('user_agent').notNull().default('Unknown device'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
});

export const auditEvents = pgTable('audit_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  actorHostId: uuid('actor_host_id').references(() => hosts.id),
  actorGuestSessionId: uuid('actor_guest_session_id').references(() => guestSessions.id),
  action: text('action').notNull(),
  entityType: text('entity_type').notNull(),
  entityId: text('entity_id').notNull(),
  detail: jsonb('detail').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const realtimeEvents = pgTable('realtime_events', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  topic: text('topic').notNull(),
  payload: jsonb('payload').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
