# Production release markers

Sky Bar becomes released only when a valid marker and an annotated Git tag
exist for the same version on the protected `main` release history. A marker
without its tag is pending release preparation and does not freeze migrations.
The root package version is not release evidence.

Markers live at `.release/markers/vMAJOR.MINOR.PATCH.json` and follow
[`marker.schema.json`](./marker.schema.json). The `tag` value must equal `v`
plus `version`; the release-state command enforces that relationship in
addition to the JSON schema.

## Release procedure

1. Prepare and merge a release change containing the marker.
2. Run a local high-reasoning release-candidate review and resolve its findings.
3. Request a final clean GitHub review with `@codex review` against the exact
   release-candidate commit.
4. Create an annotated `vMAJOR.MINOR.PATCH` tag on that exact commit.
5. Push the tag.
6. Run `npm run check:release-state -- --require-tag vMAJOR.MINOR.PATCH` and
   `npm run check:released-migrations`.

Only after those steps is the version a production release. Protect stable
release tags with a GitHub ruleset that forbids updates and deletion; never
reuse, move, or delete a production release tag. CI rejects a release-like tag without a valid
matching marker and preserves every migration blob that appeared in any valid
production release.
