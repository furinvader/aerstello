Feature: Secure host accounts and devices
  The venue team signs in with individual credentials and controls active devices.

  Scenario: An administrator signs in and sees the configured venue
    Given the seeded Sky Bar venue
    When the administrator signs in
    Then the host dashboard shows the venue name "Hotel Aurora"
    And the page has no serious accessibility violations

  Scenario: A host can inspect logged-in devices
    Given an authenticated administrator
    When the host opens the account screen
    Then the current device is listed

  Scenario: Revoking the current device signs out immediately
    Given an authenticated administrator
    When the host revokes the current device from the account screen
    Then the host is redirected to login without cached venue data

  Scenario: Staff do not receive room-management controls
    Given an authenticated staff host
    Then room management is absent from the navigation
    And opening the room-management URL shows no mutation controls
    And opening the product-management URL shows no mutation controls

  Scenario: Role changes refresh an open host session
    Given an authenticated administrator
    When another administrator demotes an open host session to staff
    Then administrator controls disappear from the affected session

  Scenario: Remote revocation clears the open host application
    Given an authenticated administrator
    When the current host session is revoked from another administrator
    Then the remotely revoked host is redirected to login

  Scenario: Unknown and known accounts share the same login response
    Given the seeded Sky Bar venue
    When invalid passwords are submitted for known and unknown host emails
    Then both login attempts return the same credential error

  Scenario: Administrator credential recovery revokes existing devices
    Given an authenticated administrator
    When the administrator credentials are recovered from the command line
    Then the existing host device is signed out
