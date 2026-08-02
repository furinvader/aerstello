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

  Scenario: An uncertain access request response is recoverable
    Given an authenticated administrator and a separate guest device
    When the guest retries an access request after its first response is lost
    Then both access request attempts use the same mutation identifier
    And the host sees only one pending request from that guest

  Scenario: A denied access request stops polling
    Given an authenticated administrator and a separate guest device
    When "Denied Poller" requests access for room "102"
    Then the host sees the pending request for "Denied Poller"
    When the host denies the request for "Denied Poller"
    Then the denied guest device stops status polling

  Scenario: Approval defaults to one local day
    Given an authenticated administrator
    When a host in a non-UTC timezone opens a guest approval
    Then the approval expiry is one local day from now

  Scenario: A lost grant response can be recovered by the requesting device
    Given an authenticated administrator
    When an approved guest grant response is lost before its cookie is retained
    Then retrying the same grant exchange restores guest access
    And a different grant exchange receives no guest access

  Scenario: An expired approval cannot be exchanged for guest access
    Given an authenticated administrator
    When an approved guest request expires before its grant exchange
    Then the expired exchange is not consumed or granted

  Scenario: A host revokes one guest device
    Given an approved guest device for "Luca Rossi" in room "102"
    When the host revokes Luca's device from the guest directory
    Then Luca's revoked device loses guest access

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

  Scenario: The guest undo control expires on time
    Given an approved guest device for "Luca Rossi" in room "102"
    When the guest adds "Mineralwasser" from self-service
    Then an undo action is available
    And the undo action disappears after ten seconds

  Scenario: Every provisional self-service item can be undone
    Given an approved guest device for "Luca Rossi" in room "102"
    When the guest adds two different self-service items
    Then both provisional items offer their own undo action

  Scenario: Uncertain self-service additions retain their mutation
    Given an approved guest device for "Luca Rossi" in room "102"
    When one guest addition loses its response before another product is added
    Then retrying the uncertain product reuses its mutation identifier
    And each selected self-service product is stored once

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
