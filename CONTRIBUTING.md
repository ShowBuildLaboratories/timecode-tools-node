# Contributing

This repository is the Node.js package `timecode-tools`. The decoding is
done by the Rust crate
[`timecode-tools`](https://github.com/ShowBuildLaboratories/timecode-tools-rs),
which lives in its own repository together with the shared golden files.

## Building

You need Rust (1.88 or later) and Node.js 20 or later to build (the
package itself runs on Node.js 18 or later).

`Cargo.toml` uses the published crate, pinned to the exact version
(`timecode-tools = "=0.1.0"`). To also compare `goldens/` with the core,
check out the core repository **next to this one**, at the release tag
that matches that version:

```text
some-folder/
  timecode-tools-rs/     https://github.com/ShowBuildLaboratories/timecode-tools-rs
  timecode-tools-node/   this repository
```

```sh
git clone --branch v0.1.0 https://github.com/ShowBuildLaboratories/timecode-tools-rs
git clone https://github.com/ShowBuildLaboratories/timecode-tools-node
cd timecode-tools-node
npm ci
npm run build        # release build into prebuilds/ (build:debug for a debug build)
npm test
npm run typecheck
npm run goldens:check
```

`npm run build` writes `prebuilds/timecode-tools.<platform>.node` for the
machine you are on and regenerates `native.d.ts`.

## Golden files

`goldens/` is an exact copy of `goldens/` in the core repository: inputs
and the expected results produced by the reference implementation.
`__test__/goldens.test.js` replays the receiver goldens through the public
Node API and requires the same frames, events, `waitFor()` results and
final state.

- `npm run goldens:sync` copies the core's `goldens/` here and rewrites
  `goldens/SHA256SUMS`. Run it after the core's goldens change, and commit
  the result.
- `npm run goldens:check` verifies `goldens/` against `SHA256SUMS` and,
  when the core checkout is present, byte for byte against the core. CI runs
  it with `--require-core`.

Set `TIMECODE_TOOLS_RS_DIR` if the core checkout is somewhere other than
`../timecode-tools-rs`. Do not edit files in `goldens/` by hand.

## Updating the core

For a new core release `X.Y.Z` (on crates.io, tagged `vX.Y.Z` in the core
repository):

1. In `Cargo.toml`, change `timecode-tools = "=0.1.0"` to `"=X.Y.Z"` and
   run `cargo update -p timecode-tools`.
2. Check out the core at `vX.Y.Z` next to this repository and run
   `npm run goldens:sync`.
3. Set `CORE_REF: vX.Y.Z` in `.github/workflows/ci.yml` (CI compares
   `goldens/` with that tag).
4. `npm run build && npm test`, then commit `Cargo.toml`, `Cargo.lock`,
   `goldens/` and the workflow.

To try unreleased core changes locally, add a `[patch]` section to
`.cargo/config.toml` (not committed):

```toml
[patch.crates-io]
timecode-tools = { path = "../timecode-tools-rs/crates/timecode-tools" }
```

## Releasing

The npm package version follows the Rust crate's version.

1. Update `version` in `package.json` (and `package-lock.json`, with
   `npm install --package-lock-only`) and in `Cargo.toml`, and move the
   `Unreleased` notes in `CHANGELOG.md` under the new version.
2. Check locally: `npm test`, `npm run typecheck`, `npm run goldens:check`
   and `npm pack --dry-run`.
3. Push a tag `vX.Y.Z`. The `Release` workflow builds the 9 platform
   binaries, tests them on 7 platforms, checks that all 9 are present, packs
   one package with all of them in `prebuilds/` (the `npm-package`
   artifact), and then waits for approval on the `release` environment
   before `npm publish`.
4. Optionally download the `npm-package` artifact and try it (for example
   in a Companion module) before approving.

## Pull requests

Keep the API the same as the Dart package
[`timecode_tools`](https://pub.dev/packages/timecode_tools): names and
behaviour should match. Add tests for behaviour changes.
