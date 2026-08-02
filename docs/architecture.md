# Architecture

## Runtime topology

The production container serves the built React PWA and Fastify API from one origin. PostgreSQL is the durable source of truth. Server-sent events are invalidation hints; clients always refetch authoritative REST resources after an event or reconnect.

The browser stores the application shell and explicitly non-identity-scoped bootstrap/catalog responses through Workbox. IndexedDB stores only replayable host mutations, partitioned by the originating host identity. Authentication remains cookie-based and is never persisted in application storage.

## Identity and authorization

Hosts authenticate with email and Argon2id-hashed passwords. Opaque session tokens are HMAC-hashed in PostgreSQL and sent only in Secure, HttpOnly, SameSite cookies. Admins manage configuration, venue identity, host accounts, and bill reversals; staff handle rooms/guests operationally, access requests, orders, and settlement.

Long-lived event streams revalidate their bound host or guest session periodically and before sending an event. Revoked, expired, archived, or disabled identities have their streams closed.

Command-line administrator credential recovery revokes every active session for that account in the same transaction as the password reset. The administrator must sign in again on every device after recovery.

Public guest requests carry a one-time status token. Approval links or creates a guest in the requested room and assigns an expiry. The requesting browser atomically consumes approved status for one expiring device grant. Requests, live guest sessions, and realtime events reveal data only for their bound guest.

## Order and bill lifecycle

Products have catalog versions. An offline order references the catalog version displayed during capture, allowing the API to snapshot the matching name and price rather than silently applying a later price.

Host product selections are submitted as an atomic batch. Guest self-service selections create one provisional line with a server-enforced 10-second undo deadline. Submissions and undo commands retain UUID mutation keys until their outcomes are known. Open-tab totals include provisional items, but settlement rejects the tab until all undo deadlines pass. Each open tab is capped at PostgreSQL's signed 32-bit integer-cent range; writers lock the guest and tab and reject additions that would exceed it. Guest archival uses the same guest lock and cannot race past new financial items.

Settlement locks the open tab and items, creates the bill and immutable bill lines, snapshots the current venue/guest/room identity, marks order items billed, and closes the tab in one transaction. A later venue rename only affects operational UI and new bills. Admin reversal voids the bill through an audit event and moves original order items into the guest's current tab.

The bill archive is searched and paginated by the API rather than truncated in the browser, so older records remain discoverable by bill number, guest, or room.

## Offline and concurrency

The host PWA queues order batches and eligible item-void commands when `navigator.onLine` is false. Each record is bound to its originating host, and the API rejects replay under another identity. UUID mutation keys make replay idempotent and are retained when an online response is uncertain. If another device settles before a queued addition arrives, that addition creates a new tab. Permanent client conflicts are quarantined for host review so later queue entries can continue; transient failures remain pending and stop the current replay pass.

Billing, guest creation, access approval, catalog configuration, and venue settings are online-only. This boundary prevents duplicate settlement and unsafe configuration merges.

## Localization and responsive layout

UI/device language is DE, IT, or EN. Unsupported device languages fall back to DE. Localized catalog fields require German and fall back to German when Italian or English text is empty.

The narrow/portrait layout uses bottom navigation; wide landscape layouts use a left rail. Take Orders is visually prominent in both. Touch targets are at least 44px and safe-area insets are respected.
