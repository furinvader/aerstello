Feature: Host order entry and billing
  Hosts build atomic orders for a room guest and settle their complete tab.

  Scenario: A host takes and settles an order
    Given an authenticated administrator
    When the host adds one "Helles" to "Anna Berger" in room "101"
    Then the staged cart total is "4,20 €"
    When the host submits the order
    Then Anna's open tab contains one item
    When the host settles the tab with cash
    Then the bill shows the venue name "Hotel Aurora"
    And the bill offers printing

  Scenario: An offline host order is queued for synchronization
    Given an authenticated administrator with the order catalog loaded
    When the device goes offline and the host submits one "Helles" for "Anna Berger" in room "101"
    Then the order is marked as queued for synchronization

  Scenario: An uncertain order response is retried idempotently
    Given an authenticated administrator
    When the host retries an order after its first response is lost
    Then both order attempts use the same mutation identifier
    And the guest tab contains the order only once

  Scenario: An uncertain settlement response is retried idempotently
    Given an authenticated administrator
    When the host retries settlement after its first response is lost
    Then both settlement attempts use the same mutation identifier
    And the host reaches the single resulting bill

  Scenario: An open tab cannot exceed the database money range
    Given an authenticated administrator
    When the host submits orders beyond the maximum tab total
    Then the excessive order is rejected without changing the tab
