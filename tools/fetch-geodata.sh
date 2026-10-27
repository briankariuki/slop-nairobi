#!/bin/bash
# usage: tools/fetch-geodata.sh — downloads every tools/data/q_<name>.overpassql to tools/data/osm_<name>.json
set -euo pipefail
DIR=$(cd "$(dirname "$0")" && pwd)
for q in "$DIR"/data/q_*.overpassql; do
  name=$(basename "$q" .overpassql)
  name=${name#q_}
  echo "== $name"
  "$DIR/overpass.sh" "$DIR/data/osm_$name.json" "$q"
  sleep 5 # be polite to the public Overpass servers
done
