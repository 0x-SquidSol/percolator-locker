#!/usr/bin/env bash
set -e

# Hard-reset PATH to a clean Linux baseline so Windows PATH pollution from
# `bash -lc` doesn't break the script. Then layer on the tools we need.
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
export PATH="$HOME/.cargo/bin:$PATH"
export PATH="$HOME/.nvm/versions/node/v24.10.0/bin:$PATH"
# Agave/Solana install bin, if present
[ -d "$HOME/.local/share/solana/install/active_release/bin" ] \
  && export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

cd /mnt/c/Dev/percolator-locker
rm -rf .anchor/test-ledger
anchor test --skip-build 2>&1 | tail -100
