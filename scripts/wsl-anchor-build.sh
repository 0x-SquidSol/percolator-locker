#!/usr/bin/env bash
set -e
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
export PATH="$HOME/.cargo/bin:$PATH"
export PATH="$HOME/.nvm/versions/node/v24.10.0/bin:$PATH"
[ -d "$HOME/.local/share/solana/install/active_release/bin" ] \
  && export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

cd /mnt/c/Dev/percolator-locker
anchor build 2>&1 | tail -15
