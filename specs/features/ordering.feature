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

  Scenario: Changing guests cannot transfer a staged cart
    Given an authenticated administrator
    When the host stages an order for Anna and confirms a switch to Luca
    Then the staged cart is cleared before Luca is selected
    And Luca's tab is unchanged

  Scenario: An offline host order is queued for synchronization
    Given an authenticated administrator with the order catalog loaded
    When the device goes offline and the host submits one "Helles" for "Anna Berger" in room "101"
    Then the order is marked as queued for synchronization

  Scenario: A version-one queued order survives the database upgrade
    Given a version-one device database contains a queued financial mutation
    Then the queued financial mutation is preserved for review

  Scenario: A host removes an incorrect item while offline
    Given an authenticated administrator
    And an open "Helles" order for "Anna Berger" in room "101"
    When the host removes the open item while offline
    Then the item removal is queued for synchronization

  Scenario: A transient synchronization failure is retried
    Given an authenticated administrator with the order catalog loaded
    When a queued order encounters one transient synchronization failure
    Then the queued order is retried without another connectivity event

  Scenario: A quarantined offline order can be reviewed and retried
    Given an authenticated administrator with the order catalog loaded
    When an offline order is quarantined as a synchronization conflict
    Then the conflict shows its guest, room, products, and quantities
    And the host can retry it without discarding it

  Scenario: An uncertain order response is retried idempotently
    Given an authenticated administrator
    When the host retries an order after its first response is lost
    Then both order attempts use the same mutation identifier
    And order editing was locked while the result was uncertain
    And the guest tab contains the order only once

  Scenario: An uncertain order survives a page reload
    Given an authenticated administrator
    When the host reloads after an order response is lost
    Then the restored order retry uses the original mutation identifier
    And the guest tab contains the restored order only once

  Scenario: An uncertain settlement response is retried idempotently
    Given an authenticated administrator
    When the host retries settlement after its first response is lost
    Then both settlement attempts use the same mutation identifier
    And settlement details were locked while the result was uncertain
    And the host reaches the single resulting bill

  Scenario: A host cart respects order batch limits
    Given an authenticated administrator
    When the host adds the maximum quantity of "Helles" for "Anna Berger" in room "101"
    Then that cart line cannot exceed the order batch quantity limit

  Scenario: Concurrent settlement replay returns one bill
    Given an authenticated administrator
    When the same settlement mutation is submitted concurrently
    Then both concurrent settlement responses succeed
    And concurrent settlement creates only one bill

  Scenario: Settlement rejects a tab changed after confirmation opened
    Given an authenticated administrator
    When another order changes the tab while settlement is open
    Then settlement reports that the displayed tab changed
    And no bill is created for the stale confirmation

  Scenario: An open tab cannot exceed the database money range
    Given an authenticated administrator
    When the host submits orders beyond the maximum tab total
    Then the excessive order is rejected without changing the tab

  Scenario: Aggregate item counts remain billable across batches
    Given an authenticated administrator
    When a tab accumulates more than 9900 zero-cost items across valid batches
    Then the aggregate tab can still be settled

  Scenario: Older bills remain discoverable
    Given an authenticated administrator
    When the venue has more bills than one archive page
    Then the host can find the oldest bill by its number

  Scenario: A bill keeps its settlement-time venue timezone
    Given an authenticated administrator
    When the venue timezone changes after a bill is settled
    Then the bill date uses its snapshotted venue timezone

  Scenario: A voided bill keeps its correction when printed
    Given an authenticated administrator
    When the host opens a voided bill for printing
    Then the printed bill shows its void reason
