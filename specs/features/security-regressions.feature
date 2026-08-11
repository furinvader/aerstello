@area-security
Feature: Device grants and replay protection
  Security-sensitive mutations remain bound to the identity and catalog state that created them.

  @id-an-approved-request-token-grants-exactly-one-device
  Scenario: An approved request token grants exactly one device
    Given an authenticated administrator
    When two devices exchange the same approved access request token
    Then exactly one device receives guest access

  @id-grant-exchange-does-not-expose-its-token-in-the-url
  Scenario: Grant exchange does not expose its token in the URL
    Given an authenticated administrator
    When an approved request is exchanged for a guest grant
    Then the grant token is sent in the request body

  @id-guest-access-pollers-behind-one-network-do-not-block-each-other
  Scenario: Guest access pollers behind one network do not block each other
    Given an authenticated administrator
    When thirteen guest devices poll pending access from one network
    Then none of their valid status polls is rate limited

  @id-rotating-access-capabilities-cannot-bypass-the-network-limit
  Scenario: Rotating access capabilities cannot bypass the network limit
    Given an authenticated administrator
    When one network rotates invalid access capabilities beyond its address limit
    Then the access status address limit is enforced

  @id-access-status-polling-has-an-independent-network-budget
  Scenario: Access status polling has an independent network budget
    Given an authenticated administrator
    When status polling and ordinary traffic reach their limits from one forwarded address
    Then neither address budget consumes the other

  @id-rate-limits-are-shared-by-api-replicas
  Scenario: Rate limits are shared by API replicas
    Given an authenticated administrator
    When requests at the address limit are split across API replicas
    Then the shared address limit is enforced once

  @id-malformed-json-remains-a-definitive-client-error
  Scenario: Malformed JSON remains a definitive client error
    Given the seeded Aerstello venue
    When a client submits malformed JSON
    Then the malformed request is rejected as a client error

  @id-an-archived-guest-cannot-receive-a-pending-grant
  Scenario: An archived guest cannot receive a pending grant
    Given an authenticated administrator
    When guest archival races with their first grant exchange
    Then no archived guest session remains active

  @id-an-access-request-cannot-be-linked-across-rooms
  Scenario: An access request cannot be linked across rooms
    Given an authenticated administrator
    When the host links a room "102" request to a guest in room "101"
    Then the cross-room approval is rejected

  @id-linked-approval-is-serialized-with-guest-changes
  Scenario: Linked approval is serialized with guest changes
    Given an authenticated administrator
    When linked approval races with moving its guest to another room
    Then approval either wins before the move or rejects the moved guest

  @id-an-offline-order-remains-bound-to-its-originating-host
  Scenario: An offline order remains bound to its originating host
    Given an authenticated administrator
    When another host submits the administrator's queued order
    Then the queued order is rejected for the other host

  @id-a-disabled-catalog-snapshot-cannot-be-ordered
  Scenario: A disabled catalog snapshot cannot be ordered
    Given an authenticated administrator
    When the host submits a product disabled in the captured catalog
    Then the captured catalog order is rejected

  @id-replaying-an-item-void-returns-its-prior-success
  Scenario: Replaying an item void returns its prior success
    Given an authenticated administrator
    When the same item void mutation is submitted twice
    Then both item void responses succeed
    And changing the replayed item void reason is rejected
    And changing the replayed item billing version is rejected

  @id-billing-versions-enforce-strict-item-lifecycle-transitions @area-billing
  Scenario: Billing versions enforce strict item lifecycle transitions
    Given an authenticated administrator
    When database writers cross an item billing boundary
    Then billing without an explicit version increment is rejected
    And the database advances the billing version exactly once
    And billing version changes outside billing are rejected
    And the stale item removal remains a billing conflict

  @id-database-settled-financial-records-reject-direct-mutation @area-billing
  Scenario: Database settled financial records reject direct mutation
    Given an authenticated administrator
    When database writers attempt to rewrite settled financial records
    Then direct bill header updates are rejected
    And direct bill header deletes are rejected
    And incomplete bill void transitions are rejected
    And unaudited bill void transitions are rejected
    And mismatched bill void audits are rejected at commit
    And repeated bill void transitions are rejected
    And direct billed order item updates are rejected
    And direct billed order item deletes are rejected
    And direct billed order item reopening is rejected
    And direct settled non-voided tab reopening is rejected
    And audited bill voids retaining billed items are rejected at commit
    And direct bill line updates are rejected
    And direct bill line deletes are rejected
    And direct bill header truncation is rejected
    And direct billed order item truncation is rejected
    And direct bill line truncation is rejected
    And all financial truncate triggers remain enabled after reset
    And the original settled financial snapshots remain unchanged
    And normal settlement and audited bill reversal remain valid

  @id-committed-historical-evidence-remains-append-only
  Scenario: Committed historical evidence remains append-only
    Given an authenticated administrator
    When direct database writers target committed historical evidence
    Then audit and catalog history reject updates, deletes, and truncation
    And the original historical evidence remains unchanged
    And historical truncate guards remain enabled after reset
    And normal audited voids and catalog history insertion remain valid

  @id-concurrent-replay-of-an-order-returns-its-prior-success @cross-device
  Scenario: Concurrent replay of an order returns its prior success
    Given an authenticated administrator
    When the same order mutation is submitted concurrently
    Then both concurrent order responses succeed
    And the concurrent order is stored only once

  @id-a-settlement-replay-cannot-change-payment-details @area-billing
  Scenario: A settlement replay cannot change payment details
    Given an authenticated administrator
    When a settlement mutation is replayed with another payment method
    Then the changed settlement replay is rejected

  @id-replaying-a-bill-void-returns-its-prior-success @area-billing
  Scenario: Replaying a bill void returns its prior success
    Given an authenticated administrator
    When the same bill void mutation is submitted twice
    Then both bill void responses succeed
    And the billed items are restored only once
    And changing the replayed bill void reason is rejected

  @id-bill-reversal-and-guest-archival-are-serialized @area-billing
  Scenario: Bill reversal and guest archival are serialized
    Given an authenticated administrator
    When guest archival races with reversal of their bill
    Then the bill reversal succeeds before or after guest archival

  @id-a-corrected-archived-guest-tab-stays-operable
  Scenario: A corrected archived-guest tab stays operable
    Given an authenticated administrator
    When the administrator reverses a bill for an archived guest
    Then the archived guest bill is voided and its item is restored
    And the corrected archived guest tab opens from host orders without enabling new orders
    When the host settles the corrected archived guest tab
    Then the host reaches its corrected bill

  @id-a-bill-correction-remains-available-at-the-tab-limit @area-billing
  Scenario: A bill correction remains available at the tab limit
    Given an authenticated administrator
    When the administrator reverses a bill onto a tab at the money limit
    Then the correction succeeds and restores the billed item
    And normal additions remain blocked while the corrected tab exceeds the limit

  @id-revoked-sessions-stop-receiving-realtime-events
  Scenario: Revoked sessions stop receiving realtime events
    Given an authenticated administrator
    When the administrator session is revoked while its event stream is open
    Then the revoked stream receives no later venue events
