Feature: German, Italian, and English localization
  Hosts and guests select a preferred language with German fallback.

  Scenario: A host switches the interface to Italian
    Given an authenticated administrator
    When the host changes their language to Italian
    Then the navigation is shown in Italian

  Scenario: Product editor labels follow the host language
    Given an authenticated administrator
    When the host changes their language to Italian and opens the product editor
    Then the product name label is shown in Italian

  Scenario: Missing product translation falls back to German
    Given an approved guest device for "Luca Rossi" in room "102"
    When the guest selects Italian
    Then untranslated product content falls back to German

  Scenario: A fresh guest device uses the venue default language
    Given an authenticated administrator
    When the venue default language is Italian
    Then a fresh English guest device starts in Italian

  Scenario: The guest access form localizes its name label
    Given the seeded Sky Bar venue
    When a fresh guest selects Italian on the access form
    Then the guest name field is labeled in Italian
