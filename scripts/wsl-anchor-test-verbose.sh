#!/usr/bin/env bash
set -e
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
export PATH="$HOME/.cargo/bin:$PATH"
export PATH="$HOME/.nvm/versions/node/v24.10.0/bin:$PATH"
[ -d "$HOME/.local/share/solana/install/active_release/bin" ] \
  && export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

cd /mnt/c/Dev/percolator-locker
rm -rf .anchor/test-ledger
# No tail pipe — let output stream live so we see progress
timeout 480 anchor test --skip-build 2>&1
