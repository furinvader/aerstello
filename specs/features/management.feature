Feature: Venue operations configuration
  Administrators maintain rooms, guests, categories, and orderable products without erasing history.

  Scenario: An administrator creates and renames a room
    Given an authenticated administrator
    When the administrator creates room "Garden 7"
    Then room "Garden 7" is listed
    When the administrator renames room "Garden 7" to "Garden 8"
    Then room "Garden 8" is listed

  Scenario: An uncertain room creation is recovered idempotently
    Given an authenticated administrator
    When the administrator retries room creation after its first response is lost
    Then both room creation attempts use the same mutation identifier
    And only one recoverable room exists
    And changing the replayed room creation is rejected

  Scenario: A host creates and edits a guest
    Given an authenticated administrator
    When the host creates guest "Ada Test" in room "101"
    Then guest "Ada Test" is listed in room "101"

  Scenario: Committed guests are published to other devices
    Given an authenticated administrator
    When another device creates guest "Realtime Guest" in room "101"
    Then guest "Realtime Guest" appears after the committed event

  Scenario: An administrator creates a localized self-service product
    Given an authenticated administrator
    When the administrator creates the self-service product "Apfelsaft" priced "3.10"
    Then product "Apfelsaft" is listed as self-service

  Scenario: An uncertain product creation is recovered idempotently
    Given an authenticated administrator
    When the administrator retries product creation after its first response is lost
    Then both product creation attempts use the same mutation identifier
    And only one recoverable product exists
    And changing the replayed product creation is rejected

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

  Scenario: Guest archival and new orders are serialized
    Given an authenticated administrator
    When guest archival races with a new order
    Then either the archive or the order is rejected
