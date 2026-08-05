Feature: Secure host accounts and devices
  The venue team signs in with individual credentials and controls active devices.

  Scenario: An administrator signs in and sees the configured venue
    Given the seeded Sky Bar venue
    When the administrator signs in
    Then the host dashboard shows the venue name "Hotel Aurora"
    And the page has no serious accessibility violations

  Scenario: A public launch identity outage can be retried
    Given the seeded Sky Bar venue
    When a public launch identity check fails transiently
    Then public launch shows a localized failure with retry
    When the visitor retries the launch identity checks
    Then public entry opens after launch identity recovery

  Scenario: A host can inspect logged-in devices
    Given an authenticated administrator
    When the host opens the account screen
    Then the current device is listed

  Scenario: A host device directory failure preserves profile controls
    Given an authenticated administrator
    When the host device directory remains pending
    Then device loading is localized without an empty list and profile stays usable
    When the pending host device directory fails
    Then device failure and retry are localized without an empty list
    When the host retries the device directory
    Then the current device reappears without a reload

  Scenario: An administrator host account directory failure preserves independent controls
    Given an authenticated administrator
    When the host account directory remains pending
    Then host account loading hides empty and host mutation actions
    And profile and device controls remain usable
    When the pending host account directory fails
    Then host account failure and retry hide empty and host mutation actions
    When the administrator retries the host account directory
    Then host account rows and mutation actions recover independently

  Scenario: A transient host identity outage preserves the requested route
    Given an authenticated administrator
    When the initial host identity request fails transiently on the bills route
    Then the bills route shows a localized identity failure with retry
    And the host is not redirected to login
    When the host retries the initial identity request
    Then the requested bills route opens after identity recovery

  Scenario: An uncertain profile save cannot overwrite a newer device
    Given an authenticated administrator
    When a profile save response is lost before another device edits the profile
    Then both profile save attempts use the same mutation identifier
    And the uncertain profile fields stay locked for retry
    And the newer profile remains configured

  Scenario: An uncertain host account creation is recovered idempotently
    Given an authenticated administrator
    When the administrator retries host creation after its response is lost
    Then both host creation attempts use the same mutation identifier
    And the uncertain host fields stay locked for retry
    And only one recoverable host account exists
    And host creation retains no retired password verifier

  Scenario: Host creation refreshes another open account directory
    Given an authenticated administrator
    When another device creates a host while the account directory is open
    Then the new host appears after the committed authorization event

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

  Scenario: A lost logout response still clears authenticated UI
    Given an authenticated administrator
    When the host logs out and the committed response is lost
    Then the host still reaches login without cached venue data
    And replaying logout for the revoked session succeeds

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

  Scenario: Credential recovery rejects an in-flight old-password login
    Given the seeded Sky Bar venue
    When credential recovery completes while an old-password login is being verified
    Then the old-password login is rejected without creating a session
