#!/bin/bash
# Ensures node-stdlib-browser mock/empty.js exists next to bundled output
# Agent OS depends on @secure-exec which depends on node-stdlib-browser,
# which resolves "./mock/empty.js" relative to the bundle at runtime.

BUILD_DIR="$1"
BUN_INDEX="$BUILD_DIR/bun/index.js"

if [ -f "$BUN_INDEX" ]; then
	BUN_DIR=$(dirname "$BUN_INDEX")
	mkdir -p "$BUN_DIR/mock"
	# mock/empty.js just exports null
	echo 'module.exports = null;' > "$BUN_DIR/mock/empty.js"
fi
