#!/usr/bin/env bash
# bun run app:build — engine binary + menu-bar binary + web build (if present) + `tauri build` (ad-hoc signed .app).
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p dist

# 1. Engine sidecar (Bun compile), file name `cc-slaves`: Login Items shows the program file name (hf-bg2). `build:engine` comes from the engine lane; fall back to the same command.
if grep -q '"build:engine"' package.json; then
  bun run build:engine
elif [ -f engine/src/main.ts ]; then
  bun build --compile engine/src/main.ts --outfile dist/cc-slaves
elif [ ! -x dist/cc-slaves ]; then
  echo "app:build: no engine/src/main.ts and no dist/cc-slaves — build the engine first" >&2
  exit 1
fi
codesign --force --sign - dist/cc-slaves

# 2. Menu-bar process (the engine job starts it as a child, hf-bg2; shipped as a bundle resource).
cargo build --release --manifest-path menubar/Cargo.toml
cp menubar/target/release/cc-slaves-menubar dist/cc-slaves-menubar
codesign --force --sign - dist/cc-slaves-menubar

# 3. Web UI: bundled as Contents/Resources/web (tauri.bundle.json); the engine serves it from there.
if [ -f web/package.json ] && grep -q '"build"' web/package.json; then
  (cd web && bun run build)
fi

# 4. App bundle; resources added only here so `cargo build/test` never need the binaries.
# Pre-build with plain cargo first: from a clean target, `tauri build` alone failed 3/3 with
# "E0463 can't find crate for time_macros/tauri_macros" (rustc 1.97, measured 2026-11-14); cargo-then-tauri passes.
cargo build --release --features tauri/custom-protocol --manifest-path src-tauri/Cargo.toml
CONFIGS=(--config src-tauri/tauri.bundle.json)
# CC_SLAVES_RELEASE=1 (release workflow, spec v2.6 §7.3): updater artifacts (.app.tar.gz + .sig, needs the signing key);
# a local build without the key stays as before.
if [ "${CC_SLAVES_RELEASE:-}" = 1 ]; then
  CONFIGS+=(--config src-tauri/tauri.release.json)
fi
bun x tauri build --bundles app "${CONFIGS[@]}"
APP=src-tauri/target/release/bundle/macos/cc-slaves.app
# 5. Bundle check: the engine serves the UI from Contents/Resources/web (boot.ts staticDir) — fail loudly if it is missing.
for f in Contents/Resources/cc-slaves Contents/Resources/cc-slaves-menubar Contents/Resources/web/index.html; do
  [ -e "$APP/$f" ] || { echo "app:build: missing $f in the bundle" >&2; exit 1; }
done
echo "app:build: $APP"
