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

  Scenario: Administrators can return to venue settings
    Given an authenticated administrator
    Then venue settings is available in the primary navigation
