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

  Scenario: Switching payment methods drops a hidden note
    Given an authenticated administrator
    And an open "Helles" order for "Anna Berger" in room "101"
    When the host enters an Other payment note and settles with cash
    Then the cash bill has no payment note

  Scenario: Changing guests cannot transfer a staged cart
    Given an authenticated administrator
    When the host stages an order for Anna and confirms a switch to Luca
    Then the staged cart is cleared before Luca is selected
    And Luca's tab is unchanged

  Scenario: An offline host order is queued for synchronization
    Given an authenticated administrator with the order catalog loaded
    When the device goes offline and the host submits one "Helles" for "Anna Berger" in room "101"
    Then the order is marked as queued for synchronization

  Scenario: A host removes an incorrect item while offline
    Given an authenticated administrator
    And an open "Helles" order for "Anna Berger" in room "101"
    When the host removes the open item while offline
    Then the item removal is queued for synchronization

  Scenario: A queued item removal cannot cross billing and correction
    Given an authenticated administrator
    When an item removal command crosses settlement and bill reversal
    Then the stale item removal is rejected as a billing conflict
    And the corrected item remains on the open tab
    When the host submits a new removal from the refreshed tab
    Then the refreshed item removal succeeds

  Scenario: An uncertain item removal keeps its submitted reason
    Given an authenticated administrator
    And an open "Helles" order for "Anna Berger" in room "101"
    When the host retries item removal after its response is lost
    Then the uncertain void reason is locked
    And both item removal attempts use the same reason

  Scenario: An uncertain item removal survives a page reload
    Given an authenticated administrator
    And an open "Helles" order for "Anna Berger" in room "101"
    When the host reloads after an item removal response is lost
    Then the restored item removal uses the original mutation identifier
    And the restored item removal is applied and cleared from recovery

  Scenario: An empty open tab cannot be offered for settlement
    Given an authenticated administrator
    And an open "Helles" order for "Anna Berger" in room "101"
    When the host removes the only open item
    Then no settlement action is offered for the empty tab

  Scenario: A host tab outage never appears as a zero balance
    Given an authenticated administrator
    And an open "Helles" order for "Anna Berger" in room "101"
    When the selected guest tab service is unavailable
    Then the host sees tab loading without a zero balance
    And the host sees a tab error without a zero balance or settlement action

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

  Scenario: An HTTP timeout preserves the uncertain order command
    Given an authenticated administrator
    When the host retries an order after a committed HTTP timeout
    Then both order attempts use the same mutation identifier
    And the guest tab contains the order only once

  Scenario: An uncertain order survives a page reload
    Given an authenticated administrator
    When the host reloads after an order response is lost
    Then the restored order retry uses the original mutation identifier
    And the guest tab contains the restored order only once

  Scenario: An uncertain order survives closing the app
    Given an authenticated administrator
    When the host closes the app after an order response is lost
    Then reopening the order uses the original mutation identifier
    And the guest tab contains the reopened order only once

  Scenario: An uncertain order keeps its captured catalog prices
    Given an authenticated administrator
    When a product price changes after its order response is lost
    Then the uncertain cart still shows its captured total
    And retrying retains the captured charge

  Scenario: Reusing an order mutation cannot change its command
    Given an authenticated administrator
    When an order mutation is replayed with a changed quantity
    Then the changed order replay is rejected
    And the original order quantity remains unchanged

  Scenario: Dashboard item totals include line quantities
    Given an authenticated administrator
    When the host submits five items in one order line
    Then the dashboard reports five open items

  Scenario: Dashboard open totals exclude billed history
    Given an authenticated administrator
    When the host has billed history and one current open item
    Then the dashboard reports only the current item and value

  Scenario: Dashboard sales keep settlement-time sales days
    Given an authenticated administrator
    When the venue timezone changes after sales on adjacent snapshot days
    Then the dashboard reports sales from the current snapshotted day

  Scenario: Dashboard financial totals remain unavailable while stats load
    Given an authenticated administrator
    When the initial dashboard stats response is delayed
    Then the dashboard financial cards show loading without zero totals

  Scenario: A dashboard stats outage never appears as zero activity
    Given an authenticated administrator
    When the initial dashboard stats request fails
    Then the dashboard financial cards show a request failure without zero totals

  Scenario: A successful dashboard response can report real zero activity
    Given an authenticated administrator
    When the dashboard stats successfully report no activity
    Then the dashboard financial cards show zero totals and zero open items

  Scenario: An uncertain settlement response is retried idempotently
    Given an authenticated administrator
    When the host retries settlement after its first response is lost
    Then both settlement attempts use the same mutation identifier
    And settlement details were locked while the result was uncertain
    And the host reaches the single resulting bill

  Scenario: A committed settlement survives closing and reload
    Given an authenticated administrator
    When a committed settlement response is lost before modal close and reload
    Then settlement recovery replays the original frozen command
    And the reload reaches the single recovered bill exactly once
    And the recovered settlement command is cleared

  Scenario: Settlement timestamps begin after lock waits
    Given an authenticated administrator
    When settlement waits for a locked tab
    Then the bill timestamp follows the lock release

  Scenario: Bill reversal timestamps begin after lock waits
    Given an authenticated administrator
    When bill reversal waits for a locked guest
    Then the bill void and audit timestamps follow the lock release
    And reversal leaves the original bill history unchanged

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
    When the host retries settlement with the refreshed confirmation
    Then one bill is created for the refreshed tab

  Scenario: Settlement closes when another device empties the tab
    Given an authenticated administrator
    When another device voids the last item while settlement is open
    Then the empty settlement confirmation closes without a bill

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

  Scenario: An unavailable bill archive never appears empty
    Given an authenticated administrator
    When the initial bill archive request is delayed and fails
    Then the bill archive shows loading without a successful empty state
    And the bill archive shows failure without a successful empty state

  Scenario: A successful empty bill archive appears empty
    Given an authenticated administrator
    When the host opens a successfully empty bill archive
    Then the bill archive shows its successful empty state

  Scenario: An unavailable open order list never appears empty
    Given an authenticated administrator
    When the initial open order list request is delayed and fails
    Then the open orders page shows loading without a successful empty state
    And the open orders page shows failure without a successful empty state
    When the host opens the dashboard with a failed open order list
    Then the dashboard open order list shows loading without a successful empty state
    And the dashboard open order list shows failure without a successful empty state

  Scenario: A successful empty open order list appears empty
    Given an authenticated administrator
    When the host opens a successfully empty open order list
    Then the open orders page shows its successful empty state
    When the host opens the dashboard with a successful empty open order list
    Then the dashboard open order list shows its successful empty state

  Scenario: A bill keeps its settlement-time venue timezone
    Given an authenticated administrator
    When the venue timezone changes after a bill is settled
    Then the bill date uses its snapshotted venue timezone

  Scenario: A bill keeps its settlement-time host name
    Given an authenticated administrator
    When the settling host changes their name after billing
    Then the bill still shows the original host name

  Scenario: A voided bill keeps its correction when printed
    Given an authenticated administrator
    When the host opens a voided bill for printing
    Then the printed bill shows its void reason
