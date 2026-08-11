@area-access
Feature: Guest device access and self-service
  Guests request a device-bound login and self-report items from the self-service bar.

  @id-public-bootstrap-loading-and-failure-hide-the-access-form
  Scenario: Public bootstrap loading and failure hide the access form
    Given the seeded Aerstello venue
    When the public bootstrap request remains pending
    Then bootstrap loading is shown without the access form
    When the public bootstrap request fails
    Then bootstrap failure is localized and still hides the access form
    When the guest retries public bootstrap
    Then the access form appears after bootstrap recovery

  @id-a-guest-request-updates-the-host-and-can-be-approved
  Scenario: A guest request updates the host and can be approved
    Given an authenticated administrator and a separate guest device
    When "Luca Rossi" requests access for room "102"
    Then the host sees the pending request for "Luca Rossi"
    When the host approves the request for one day
    Then the guest device opens Luca's guest view without a password

  @id-approval-defaults-to-a-separate-guest-identity
  Scenario: Approval defaults to a separate guest identity
    Given an authenticated administrator and a separate guest device
    When "New Roommate" requests access for room "101"
    Then the host sees the pending request for "New Roommate"
    When the host opens approval for "New Roommate"
    Then creating a new guest is selected by default

  @id-host-approval-guest-directory-loading-blocks-approval
  Scenario: Host approval guest directory loading blocks approval
    Given an authenticated administrator
    When approval guest directory data remains loading
    Then approval is unavailable before the guest directory loads
    When the approval guest directory finishes loading
    Then the host can open approval with the loaded guest directory

  @id-an-uncertain-access-approval-is-recovered-idempotently
  Scenario: An uncertain access approval is recovered idempotently
    Given an authenticated administrator and a separate guest device
    When the host retries an approval after its first response is lost
    Then both approval attempts use the same mutation identifier
    And approval fields stay locked while the result is uncertain
    And only one approved guest identity exists
    And the guest device receives access

  @id-an-uncertain-access-request-response-is-recoverable
  Scenario: An uncertain access request response is recoverable
    Given an authenticated administrator and a separate guest device
    When the guest retries an access request after its first response is lost
    Then both access request attempts use the same mutation identifier
    And the uncertain access request fields stay locked for retry
    And the host sees only one pending request from that guest

  @id-a-pending-access-request-survives-closing-the-app
  Scenario: A pending access request survives closing the app
    Given an authenticated administrator and a separate guest device
    When "Persistent Guest" requests access for room "102"
    Then the host sees the pending request for "Persistent Guest"
    When the guest closes the pending request page
    And the host approves the request for one day
    Then reopening the request restores the approved guest access

  @id-a-denied-access-request-stops-polling
  Scenario: A denied access request stops polling
    Given an authenticated administrator and a separate guest device
    When "Denied Poller" requests access for room "102"
    Then the host sees the pending request for "Denied Poller"
    When the host denies the request for "Denied Poller"
    Then the denied guest device stops status polling

  @id-an-uncertain-access-denial-is-recovered-idempotently
  Scenario: An uncertain access denial is recovered idempotently
    Given an authenticated administrator and a separate guest device
    When the host retries a denial after its first response is lost
    Then both denial attempts use the same mutation identifier
    And the denied request remains resolved only once

  @id-guests-see-why-approved-access-is-unavailable
  Scenario: Guests see why approved access is unavailable
    Given an authenticated administrator and a separate guest device
    When approved guest access expires before the requesting page exchanges it
    Then the requesting page explains that access expired
    When an approved linked guest is disabled before exchange
    Then the requesting page explains that access is disabled

  @id-approval-defaults-to-one-local-day
  Scenario: Approval defaults to one local day
    Given an authenticated administrator
    When a host in a non-UTC timezone opens a guest approval
    Then the approval expiry is one local day from now

  @id-a-lost-grant-response-can-be-recovered-by-the-requesting-device
  Scenario: A lost grant response can be recovered by the requesting device
    Given an authenticated administrator
    When an approved guest grant response is lost before its cookie is retained
    Then retrying the same grant exchange restores guest access
    And a different grant exchange receives no guest access

  @id-a-pending-access-request-survives-session-secret-rotation
  Scenario: A pending access request survives session-secret rotation
    Given an authenticated administrator
    When a pending guest request crosses a session-secret rotation
    Then its original and idempotently reissued capabilities remain pollable
    And the bound grant exchange restores guest access after rotation
    And the rotated replica rejects the old host session

  @id-an-expired-approval-cannot-be-exchanged-for-guest-access
  Scenario: An expired approval cannot be exchanged for guest access
    Given an authenticated administrator
    When an approved guest request expires before its grant exchange
    Then the expired exchange is not consumed or granted

  @id-grant-expiry-uses-the-database-clock-across-replicas @cross-device
  Scenario: Grant expiry uses the database clock across replicas
    Given an authenticated administrator
    When a clock-skewed API replica exchanges a database-valid grant
    Then the database-valid guest access is granted

  @id-grant-expiry-is-checked-after-guest-serialization
  Scenario: Grant expiry is checked after guest serialization
    Given an authenticated administrator
    When an approved guest grant expires while waiting for its guest lock
    Then the serialized expired grant is not consumed or issued

  @id-approval-expiry-uses-the-database-clock-across-replicas @cross-device
  Scenario: Approval expiry uses the database clock across replicas
    Given an authenticated administrator
    When clock-skewed API replicas validate access approval expiries
    Then only the database-valid access approval is accepted

  @id-approval-expiry-is-checked-after-serialization
  Scenario: Approval expiry is checked after serialization
    Given an authenticated administrator
    When an access approval expires while waiting for its request lock
    Then the expired approval is rejected without resolving its request

  @id-a-host-revokes-one-guest-device
  Scenario: A host revokes one guest device
    Given an approved guest device for "Luca Rossi" in room "102"
    When the host revokes Luca's device from the guest directory
    Then Luca's revoked device loses guest access

  @id-a-guest-device-failure-can-be-retried
  Scenario: A guest device failure can be retried
    Given an approved guest device for "Luca Rossi" in room "102"
    When the guest device directory fails to load
    Then the guest device failure is localized instead of empty
    When the host retries the guest device directory
    Then Luca's device appears after guest device recovery

  @id-guest-device-revocation-refreshes-another-open-host-client @cross-device
  Scenario: Guest-device revocation refreshes another open host client
    Given an approved guest device for "Luca Rossi" in room "102"
    When another host revokes Luca's device while the first host's device list is open
    Then the first host's open guest device list updates

  @id-repeating-guest-device-revocation-does-not-duplicate-its-audit
  Scenario: Repeating guest-device revocation does not duplicate its audit
    Given an approved guest device for "Luca Rossi" in room "102"
    When the host repeats revocation of Luca's device
    Then both revocation requests succeed with one audit record
    And the device cannot be revoked through another guest

  @id-remote-revocation-clears-the-open-guest-application @cross-device
  Scenario: Remote revocation clears the open guest application
    Given an approved guest device for "Luca Rossi" in room "102"
    When the host revokes Luca's device from the guest directory
    Then Luca's open guest view returns to access request without cached data

  @id-transient-guest-identity-outage-remains-retryable
  Scenario: Transient guest identity outage remains retryable
    Given an approved guest device for "Luca Rossi" in room "102"
    When a transient guest identity outage occurs during app launch
    Then the guest remains on the guest page with a retry action
    When the guest retries the identity request
    Then Luca's guest application opens with persisted guest state intact

  @id-guest-identity-changes-update-the-open-guest-application
  Scenario: Guest identity changes update the open guest application
    Given an approved guest device for "Luca Rossi" in room "102"
    When the host renames Luca to "Luca Nuovo"
    Then Luca's open guest view shows "Luca Nuovo"

  @id-dual-cookie-guest-event-stream-stays-isolated @cross-device
  Scenario: Dual-cookie guest event stream stays isolated
    Given an approved guest device for "Luca Rossi" in room "102"
    When the guest opens a guest-scoped event stream while also authenticated as a host
    Then the guest stream receives only its own payload-free order event

  @id-a-request-queue-failure-can-be-retried
  Scenario: A request queue failure can be retried
    Given an authenticated administrator
    When the initial request queue load fails transiently
    Then the request queue shows a localized failure instead of an empty state
    When the host retries the request queue
    Then the pending request appears after request queue recovery

  @id-a-guest-can-undo-a-self-service-item-for-ten-seconds
  Scenario: A guest can undo a self-service item for ten seconds
    Given an approved guest device for "Luca Rossi" in room "102"
    When the guest adds "Mineralwasser" from self-service
    Then an undo action is available
    When the guest uses undo
    Then the guest tab has no open items
    And the host has no empty open order for "Luca Rossi"

  @id-lock-waits-do-not-shorten-the-guest-undo-window
  Scenario: Lock waits do not shorten the guest undo window
    Given an approved guest device for "Luca Rossi" in room "102"
    When a self-service addition waits for a guest lock
    Then the guest still receives a full undo window

  @id-lock-waits-cannot-extend-the-guest-undo-window
  Scenario: Lock waits cannot extend the guest undo window
    Given an approved guest device for "Luca Rossi" in room "102"
    When guest undo starts before expiry and waits behind a rolled-back item lock
    Then the expired guest undo is rejected
    And the self-service item remains on the guest tab

  @id-a-lost-guest-logout-response-clears-cached-guest-data
  Scenario: A lost guest logout response clears cached guest data
    Given an approved guest device for "Luca Rossi" in room "102"
    When the guest logs out and the committed response is lost
    Then the guest reaches access request without cached data
    And replaying guest logout for the revoked session succeeds

  @id-a-guest-tab-outage-never-appears-as-a-zero-balance
  Scenario: A guest tab outage never appears as a zero balance
    Given an approved guest device for "Luca Rossi" in room "102"
    When the guest tab service is unavailable
    Then the guest sees an error without a zero balance or empty order

  @id-a-guest-catalog-failure-recovers-without-reload
  Scenario: A guest catalog failure recovers without reload
    Given an approved guest device for "Luca Rossi" in room "102"
    When the guest catalog request remains pending
    Then guest catalog loading is localized without empty or product state
    When the pending guest catalog request fails
    Then guest catalog failure and retry are localized without empty state
    When the guest retries the catalog request
    Then recovered self-service products appear without a reload

  @id-a-guest-addition-is-bound-to-its-displayed-price
  Scenario: A guest addition is bound to its displayed price
    Given an approved guest device for "Luca Rossi" in room "102"
    When a self-service price changes after the guest catalog is displayed
    Then adding the stale self-service product is rejected without a charge
    And the guest can retry the refreshed self-service product

  @id-a-guest-addition-is-bound-to-its-displayed-product-version
  Scenario: A guest addition is bound to its displayed product version
    Given an approved guest device for "Luca Rossi" in room "102"
    When a self-service product is renamed after the guest catalog is displayed
    Then adding the stale product snapshot is rejected without a charge
    And the guest catalog shows the renamed product after refresh

  @id-the-guest-undo-control-expires-on-time
  Scenario: The guest undo control expires on time
    Given an approved guest device for "Luca Rossi" in room "102"
    When the guest adds "Mineralwasser" from self-service
    Then an undo action is available
    And the undo action disappears after ten seconds
    And the expired item is no longer marked provisional

  @id-a-fast-device-clock-does-not-shorten-a-new-guest-undo-window
  Scenario: A fast device clock does not shorten a new guest undo window
    Given an approved guest device for "Luca Rossi" in room "102"
    When the guest device clock is twelve hours fast
    And the guest adds "Mineralwasser" from self-service
    Then an undo action is available
    And the undo action disappears after ten seconds

  @id-a-slow-device-clock-does-not-extend-a-refreshed-guest-undo-window
  Scenario: A slow device clock does not extend a refreshed guest undo window
    Given an approved guest device for "Luca Rossi" in room "102"
    When the guest refreshes a provisional item with a device clock twelve hours slow
    Then an undo action is available
    And the undo action disappears after ten seconds
    And the expired item is no longer marked provisional

  @id-every-provisional-self-service-item-can-be-undone
  Scenario: Every provisional self-service item can be undone
    Given an approved guest device for "Luca Rossi" in room "102"
    When the guest adds two different self-service items
    Then both provisional items offer their own undo action

  @id-guest-undo-is-limited-to-the-device-that-added-the-item
  Scenario: Guest undo is limited to the device that added the item
    Given an approved guest device for "Luca Rossi" in room "102"
    When another approved device for the same guest adds "Mineralwasser"
    Then the original guest device sees the item without an undo action

  @id-localized-category-labels-do-not-merge-distinct-categories
  Scenario: Localized category labels do not merge distinct categories
    Given an approved guest device for "Luca Rossi" in room "102"
    When the host adds another self-service category named "Getränke"
    Then both "Getränke" categories remain separate in the guest catalog

  @id-pending-self-service-addition-does-not-block-another-product
  Scenario: Pending self-service addition does not block another product
    Given an approved guest device for "Luca Rossi" in room "102"
    When one self-service addition remains pending while another product is added
    Then the other product request begins before the first response is released
    And each product is disabled only while its own addition is pending

  @id-concurrent-guest-success-preserves-another-product-failure @cross-device
  Scenario: Concurrent guest success preserves another product failure
    Given an approved guest device for "Luca Rossi" in room "102"
    When one guest product fails while another product remains pending
    Then the guest product failure is visible before the other product settles
    When the pending guest product succeeds
    Then the guest product failure remains visible

  @id-uncertain-self-service-additions-retain-their-mutation
  Scenario: Uncertain self-service additions retain their mutation
    Given an approved guest device for "Luca Rossi" in room "102"
    When one guest addition loses its response before another product is added
    Then retrying the uncertain product reuses its mutation identifier
    And each selected self-service product is stored once

  @id-an-http-timeout-retains-the-guest-addition-mutation
  Scenario: An HTTP timeout retains the guest addition mutation
    Given an approved guest device for "Luca Rossi" in room "102"
    When the guest retries an addition after a committed HTTP timeout
    Then both timed-out guest additions use the same mutation identifier
    And the timed-out self-service product is stored once

  @id-an-uncertain-self-service-addition-survives-closing-the-app
  Scenario: An uncertain self-service addition survives closing the app
    Given an approved guest device for "Luca Rossi" in room "102"
    When the guest closes the app after a self-service response is lost
    Then reopening and retrying reuses the original item mutation identifier
    And the recovered self-service product is stored once

  @id-an-uncertain-guest-undo-response-is-retried-idempotently
  Scenario: An uncertain guest undo response is retried idempotently
    Given an approved guest device for "Luca Rossi" in room "102"
    When the guest retries undo after its first response is lost
    Then both guest undo attempts use the same mutation identifier
    And the guest tab has no open items

  @id-concurrent-self-service-replay-returns-one-item @cross-device
  Scenario: Concurrent self-service replay returns one item
    Given an approved guest device for "Luca Rossi" in room "102"
    When the same guest item mutation is submitted concurrently
    Then both concurrent guest item responses succeed
    And the concurrent guest item is stored only once
