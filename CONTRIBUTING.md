# Contributing

This repository is the Node.js package `timecode-tools`. The decoding is
done by the Rust crate
[`timecode-tools`](https://github.com/ShowBuildLaboratories/timecode-tools-rs),
which lives in its own repository together with the shared golden files.

## Building

You need Rust (1.88 or later) and Node.js 20 or later to build (the
package itself runs on Node.js 18 or later).

While the Rust crate is not yet on crates.io, `Cargo.toml` uses it from a
checkout of the core repository **next to this one**:

```text
some-folder/
  timecode-tools-rs/     https://github.com/ShowBuildLaboratories/timecode-tools-rs
  timecode-tools-node/   this repository
```

```sh
git clone https://github.com/ShowBuildLaboratories/timecode-tools-rs
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

## Switching the core to crates.io

Once `timecode-tools` 0.1.0 is published on crates.io, release builds use
the published crate, pinned to the exact version:

1. In `Cargo.toml`, replace the dependency line

   ```toml
   timecode-tools = { path = "../timecode-tools-rs/crates/timecode-tools", version = "=0.1.0" }
   ```

   with

   ```toml
   timecode-tools = "=0.1.0"
   ```

2. Run `cargo update -p timecode-tools` and `npm run build && npm test`.
   Commit `Cargo.toml` and `Cargo.lock`.
3. In `.github/workflows/ci.yml` and `release.yml`, the second checkout
   (`repository: ShowBuildLaboratories/timecode-tools-rs`) and `CORE_REF`
   are then needed only for `goldens:check`. In `release.yml` remove that
   checkout from the build job. In `ci.yml` keep it, and set `CORE_REF` to
   the core's release tag (for example `v0.1.0`) so the goldens are checked
   against the released version.

For later core releases, change `=0.1.0` to the new exact version and run
`npm run goldens:sync` against the matching core tag.

To try unreleased core changes locally after the switch, add a `[patch]`
section to `.cargo/config.toml` (not committed):

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
