# Cross-game Rich Presence compatibility

Template compatibility is implemented as a shared pipeline, not an AppID-specific
patch table. An AppID selects the catalog to request; it does not select a custom
parser, localization rule, or success override.

## One protocol contract

`src/shared/rich-presence-contract.json` defines separate budgets for the raw
protobuf response, selected language catalog, renderable templates, actual
Rich Presence fields, and stdio transport. These are different stages: raw
catalog text does not have the same budget as a submitted field value.

TypeScript consumes the contract directly. The native definitions are generated
deterministically and checked before compilation. Tests also compile their
fixtures against those definitions, and a platform-independent stale-output
check prevents a skipped Windows-only test from hiding contract drift.

Do not add another numeric limit or field allow/deny policy in a game-specific
branch. Change the contract, its generated definitions and boundary tests
together when a verified protocol requirement changes.

## Shared template semantics

- Prefer the requested language, using English for missing or empty translated
  entries and dependencies. Whitespace is not silently treated as missing.
- Interpret only recognized template references and placeholders. Other literal
  text is not removed simply because it contains percent signs or braces.
- Validate the branch selected by the current variables. A rejected, private,
  missing or cyclic sibling must not disable a separate safe branch.
- Repeated variables must agree. A pattern containing the same variable twice
  must not match two different values.
- Derive bounded candidate projections for combined variables instead of asking
  users to guess initial values or enumerating an unbounded Cartesian product.
- Preserve internal whitespace while rejecting an empty final display.
- Use the same field grammar, UTF-8 checks and protected-field policy before a
  preview is offered and before a native submission is attempted.

Depth, work, payload and field budgets remain finite. A budget or unsupported
format is reported as a lookup/compatibility limitation, not as proof that a
game has no Rich Presence support. Experimental manual submission is a separate
explicit option and never counts as verified friend-client display.

## Regression strategy

The regression matrix uses synthetic catalogs and generated valid AppIDs. It
covers large catalogs, language fallback, nested and dynamic references,
multiple unknown variables, repeated variables, unsafe/cyclic sibling isolation,
case changes, dictionary ordering, literal text and whitespace. Native fixtures
and broker tests cover stage boundaries and serialization independently of any
running game.

These are offline compatibility tests. They do not log in to Steam, start a
game, write Rich Presence or prove friend-client visibility. A real protocol
change still requires evidence-led adaptation, but an ordinary new AppID must
not require a new hardcoded parser rule.

## Capability limits remain separate

Reading an arbitrary game's private state is not a template compatibility
fallback. The real-game native reader retains an explicit privacy allowlist in
the same contract; a valid published template does not widen that reader. A
template using fields that cannot be read back cannot start continuous native
locking. A permitted single attempt remains unverified rather than claiming
success from an unavailable readback. Source-copy reports retain their separate
public-field limits. No missing template triggers a personal CM sign-in, a game
restart, or an automatic experimental submission.
