#!/usr/bin/env bash
#
# Build and install the `dsh-ocr` Vision helper.
#
#   ./install.sh              # install into the Homebrew prefix (or /usr/local)
#   PREFIX=~/.local ./install.sh
#   ./install.sh --build-only # just produce ./build/dsh-ocr
#
# Requires the Xcode Command Line Tools (`xcode-select --install`) for swiftc.
# Harness falls back to tesseract wherever this helper is absent, so installing
# it is an upgrade rather than a hard dependency.

set -euo pipefail

here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
build_dir="$here/build"
binary="$build_dir/dsh-ocr"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "dsh-ocr uses the macOS Vision framework and only builds on macOS." >&2
  exit 1
fi

if ! command -v swiftc >/dev/null 2>&1; then
  echo "swiftc not found. Install the Xcode Command Line Tools:" >&2
  echo "  xcode-select --install" >&2
  exit 1
fi

# Built against an explicit floor rather than the host OS version so the binary
# keeps working after the machine is upgraded or the helper is copied.
case "$(uname -m)" in
  arm64) target="arm64-apple-macos12.0" ;;
  *) target="x86_64-apple-macos12.0" ;;
esac

mkdir -p "$build_dir"
swiftc -O -whole-module-optimization -target "$target" \
  -o "$binary" "$here/src/main.swift"
echo "built $binary"

if [[ "${1:-}" == "--build-only" ]]; then
  exit 0
fi

if [[ -z "${PREFIX:-}" ]]; then
  if command -v brew >/dev/null 2>&1; then
    PREFIX="$(brew --prefix)"
  else
    PREFIX="/usr/local"
  fi
fi

mkdir -p "$PREFIX/bin"
install -m 0755 "$binary" "$PREFIX/bin/dsh-ocr"
echo "installed $PREFIX/bin/dsh-ocr"

if ! command -v dsh-ocr >/dev/null 2>&1; then
  echo "note: $PREFIX/bin is not on PATH; set DSH_OCR_BIN=$PREFIX/bin/dsh-ocr" >&2
fi
