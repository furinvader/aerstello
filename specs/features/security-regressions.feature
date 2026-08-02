Feature: Device grants and replay protection
  Security-sensitive mutations remain bound to the identity and catalog state that created them.

  Scenario: An approved request token grants exactly one device
    Given an authenticated administrator
    When two devices exchange the same approved access request token
    Then exactly one device receives guest access

  Scenario: Grant exchange does not expose its token in the URL
    Given an authenticated administrator
    When an approved request is exchanged for a guest grant
    Then the grant token is sent in the request body

  Scenario: Guest access pollers behind one network do not block each other
    Given an authenticated administrator
    When thirteen guest devices poll pending access from one network
    Then none of their valid status polls is rate limited

  Scenario: An archived guest cannot receive a pending grant
    Given an authenticated administrator
    When guest archival races with their first grant exchange
    Then no archived guest session remains active

  Scenario: An access request cannot be linked across rooms
    Given an authenticated administrator
    When the host links a room "102" request to a guest in room "101"
    Then the cross-room approval is rejected

  Scenario: Linked approval is serialized with guest changes
    Given an authenticated administrator
    When linked approval races with moving its guest to another room
    Then approval either wins before the move or rejects the moved guest

  Scenario: An offline order remains bound to its originating host
    Given an authenticated administrator
    When another host submits the administrator's queued order
    Then the queued order is rejected for the other host

  Scenario: A disabled catalog snapshot cannot be ordered
    Given an authenticated administrator
    When the host submits a product disabled in the captured catalog
    Then the captured catalog order is rejected

  Scenario: Replaying an item void returns its prior success
    Given an authenticated administrator
    When the same item void mutation is submitted twice
    Then both item void responses succeed
    And changing the replayed item void reason is rejected

  Scenario: Concurrent replay of an order returns its prior success
    Given an authenticated administrator
    When the same order mutation is submitted concurrently
    Then both concurrent order responses succeed
    And the concurrent order is stored only once

  Scenario: A settlement replay cannot change payment details
    Given an authenticated administrator
    When a settlement mutation is replayed with another payment method
    Then the changed settlement replay is rejected

  Scenario: Replaying a bill void returns its prior success
    Given an authenticated administrator
    When the same bill void mutation is submitted twice
    Then both bill void responses succeed
    And the billed items are restored only once
    And changing the replayed bill void reason is rejected

  Scenario: Bill reversal and guest archival are serialized
    Given an authenticated administrator
    When guest archival races with reversal of their bill
    Then the bill reversal succeeds before or after guest archival

  Scenario: A bill can be corrected after its guest is archived
    Given an authenticated administrator
    When the administrator reverses a bill for an archived guest
    Then the archived guest bill is voided and its item is restored

  Scenario: A bill correction remains available at the tab limit
    Given an authenticated administrator
    When the administrator reverses a bill onto a tab at the money limit
    Then the correction succeeds and restores the billed item
    And normal additions remain blocked while the corrected tab exceeds the limit

  Scenario: Revoked sessions stop receiving realtime events
    Given an authenticated administrator
    When the administrator session is revoked while its event stream is open
    Then the revoked stream receives no later venue events
