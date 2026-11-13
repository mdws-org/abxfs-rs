#!/bin/sh
# Run a verifier over archive/vectors: a bundle whose .out starts "reject" must exit 1 with that class first on its
# line; any other must exit 0 and print exactly its .out.
# usage: tools/archive/check-vectors.sh <verifier command...>      (the bundle path is appended)
dir=$(dirname "$0")/../../archive/vectors
pass=0; fail=0
got=$(mktemp)
for car in "$dir"/*.car; do
  name=${car%.car}
  "$@" "$car" > "$got" 2>/dev/null; code=$?
  if head -c 7 "$name.out" | grep -q '^reject '; then
    want=$(cut -d' ' -f2 "$name.out" | head -n 1); have=$(head -n 1 "$got" | cut -d' ' -f1-2)
    if [ "$code" = 1 ] && [ "$have" = "reject $want" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL $(basename "$name"): want reject $want, got exit $code: $(head -c 160 "$got")"; fi
  elif [ "$code" = 0 ] && cmp -s "$got" "$name.out"; then pass=$((pass+1))
  else fail=$((fail+1)); echo "FAIL $(basename "$name"): exit $code, listing differs"; fi
done
rm -f "$got"
echo "$pass pass, $fail fail"
[ "$fail" = 0 ]
