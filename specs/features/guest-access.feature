Feature: Guest device access and self-service
  Guests request a device-bound login and self-report items from the self-service bar.

  Scenario: A guest request updates the host and can be approved
    Given an authenticated administrator and a separate guest device
    When "Luca Rossi" requests access for room "102"
    Then the host sees the pending request for "Luca Rossi"
    When the host approves the request for one day
    Then the guest device opens Luca's guest view without a password

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

  Scenario: An uncertain guest undo response is retried idempotently
    Given an approved guest device for "Luca Rossi" in room "102"
    When the guest retries undo after its first response is lost
    Then both guest undo attempts use the same mutation identifier
    And the guest tab has no open items
