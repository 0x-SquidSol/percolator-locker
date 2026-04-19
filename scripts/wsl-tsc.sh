#!/usr/bin/env bash
set -e
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
export PATH="$HOME/.cargo/bin:$PATH"
export PATH="$HOME/.nvm/versions/node/v24.10.0/bin:$PATH"
cd /mnt/c/Dev/percolator-locker
timeout 60 npx tsc -p tsconfig.json --noEmit 2>&1 | head -60
