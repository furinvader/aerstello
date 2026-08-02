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

  Scenario: An uncertain host account creation is recovered idempotently
    Given an authenticated administrator
    When the administrator retries host creation after its response is lost
    Then both host creation attempts use the same mutation identifier
    And the uncertain host fields stay locked for retry
    And only one recoverable host account exists

  Scenario: Device timestamps follow the selected host language
    Given an authenticated administrator
    When the host selects Italian on an English-locale device
    Then the last-active timestamp uses Italian formatting

  Scenario: Changing a password revokes other devices
    Given an authenticated administrator
    When the administrator changes the password with another device logged in
    Then the password change keeps the current device and revokes the other device
    And the new password can be used to sign in

  Scenario: An incorrect current password is explained
    Given an authenticated administrator
    When the administrator submits an incorrect current password
    Then the account screen shows the localized password error

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

  Scenario: A stale account update cannot revoke a re-enabled host
    Given an authenticated administrator
    When a host disable response is lost before the account is re-enabled
    Then retrying the stale host disable is rejected
    And the re-enabled host remains active and signed in

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
