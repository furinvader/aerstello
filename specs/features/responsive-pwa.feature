Feature: Responsive installable application
  Sky Bar works across tablet, mobile, and desktop browser shapes.

  Scenario: The app exposes an installable PWA manifest
    Given the seeded Sky Bar venue
    When the PWA manifest is requested
    Then it names the software "Sky Bar" and provides application icons

  Scenario: An installed guest launch restores the active guest session
    Given an approved guest device for "Luca Rossi" in room "102"
    When the guest launches the app from the manifest start URL
    Then the launch opens Luca's active guest view

  Scenario: Primary ordering navigation remains prominent
    Given an authenticated administrator
    Then Take Orders navigation is visually prominent

  Scenario: Nested pages have one active navigation destination
    Given an authenticated administrator
    When the host opens the bills screen
    Then only Bills is active in the primary navigation
