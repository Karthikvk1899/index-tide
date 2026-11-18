#!/usr/bin/env sh
set -eu
umask 077
if [ -e .env ]; then echo 'Using existing .env'; exit 0; fi
tmp=$(mktemp ./.keys.XXXXXX)
trap 'rm -f "$tmp"' EXIT
for name in SOURCE_PASSWORD INDEX_PASSWORD OPERATOR_KEY READER_KEY UPLAND_KEY; do
  printf '%s=%s\n' "$name" "$(openssl rand -hex 32)" >> "$tmp"
done
ln "$tmp" .env
