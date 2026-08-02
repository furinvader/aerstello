Feature: Device grants and replay protection
  Security-sensitive mutations remain bound to the identity and catalog state that created them.

  Scenario: An approved request token grants exactly one device
    Given an authenticated administrator
    When two devices exchange the same approved access request token
    Then exactly one device receives guest access

  Scenario: An access request cannot be linked across rooms
    Given an authenticated administrator
    When the host links a room "102" request to a guest in room "101"
    Then the cross-room approval is rejected

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
