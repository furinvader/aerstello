@area-management
Feature: Venue operations configuration
  Administrators maintain rooms, guests, categories, and orderable products without erasing history.

  @id-an-administrator-creates-and-renames-a-room
  Scenario: An administrator creates and renames a room
    Given an authenticated administrator
    When the administrator creates room "Garden 7"
    Then room "Garden 7" is listed
    When the administrator renames room "Garden 7" to "Garden 8"
    Then room "Garden 8" is listed

  @id-invalid-room-renames-are-explained
  Scenario: Invalid room renames are explained
    Given an authenticated administrator
    When the administrator submits an invalid room rename
    Then the room editor shows a validation error

  @id-a-stale-room-retry-cannot-overwrite-a-newer-rename
  Scenario: A stale room retry cannot overwrite a newer rename
    Given an authenticated administrator
    When a room rename response is lost before another administrator renames it
    Then retrying the stale room rename is rejected
    And the newer room name remains configured

  @id-an-uncertain-room-creation-is-recovered-idempotently
  Scenario: An uncertain room creation is recovered idempotently
    Given an authenticated administrator
    When the administrator retries room creation after its first response is lost
    Then both room creation attempts use the same mutation identifier
    And the uncertain room name stays locked for retry
    And only one recoverable room exists
    And changing the replayed room creation is rejected

  @id-an-uncertain-category-creation-is-recovered-idempotently
  Scenario: An uncertain category creation is recovered idempotently
    Given an authenticated administrator
    When the administrator retries category creation after its first response is lost
    Then both category creation attempts use the same mutation identifier
    And the uncertain category name stays locked for retry
    And only one recoverable category exists
    And changing the replayed category creation is rejected

  @id-a-host-creates-and-edits-a-guest
  Scenario: A host creates and edits a guest
    Given an authenticated administrator
    When the host creates guest "Ada Test" in room "101"
    Then guest "Ada Test" is listed in room "101"

  @id-a-guest-directory-failure-can-be-retried
  Scenario: A guest directory failure can be retried
    Given an authenticated administrator
    When the guest directory fails to load
    Then the guest directory failure is localized instead of empty
    When the host retries the guest directory
    Then existing guests appear after guest directory recovery

  @id-a-stale-guest-retry-cannot-overwrite-a-newer-edit
  Scenario: A stale guest retry cannot overwrite a newer edit
    Given an authenticated administrator
    When a guest update response is lost before another host edits the guest
    Then retrying the stale guest update is rejected
    And the newer guest name remains configured

  @id-an-uncertain-guest-creation-is-recovered-idempotently
  Scenario: An uncertain guest creation is recovered idempotently
    Given an authenticated administrator
    When the host retries guest creation after its first response is lost
    Then both guest creation attempts use the same mutation identifier
    And the uncertain guest fields stay locked for retry
    And only one recoverable guest exists
    And changing the replayed guest creation is rejected

  @id-an-uncertain-guest-creation-cannot-be-dismissed
  Scenario: An uncertain guest creation cannot be dismissed
    Given an authenticated administrator
    When the host tries to close a guest creation whose response was lost
    Then the uncertain guest creation remains open for retry

  @id-a-guest-creation-survives-a-committed-http-timeout
  Scenario: A guest creation survives a committed HTTP timeout
    Given an authenticated administrator
    When the host retries guest creation after a committed HTTP timeout
    Then both timed-out guest creations use the same mutation identifier
    And only one timed-out guest exists

  @id-committed-guests-are-published-to-other-devices @cross-device
  Scenario: Committed guests are published to other devices
    Given an authenticated administrator
    When another device creates guest "Realtime Guest" in room "101"
    Then guest "Realtime Guest" appears after the committed event

  @id-guest-archival-reports-an-order-acquired-after-confirmation
  Scenario: Guest archival reports an order acquired after confirmation
    Given an authenticated administrator
    When a guest receives an order while their archive confirmation is open
    Then the archive confirmation explains that the order must be settled

  @id-an-uncertain-guest-archival-is-recovered-idempotently
  Scenario: An uncertain guest archival is recovered idempotently
    Given an authenticated administrator
    When the host retries guest archival after its response is lost
    Then both guest archival attempts use the same mutation identifier
    And the uncertain guest archival cannot be closed
    And the guest is archived only once

  @id-a-stale-guest-archival-cannot-remove-a-newer-edit
  Scenario: A stale guest archival cannot remove a newer edit
    Given an authenticated administrator
    When another host edits a guest before a stale archival arrives
    Then the stale guest archival is rejected
    And the guest's newer edit remains configured

  @id-an-administrator-creates-a-localized-self-service-product
  Scenario: An administrator creates a localized self-service product
    Given an authenticated administrator
    When the administrator creates the self-service product "Apfelsaft" priced "3.10"
    Then product "Apfelsaft" is listed as self-service

  @id-a-catalog-administration-failure-recovers-authoritative-data
  Scenario: A catalog administration failure recovers authoritative data
    Given an authenticated administrator
    When catalog administration remains pending
    Then catalog loading hides empty and mutation controls
    When the pending catalog administration request fails
    Then catalog failure and retry are localized without mutation controls
    When the administrator retries catalog administration
    Then recovered catalog names, counts, rows, and creation controls appear

  @id-an-uncertain-product-creation-is-recovered-idempotently
  Scenario: An uncertain product creation is recovered idempotently
    Given an authenticated administrator
    When the administrator retries product creation after its first response is lost
    Then both product creation attempts use the same mutation identifier
    And the uncertain product fields stay locked for retry
    And only one recoverable product exists
    And changing the replayed product creation is rejected

  @id-a-stale-product-retry-cannot-overwrite-a-newer-edit
  Scenario: A stale product retry cannot overwrite a newer edit
    Given an authenticated administrator
    When a product update response is lost before another administrator edits it
    Then retrying the stale product update is rejected
    And the newer product price remains configured

  @id-an-uncertain-product-archival-is-recovered-idempotently
  Scenario: An uncertain product archival is recovered idempotently
    Given an authenticated administrator
    When the administrator retries product archival after its response is lost
    Then both product archival attempts use the same mutation identifier
    And the uncertain product fields stay locked for archival retry
    And the product is archived only once

  @id-a-stale-product-archival-cannot-remove-a-newer-edit
  Scenario: A stale product archival cannot remove a newer edit
    Given an authenticated administrator
    When another administrator edits a product before a stale archival arrives
    Then the stale product archival is rejected
    And the product's newer edit remains configured

  @id-guest-changes-and-their-realtime-event-commit-together
  Scenario: Guest changes and their realtime event commit together
    Given an authenticated administrator
    When realtime event persistence fails during a guest edit
    Then the guest edit is rolled back

  @id-product-prices-require-exact-cents
  Scenario: Product prices require exact cents
    Given an authenticated administrator
    When the administrator tries to create product "Invalid price" priced "1.005"
    Then the product price is rejected before submission

  @id-guests-cannot-be-assigned-to-an-archived-room
  Scenario: Guests cannot be assigned to an archived room
    Given an authenticated administrator
    When the host attempts to create a guest in an archived room
    Then the archived room guest is rejected

  @id-a-room-with-pending-access-requests-cannot-be-archived
  Scenario: A room with pending access requests cannot be archived
    Given an authenticated administrator
    When the administrator archives a room with a pending access request
    Then room archival is rejected and the request remains pending

  @id-a-room-with-active-guests-cannot-be-archived
  Scenario: A room with active guests cannot be archived
    Given an authenticated administrator
    When the administrator archives a room with an active guest
    Then the room screen explains that active guests must be moved

  @id-a-room-directory-failure-recovers-authoritative-controls
  Scenario: A room directory failure recovers authoritative controls
    Given an authenticated administrator
    When room management remains pending
    Then room loading hides empty and mutation controls
    When the pending room directory request fails
    Then room failure and retry are localized without mutation controls
    When the administrator retries the room directory
    Then recovered rooms and room mutation controls appear

  @id-an-uncertain-room-archival-is-recovered-idempotently
  Scenario: An uncertain room archival is recovered idempotently
    Given an authenticated administrator
    When the administrator retries room archival after its response is lost
    Then both room archival attempts use the same mutation identifier
    And the room is archived only once

  @id-a-stale-room-archival-cannot-remove-a-newer-change
  Scenario: A stale room archival cannot remove a newer change
    Given an authenticated administrator
    When another administrator renames a room before a stale archival arrives
    Then the stale room archival is rejected
    And the room's newer name remains configured

  @id-concurrent-room-reorders-lock-rooms-consistently @cross-device
  Scenario: Concurrent room reorders lock rooms consistently
    Given an authenticated administrator
    When administrators submit conflicting room orders concurrently
    Then every room reorder completes without a server error

  @id-realtime-changes-propagate-between-api-replicas @cross-device
  Scenario: Realtime changes propagate between API replicas
    Given an authenticated administrator
    When another API replica creates a room
    Then the connected host receives the other replica room event

  @id-realtime-events-remain-ordered-across-concurrent-commits @cross-device
  Scenario: Realtime events remain ordered across concurrent commits
    Given an authenticated administrator
    When realtime events try to commit out of identity order
    Then the later realtime insertion waits for the earlier transaction
    And the connected host receives both realtime events in commit order

  @id-a-stale-room-reorder-cannot-overwrite-a-newer-order
  Scenario: A stale room reorder cannot overwrite a newer order
    Given an authenticated administrator
    When a room reorder response is lost before another administrator reorders rooms
    Then retrying the stale room reorder is rejected
    And the newer room order remains configured

  @id-guest-archival-and-new-orders-are-serialized
  Scenario: Guest archival and new orders are serialized
    Given an authenticated administrator
    When guest archival races with a new order
    Then either the archive or the order is rejected
