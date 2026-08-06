@area-pwa
Feature: Responsive installable application
  Sky Bar works across tablet, mobile, and desktop browser shapes.

  @id-the-app-exposes-an-installable-pwa-manifest @device-responsive @browser-webkit @browser-firefox
  Scenario: The app exposes an installable PWA manifest
    Given the seeded Sky Bar venue
    When the PWA manifest is requested
    Then it names the software "Sky Bar" and provides application icons

  @id-an-installed-guest-launch-restores-the-active-guest-session @device-responsive
  Scenario: An installed guest launch restores the active guest session
    Given an approved guest device for "Luca Rossi" in room "102"
    When the guest launches the app from the manifest start URL
    Then the launch opens Luca's active guest view

  @id-primary-ordering-navigation-remains-prominent @device-responsive
  Scenario: Primary ordering navigation remains prominent
    Given an authenticated administrator
    Then Take Orders navigation is visually prominent

  @id-nested-pages-have-one-active-navigation-destination @device-responsive
  Scenario: Nested pages have one active navigation destination
    Given an authenticated administrator
    When the host opens the bills screen
    Then only Bills is active in the primary navigation

  @id-order-quantity-controls-meet-mobile-touch-targets @device-responsive @browser-webkit
  Scenario: Order quantity controls meet mobile touch targets
    Given an authenticated administrator
    When the host stages a mobile order for "Anna Berger"
    Then both quantity stepper buttons are at least 44 by 44 pixels
