Feature: Guest device access and self-service
  Guests request a device-bound login and self-report items from the self-service bar.

  Scenario: A guest request updates the host and can be approved
    Given an authenticated administrator and a separate guest device
    When "Luca Rossi" requests access for room "102"
    Then the host sees the pending request for "Luca Rossi"
    When the host approves the request for one day
    Then the guest device opens Luca's guest view without a password

  Scenario: Approval defaults to a separate guest identity
    Given an authenticated administrator and a separate guest device
    When "New Roommate" requests access for room "101"
    Then the host sees the pending request for "New Roommate"
    When the host opens approval for "New Roommate"
    Then creating a new guest is selected by default

  Scenario: An uncertain access approval is recovered idempotently
    Given an authenticated administrator and a separate guest device
    When the host retries an approval after its first response is lost
    Then both approval attempts use the same mutation identifier
    And approval fields stay locked while the result is uncertain
    And only one approved guest identity exists
    And the guest device receives access

  Scenario: An uncertain access request response is recoverable
    Given an authenticated administrator and a separate guest device
    When the guest retries an access request after its first response is lost
    Then both access request attempts use the same mutation identifier
    And the uncertain access request fields stay locked for retry
    And the host sees only one pending request from that guest

  Scenario: A pending access request survives closing the app
    Given an authenticated administrator and a separate guest device
    When "Persistent Guest" requests access for room "102"
    Then the host sees the pending request for "Persistent Guest"
    When the guest closes the pending request page
    And the host approves the request for one day
    Then reopening the request restores the approved guest access

  Scenario: A denied access request stops polling
    Given an authenticated administrator and a separate guest device
    When "Denied Poller" requests access for room "102"
    Then the host sees the pending request for "Denied Poller"
    When the host denies the request for "Denied Poller"
    Then the denied guest device stops status polling

  Scenario: An uncertain access denial is recovered idempotently
    Given an authenticated administrator and a separate guest device
    When the host retries a denial after its first response is lost
    Then both denial attempts use the same mutation identifier
    And the denied request remains resolved only once

  Scenario: Guests see why approved access is unavailable
    Given an authenticated administrator and a separate guest device
    When approved guest access expires before the requesting page exchanges it
    Then the requesting page explains that access expired
    When an approved linked guest is disabled before exchange
    Then the requesting page explains that access is disabled

  Scenario: Approval defaults to one local day
    Given an authenticated administrator
    When a host in a non-UTC timezone opens a guest approval
    Then the approval expiry is one local day from now

  Scenario: A lost grant response can be recovered by the requesting device
    Given an authenticated administrator
    When an approved guest grant response is lost before its cookie is retained
    Then retrying the same grant exchange restores guest access
    And a different grant exchange receives no guest access

  Scenario: A pending access request survives session-secret rotation
    Given an authenticated administrator
    When a pending guest request crosses a session-secret rotation
    Then its original and idempotently reissued capabilities remain pollable
    And the bound grant exchange restores guest access after rotation
    And the rotated replica rejects the old host session

  Scenario: An expired approval cannot be exchanged for guest access
    Given an authenticated administrator
    When an approved guest request expires before its grant exchange
    Then the expired exchange is not consumed or granted

  Scenario: Grant expiry uses the database clock across replicas
    Given an authenticated administrator
    When a clock-skewed API replica exchanges a database-valid grant
    Then the database-valid guest access is granted

  Scenario: Approval expiry uses the database clock across replicas
    Given an authenticated administrator
    When clock-skewed API replicas validate access approval expiries
    Then only the database-valid access approval is accepted

  Scenario: Approval expiry is checked after serialization
    Given an authenticated administrator
    When an access approval expires while waiting for its request lock
    Then the expired approval is rejected without resolving its request

  Scenario: A host revokes one guest device
    Given an approved guest device for "Luca Rossi" in room "102"
    When the host revokes Luca's device from the guest directory
    Then Luca's revoked device loses guest access

  Scenario: Guest-device revocation refreshes another open host client
    Given an approved guest device for "Luca Rossi" in room "102"
    When another host revokes Luca's device while the first host's device list is open
    Then the first host's open guest device list updates

  Scenario: Repeating guest-device revocation does not duplicate its audit
    Given an approved guest device for "Luca Rossi" in room "102"
    When the host repeats revocation of Luca's device
    Then both revocation requests succeed with one audit record
    And the device cannot be revoked through another guest

  Scenario: Remote revocation clears the open guest application
    Given an approved guest device for "Luca Rossi" in room "102"
    When the host revokes Luca's device from the guest directory
    Then Luca's open guest view returns to access request without cached data

  Scenario: Guest identity changes update the open guest application
    Given an approved guest device for "Luca Rossi" in room "102"
    When the host renames Luca to "Luca Nuovo"
    Then Luca's open guest view shows "Luca Nuovo"

  Scenario: A guest can undo a self-service item for ten seconds
    Given an approved guest device for "Luca Rossi" in room "102"
    When the guest adds "Mineralwasser" from self-service
    Then an undo action is available
    When the guest uses undo
    Then the guest tab has no open items
    And the host has no empty open order for "Luca Rossi"

  Scenario: Lock waits do not shorten the guest undo window
    Given an approved guest device for "Luca Rossi" in room "102"
    When a self-service addition waits for a guest lock
    Then the guest still receives a full undo window

  Scenario: Lock waits cannot extend the guest undo window
    Given an approved guest device for "Luca Rossi" in room "102"
    When guest undo starts before expiry and waits behind a rolled-back item lock
    Then the expired guest undo is rejected
    And the self-service item remains on the guest tab

  Scenario: A lost guest logout response clears cached guest data
    Given an approved guest device for "Luca Rossi" in room "102"
    When the guest logs out and the committed response is lost
    Then the guest reaches access request without cached data
    And replaying guest logout for the revoked session succeeds

  Scenario: A guest tab outage never appears as a zero balance
    Given an approved guest device for "Luca Rossi" in room "102"
    When the guest tab service is unavailable
    Then the guest sees an error without a zero balance or empty order

  Scenario: A guest addition is bound to its displayed price
    Given an approved guest device for "Luca Rossi" in room "102"
    When a self-service price changes after the guest catalog is displayed
    Then adding the stale self-service product is rejected without a charge
    And the guest can retry the refreshed self-service product

  Scenario: A guest addition is bound to its displayed product version
    Given an approved guest device for "Luca Rossi" in room "102"
    When a self-service product is renamed after the guest catalog is displayed
    Then adding the stale product snapshot is rejected without a charge
    And the guest catalog shows the renamed product after refresh

  Scenario: A legacy self-service addition recovers its displayed price
    Given an approved guest device for "Luca Rossi" in room "102"
    When the guest retries a legacy pending self-service addition
    Then the legacy addition reuses its mutation with the displayed price
    And the legacy self-service product is stored once

  Scenario: The guest undo control expires on time
    Given an approved guest device for "Luca Rossi" in room "102"
    When the guest adds "Mineralwasser" from self-service
    Then an undo action is available
    And the undo action disappears after ten seconds
    And the expired item is no longer marked provisional

  Scenario: A fast device clock does not shorten a new guest undo window
    Given an approved guest device for "Luca Rossi" in room "102"
    When the guest device clock is twelve hours fast
    And the guest adds "Mineralwasser" from self-service
    Then an undo action is available
    And the undo action disappears after ten seconds

  Scenario: A slow device clock does not extend a refreshed guest undo window
    Given an approved guest device for "Luca Rossi" in room "102"
    When the guest refreshes a provisional item with a device clock twelve hours slow
    Then an undo action is available
    And the undo action disappears after ten seconds
    And the expired item is no longer marked provisional

  Scenario: Every provisional self-service item can be undone
    Given an approved guest device for "Luca Rossi" in room "102"
    When the guest adds two different self-service items
    Then both provisional items offer their own undo action

  Scenario: Guest undo is limited to the device that added the item
    Given an approved guest device for "Luca Rossi" in room "102"
    When another approved device for the same guest adds "Mineralwasser"
    Then the original guest device sees the item without an undo action

  Scenario: Localized category labels do not merge distinct categories
    Given an approved guest device for "Luca Rossi" in room "102"
    When the host adds another self-service category named "Getränke"
    Then both "Getränke" categories remain separate in the guest catalog

  Scenario: Uncertain self-service additions retain their mutation
    Given an approved guest device for "Luca Rossi" in room "102"
    When one guest addition loses its response before another product is added
    Then retrying the uncertain product reuses its mutation identifier
    And each selected self-service product is stored once

  Scenario: An HTTP timeout retains the guest addition mutation
    Given an approved guest device for "Luca Rossi" in room "102"
    When the guest retries an addition after a committed HTTP timeout
    Then both timed-out guest additions use the same mutation identifier
    And the timed-out self-service product is stored once

  Scenario: An uncertain self-service addition survives closing the app
    Given an approved guest device for "Luca Rossi" in room "102"
    When the guest closes the app after a self-service response is lost
    Then reopening and retrying reuses the original item mutation identifier
    And the recovered self-service product is stored once

  Scenario: An uncertain guest undo response is retried idempotently
    Given an approved guest device for "Luca Rossi" in room "102"
    When the guest retries undo after its first response is lost
    Then both guest undo attempts use the same mutation identifier
    And the guest tab has no open items

  Scenario: Concurrent self-service replay returns one item
    Given an approved guest device for "Luca Rossi" in room "102"
    When the same guest item mutation is submitted concurrently
    Then both concurrent guest item responses succeed
    And the concurrent guest item is stored only once
