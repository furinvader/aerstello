import { sql } from 'drizzle-orm';
import { bigint, boolean, check, index, integer, jsonb, pgEnum, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid, type AnyPgColumn } from 'drizzle-orm/pg-core';

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
}, (t) => [check('venue_settings_id_check', sql`${t.id} = 1`)]);

export const hosts = pgTable('hosts', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull(),
  name: text('name').notNull(),
  passwordHash: text('password_hash').notNull(),
  role: role('role').notNull().default('staff'),
  language: language('language').notNull().default('de'),
  active: boolean('active').notNull().default(true),
  version: integer('version').notNull().default(1),
  createMutationId: uuid('create_mutation_id'),
  createEmail: text('create_email'),
  createName: text('create_name'),
  createCommandHash: text('create_command_hash'),
  createRole: role('create_role'),
  createLanguage: language('create_language'),
  createdByHost: uuid('created_by_host').references(():AnyPgColumn => hosts.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('hosts_email_lower_uq').on(sql`lower(${t.email})`),
  uniqueIndex('hosts_create_mutation_uq').on(t.createMutationId).where(sql`${t.createMutationId} IS NOT NULL`),
]);

export const hostSessions = pgTable('host_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  hostId: uuid('host_id').notNull().references(() => hosts.id),
  tokenHash: text('token_hash').notNull().unique('host_sessions_token_hash_key'),
  userAgent: text('user_agent').notNull().default('Unknown device'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
}, (t) => [index('host_sessions_host_idx').on(t.hostId)]);

export const rooms = pgTable('rooms', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  createMutationId: uuid('create_mutation_id'),
  createName: text('create_name'),
  createdByHost: uuid('created_by_host').references(() => hosts.id),
  position: integer('position').notNull().default(0),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
  archiveMutationId: uuid('archive_mutation_id'),
  archiveExpectedVersion: integer('archive_expected_version'),
  archivedByHost: uuid('archived_by_host').references(() => hosts.id),
  version: integer('version').notNull().default(1),
}, (t) => [
  uniqueIndex('rooms_create_mutation_uq').on(t.createMutationId).where(sql`${t.createMutationId} IS NOT NULL`),
  uniqueIndex('rooms_archive_mutation_uq').on(t.archiveMutationId).where(sql`${t.archiveMutationId} IS NOT NULL`),
]);

export const guests = pgTable('guests', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  roomId: uuid('room_id').notNull().references(() => rooms.id),
  language: language('language').notNull().default('de'),
  createMutationId: uuid('create_mutation_id'),
  createName: text('create_name'),
  createRoomId: uuid('create_room_id').references(() => rooms.id),
  createLanguage: language('create_language'),
  createdByHost: uuid('created_by_host').references(() => hosts.id),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
  archiveMutationId: uuid('archive_mutation_id'),
  archiveExpectedVersion: integer('archive_expected_version'),
  archivedByHost: uuid('archived_by_host').references(() => hosts.id),
  version: integer('version').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('guests_room_idx').on(t.roomId),
  uniqueIndex('guests_create_mutation_uq').on(t.createMutationId).where(sql`${t.createMutationId} IS NOT NULL`),
  uniqueIndex('guests_archive_mutation_uq').on(t.archiveMutationId).where(sql`${t.archiveMutationId} IS NOT NULL`),
]);

export const categories = pgTable('categories', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: jsonb('name').notNull(),
  createMutationId: uuid('create_mutation_id'),
  createName: jsonb('create_name'),
  createdByHost: uuid('created_by_host').references(() => hosts.id),
  position: integer('position').notNull().default(0),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
  version: integer('version').notNull().default(1),
}, (t) => [uniqueIndex('categories_create_mutation_uq').on(t.createMutationId).where(sql`${t.createMutationId} IS NOT NULL`)]);

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
  archiveMutationId: uuid('archive_mutation_id'),
  archiveExpectedVersion: integer('archive_expected_version'),
  archivedByHost: uuid('archived_by_host').references(() => hosts.id),
  version: integer('version').notNull().default(1),
}, (t) => [
  check('products_price_cents_check', sql`${t.priceCents} >= 0`),
  uniqueIndex('products_archive_mutation_uq').on(t.archiveMutationId).where(sql`${t.archiveMutationId} IS NOT NULL`),
]);

export const productCreateCommands = pgTable('product_create_commands', {
  mutationId: uuid('mutation_id').primaryKey(),
  hostId: uuid('host_id').notNull().references(() => hosts.id),
  productId: uuid('product_id').unique('product_create_commands_product_id_key').references(() => products.id),
  categoryId: uuid('category_id').notNull().references(() => categories.id),
  name: jsonb('name').notNull(),
  description: jsonb('description'),
  priceCents: integer('price_cents').notNull(),
  enabled: boolean('enabled').notNull(),
  selfServiceOnly: boolean('self_service_only').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const hostAccountCommands = pgTable('host_account_commands', {
  mutationId: uuid('mutation_id').primaryKey(),
  hostId: uuid('host_id').notNull().references(() => hosts.id),
  commandHash: text('command_hash').notNull(),
  resultName: text('result_name').notNull(),
  resultLanguage: language('result_language').notNull(),
  resultVersion: integer('result_version').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const productVersions = pgTable('product_versions', {
  productId: uuid('product_id').notNull().references(() => products.id),
  catalogVersion: integer('catalog_version').notNull(),
  name: jsonb('name').notNull(),
  priceCents: integer('price_cents').notNull(),
  enabled: boolean('enabled').notNull(),
  selfServiceOnly: boolean('self_service_only').notNull(),
}, (t) => [primaryKey({ columns: [t.productId, t.catalogVersion], name: 'product_versions_pkey' })]);

export const orderTabs = pgTable('order_tabs', {
  id: uuid('id').primaryKey().defaultRandom(),
  guestId: uuid('guest_id').notNull().references(() => guests.id),
  status: text('status').notNull().default('open'),
  openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
  closedAt: timestamp('closed_at', { withTimezone: true }),
}, (t) => [uniqueIndex('one_open_tab_per_guest').on(t.guestId).where(sql`${t.status} = 'open'`)]);

export const orderBatches = pgTable('order_batches', {
  id: uuid('id').primaryKey().defaultRandom(),
  mutationId: uuid('mutation_id').notNull().unique('order_batches_mutation_id_key'),
  tabId: uuid('tab_id').notNull().references(() => orderTabs.id),
  hostId: uuid('host_id').notNull().references(() => hosts.id),
  command: jsonb('command').notNull(),
  capturedAt: timestamp('captured_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const bills = pgTable('bills', {
  id: uuid('id').primaryKey().defaultRandom(),
  number: bigint('number', { mode: 'bigint' }).generatedAlwaysAsIdentity().unique('bills_number_key'),
  tabId: uuid('tab_id').notNull().references(() => orderTabs.id),
  guestId: uuid('guest_id').notNull().references(() => guests.id),
  hostId: uuid('host_id').notNull().references(() => hosts.id),
  mutationId: uuid('mutation_id').notNull().unique('bills_mutation_id_key'),
  venueName: text('venue_name').notNull(),
  venueTimezone: text('venue_timezone').notNull(),
  guestName: text('guest_name').notNull(),
  roomName: text('room_name').notNull(),
  hostName: text('host_name').notNull(),
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
  submittedByGuestSession: uuid('submitted_by_guest_session').references((): AnyPgColumn => guestSessions.id),
  provisionalUntil: timestamp('provisional_until', { withTimezone: true }),
  guestMutationId: uuid('guest_mutation_id').unique('order_items_guest_mutation_id_key'),
  guestExpectedPriceCents: integer('guest_expected_price_cents'),
  guestExpectedProductVersion: integer('guest_expected_product_version'),
  billingVersion: integer('billing_version').notNull().default(0),
  billId: uuid('bill_id').references(() => bills.id),
  voidedAt: timestamp('voided_at', { withTimezone: true }),
  voidedByHost: uuid('voided_by_host').references(() => hosts.id),
  voidReason: text('void_reason'),
  hostVoidMutationId: uuid('host_void_mutation_id'),
  hostVoidExpectedBillingVersion: integer('host_void_expected_billing_version'),
  guestUndoMutationId: uuid('guest_undo_mutation_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check('order_items_quantity_check', sql`${t.quantity} > 0`),
  check('order_items_billing_version_check', sql`${t.billingVersion} >= 0`),
  check('order_items_guest_snapshot_check', sql`${t.source} <> 'guest' OR (${t.guestExpectedPriceCents} IS NOT NULL AND ${t.guestExpectedPriceCents} >= 0 AND ${t.guestExpectedProductVersion} IS NOT NULL AND ${t.guestExpectedProductVersion} > 0)`),
  check('order_items_host_void_expected_billing_version_check', sql`${t.hostVoidExpectedBillingVersion} IS NULL OR ${t.hostVoidExpectedBillingVersion} >= 0`),
  index('order_items_tab_idx').on(t.tabId),
  index('order_items_active_status_idx').on(t.status).where(sql`${t.status} IN ('open','provisional')`),
  uniqueIndex('order_items_host_void_mutation_uq').on(t.hostVoidMutationId).where(sql`${t.hostVoidMutationId} IS NOT NULL`),
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
}, (t) => [index('bill_items_bill_idx').on(t.billId)]);

export const accessRequests = pgTable('access_requests', {
  id: uuid('id').primaryKey().defaultRandom(),
  mutationId: uuid('mutation_id').notNull(),
  name: text('name').notNull(),
  roomId: uuid('room_id').notNull().references(() => rooms.id),
  language: language('language').notNull().default('de'),
  status: requestStatus('status').notNull().default('pending'),
  statusTokenHash: text('status_token_hash').notNull().unique('access_requests_status_token_hash_key'),
  statusTokenKeyId: text('status_token_key_id').notNull(),
  guestId: uuid('guest_id').references(() => guests.id),
  requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  resolvedBy: uuid('resolved_by').references(() => hosts.id),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  approvalMutationId: uuid('approval_mutation_id'),
  approvalLinkedGuestId: uuid('approval_linked_guest_id').references(() => guests.id),
  approvalExpiresAt: timestamp('approval_expires_at', { withTimezone: true }),
  denialMutationId: uuid('denial_mutation_id'),
  statusTokenConsumedAt: timestamp('status_token_consumed_at', { withTimezone: true }),
  grantExchangeId: uuid('grant_exchange_id'),
}, (t) => [
  uniqueIndex('access_requests_mutation_id_uq').on(t.mutationId),
  uniqueIndex('access_requests_approval_mutation_uq').on(t.approvalMutationId).where(sql`${t.approvalMutationId} IS NOT NULL`),
  uniqueIndex('access_requests_denial_mutation_uq').on(t.denialMutationId).where(sql`${t.denialMutationId} IS NOT NULL`),
]);

export const guestSessions = pgTable('guest_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  guestId: uuid('guest_id').notNull().references(() => guests.id),
  requestId: uuid('request_id').notNull().references(() => accessRequests.id),
  tokenHash: text('token_hash').notNull().unique('guest_sessions_token_hash_key'),
  userAgent: text('user_agent').notNull().default('Unknown device'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
}, (t) => [uniqueIndex('guest_sessions_request_id_uq').on(t.requestId)]);

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

export const realtimeEventCommitLock = pgTable('realtime_event_commit_lock', {
  singleton: boolean('singleton').primaryKey().default(true),
}, (t) => [check('realtime_event_commit_lock_singleton_check', sql`${t.singleton}`)]);

export const realtimeEvents = pgTable('realtime_events', {
  id: bigint('id', { mode: 'bigint' }).primaryKey().generatedAlwaysAsIdentity(),
  topic: text('topic').notNull(),
  payload: jsonb('payload').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const rateLimitCounters = pgTable('rate_limit_counters', {
  scope: text('scope').notNull(),
  keyHash: text('key_hash').notNull(),
  count: integer('count').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
}, (t) => [
  primaryKey({ columns: [t.scope, t.keyHash], name: 'rate_limit_counters_pkey' }),
  index('rate_limit_counters_expiry_idx').on(t.expiresAt),
]);
