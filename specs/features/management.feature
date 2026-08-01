Feature: Venue operations configuration
  Administrators maintain rooms, guests, categories, and orderable products without erasing history.

  Scenario: An administrator creates and renames a room
    Given an authenticated administrator
    When the administrator creates room "Garden 7"
    Then room "Garden 7" is listed
    When the administrator renames room "Garden 7" to "Garden 8"
    Then room "Garden 8" is listed

  Scenario: A host creates and edits a guest
    Given an authenticated administrator
    When the host creates guest "Ada Test" in room "101"
    Then guest "Ada Test" is listed in room "101"

  Scenario: An administrator creates a localized self-service product
    Given an authenticated administrator
    When the administrator creates the self-service product "Apfelsaft" priced "3.10"
    Then product "Apfelsaft" is listed as self-service
