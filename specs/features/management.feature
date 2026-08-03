Feature: Venue operations configuration
  Administrators maintain rooms, guests, categories, and orderable products without erasing history.

  Scenario: An administrator creates and renames a room
    Given an authenticated administrator
    When the administrator creates room "Garden 7"
    Then room "Garden 7" is listed
    When the administrator renames room "Garden 7" to "Garden 8"
    Then room "Garden 8" is listed

  Scenario: Invalid room renames are explained
    Given an authenticated administrator
    When the administrator submits an invalid room rename
    Then the room editor shows a validation error

  Scenario: A stale room retry cannot overwrite a newer rename
    Given an authenticated administrator
    When a room rename response is lost before another administrator renames it
    Then retrying the stale room rename is rejected
    And the newer room name remains configured

  Scenario: An uncertain room creation is recovered idempotently
    Given an authenticated administrator
    When the administrator retries room creation after its first response is lost
    Then both room creation attempts use the same mutation identifier
    And the uncertain room name stays locked for retry
    And only one recoverable room exists
    And changing the replayed room creation is rejected

  Scenario: An uncertain category creation is recovered idempotently
    Given an authenticated administrator
    When the administrator retries category creation after its first response is lost
    Then both category creation attempts use the same mutation identifier
    And the uncertain category name stays locked for retry
    And only one recoverable category exists
    And changing the replayed category creation is rejected

  Scenario: A host creates and edits a guest
    Given an authenticated administrator
    When the host creates guest "Ada Test" in room "101"
    Then guest "Ada Test" is listed in room "101"

  Scenario: A stale guest retry cannot overwrite a newer edit
    Given an authenticated administrator
    When a guest update response is lost before another host edits the guest
    Then retrying the stale guest update is rejected
    And the newer guest name remains configured

  Scenario: An uncertain guest creation is recovered idempotently
    Given an authenticated administrator
    When the host retries guest creation after its first response is lost
    Then both guest creation attempts use the same mutation identifier
    And the uncertain guest fields stay locked for retry
    And only one recoverable guest exists
    And changing the replayed guest creation is rejected

  Scenario: An uncertain guest creation cannot be dismissed
    Given an authenticated administrator
    When the host tries to close a guest creation whose response was lost
    Then the uncertain guest creation remains open for retry

  Scenario: A guest creation survives a committed HTTP timeout
    Given an authenticated administrator
    When the host retries guest creation after a committed HTTP timeout
    Then both timed-out guest creations use the same mutation identifier
    And only one timed-out guest exists

  Scenario: Committed guests are published to other devices
    Given an authenticated administrator
    When another device creates guest "Realtime Guest" in room "101"
    Then guest "Realtime Guest" appears after the committed event

  Scenario: Guest archival reports an order acquired after confirmation
    Given an authenticated administrator
    When a guest receives an order while their archive confirmation is open
    Then the archive confirmation explains that the order must be settled

  Scenario: An uncertain guest archival is recovered idempotently
    Given an authenticated administrator
    When the host retries guest archival after its response is lost
    Then both guest archival attempts use the same mutation identifier
    And the uncertain guest archival cannot be closed
    And the guest is archived only once

  Scenario: A stale guest archival cannot remove a newer edit
    Given an authenticated administrator
    When another host edits a guest before a stale archival arrives
    Then the stale guest archival is rejected
    And the guest's newer edit remains configured

  Scenario: An administrator creates a localized self-service product
    Given an authenticated administrator
    When the administrator creates the self-service product "Apfelsaft" priced "3.10"
    Then product "Apfelsaft" is listed as self-service

  Scenario: An uncertain product creation is recovered idempotently
    Given an authenticated administrator
    When the administrator retries product creation after its first response is lost
    Then both product creation attempts use the same mutation identifier
    And the uncertain product fields stay locked for retry
    And only one recoverable product exists
    And changing the replayed product creation is rejected

  Scenario: A stale product retry cannot overwrite a newer edit
    Given an authenticated administrator
    When a product update response is lost before another administrator edits it
    Then retrying the stale product update is rejected
    And the newer product price remains configured

  Scenario: An uncertain product archival is recovered idempotently
    Given an authenticated administrator
    When the administrator retries product archival after its response is lost
    Then both product archival attempts use the same mutation identifier
    And the uncertain product fields stay locked for archival retry
    And the product is archived only once

  Scenario: A stale product archival cannot remove a newer edit
    Given an authenticated administrator
    When another administrator edits a product before a stale archival arrives
    Then the stale product archival is rejected
    And the product's newer edit remains configured

  Scenario: Guest changes and their realtime event commit together
    Given an authenticated administrator
    When realtime event persistence fails during a guest edit
    Then the guest edit is rolled back

  Scenario: Product prices require exact cents
    Given an authenticated administrator
    When the administrator tries to create product "Invalid price" priced "1.005"
    Then the product price is rejected before submission

  Scenario: Guests cannot be assigned to an archived room
    Given an authenticated administrator
    When the host attempts to create a guest in an archived room
    Then the archived room guest is rejected

  Scenario: A room with pending access requests cannot be archived
    Given an authenticated administrator
    When the administrator archives a room with a pending access request
    Then room archival is rejected and the request remains pending

  Scenario: A room with active guests cannot be archived
    Given an authenticated administrator
    When the administrator archives a room with an active guest
    Then the room screen explains that active guests must be moved

  Scenario: An uncertain room archival is recovered idempotently
    Given an authenticated administrator
    When the administrator retries room archival after its response is lost
    Then both room archival attempts use the same mutation identifier
    And the room is archived only once

  Scenario: A stale room archival cannot remove a newer change
    Given an authenticated administrator
    When another administrator renames a room before a stale archival arrives
    Then the stale room archival is rejected
    And the room's newer name remains configured

  Scenario: Concurrent room reorders lock rooms consistently
    Given an authenticated administrator
    When administrators submit conflicting room orders concurrently
    Then every room reorder completes without a server error

  Scenario: Realtime changes propagate between API replicas
    Given an authenticated administrator
    When another API replica creates a room
    Then the connected host receives the other replica room event

  Scenario: Realtime events remain ordered across concurrent commits
    Given an authenticated administrator
    When realtime events try to commit out of identity order
    Then the later realtime insertion waits for the earlier transaction
    And the connected host receives both realtime events in commit order

  Scenario: A stale room reorder cannot overwrite a newer order
    Given an authenticated administrator
    When a room reorder response is lost before another administrator reorders rooms
    Then retrying the stale room reorder is rejected
    And the newer room order remains configured

  Scenario: Guest archival and new orders are serialized
    Given an authenticated administrator
    When guest archival races with a new order
    Then either the archive or the order is rejected
