Feature: Responsive installable application
  Sky Bar works across tablet, mobile, and desktop browser shapes.

  Scenario: The app exposes an installable PWA manifest
    Given the seeded Sky Bar venue
    When the PWA manifest is requested
    Then it names the software "Sky Bar" and provides application icons

  Scenario: Primary ordering navigation remains prominent
    Given an authenticated administrator
    Then Take Orders navigation is visually prominent

  Scenario: Nested pages have one active navigation destination
    Given an authenticated administrator
    When the host opens the bills screen
    Then only Bills is active in the primary navigation
