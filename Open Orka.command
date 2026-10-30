#!/bin/zsh
# Double-click to run this worktree with its own profile and frontend port.
set -eu
orka_root="${0:A:h}"
export PATH="$HOME/.cargo/bin:$PATH"
if ! command -v npm >/dev/null 2>&1 && [[ -s "$HOME/.nvm/nvm.sh" ]]; then
  source "$HOME/.nvm/nvm.sh"
fi
if ! command -v npm >/dev/null 2>&1; then
  print 'Node.js is required. Install Node 24+, then run this launcher again.'
  read '?Press Return to close.'
  exit 1
fi
cd "$orka_root"
exec npm run dev:profile -- "$@"
