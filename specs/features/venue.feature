Feature: Venue identity
  Sky Bar is the software while bills carry the administrator-configured venue name.

  Scenario: An administrator changes the venue name
    Given an authenticated administrator
    When the administrator changes the venue name to "Moonlight Hotel"
    Then the navigation shows the venue name "Moonlight Hotel"

  Scenario: Venue and room guest-access QR codes exist
    Given an authenticated administrator
    When the administrator opens venue settings
    Then a venue QR code and room QR codes are shown

  Scenario: A room QR directory failure preserves venue settings and print safety
    Given an authenticated administrator
    When the room QR directory remains pending
    Then room QR loading hides empty cards and disables printing
    When the pending room QR directory fails
    Then room QR failure and retry preserve venue controls and disable printing
    When the administrator retries the room QR directory
    Then room QR cards recover and printing is enabled

  Scenario: A successful empty room QR directory is explicit and printable
    Given an authenticated administrator
    When venue settings loads a successful empty room QR directory
    Then the room QR empty state appears without failure and printing is enabled

  Scenario: Administrators can return to venue settings
    Given an authenticated administrator
    Then venue settings is available in the primary navigation

  Scenario: A venue load failure can be retried
    Given an authenticated administrator
    When the initial venue load fails transiently
    Then venue settings shows a localized failure with retry
    When the administrator retries the venue load
    Then editable venue settings appear after recovery

  Scenario: Venue time zones must be recognized IANA identifiers
    Given an authenticated administrator
    When the administrator submits an invalid venue time zone
    Then the venue time zone is rejected without changing the settings

  Scenario: A stale venue retry cannot overwrite newer settings
    Given an authenticated administrator
    When a venue update response is lost before another administrator edits it
    Then retrying the stale venue update is rejected
    And the newer venue name remains configured
