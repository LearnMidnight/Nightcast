#!/usr/bin/env bash
# Questions for the compiler before the stake pool link goes into the network contract: what
# can a contract do with a Curve25519Point (a pool's Ed25519 key) besides verify with it? Hash
# it, store it, compare it? And which hashes suit a Merkle list of pool keys? Each case is a
# tiny contract compiled on its own, with keys (some limits only show when the circuit is built).
#   bash network/threshold/check/run-c25519.sh     (COMPACTC: default /root/compactc-0.36.1/compactc)
set -uo pipefail
read -r -a C <<< "${COMPACTC:-/root/compactc-0.36.1/compactc}"
echo "compiler: $("${C[@]}" --version)"
W=$(mktemp -d /tmp/c25519-probe.XXXXXX)
HEAD='pragma language_version >= 0.28;
import CompactStandardLibrary;'
try() { # name, what it asks, body
  printf '%s\n%s\n' "$HEAD" "$3" > "$W/$1.compact"
  local start; start=$(date +%s)
  if "${C[@]}" "$W/$1.compact" "$W/out-$1" > "$W/$1.log" 2>&1; then
    local size=""; for f in "$W/out-$1"/keys/*.prover; do [ -f "$f" ] && size=" prover $(stat -c %s "$f")"; done
    echo "YES  $1: $2 ($(( $(date +%s) - start )) s$size)"
  else
    echo "NO   $1: $2"
    grep -v '^\s*$' "$W/$1.log" | head -4 | cut -c1-230 | sed 's/^/       /'
  fi
}

try hash "persistentHash of a Curve25519Point" '
export ledger seen: Map<Bytes<32>, Boolean>;
export circuit f(pool: Curve25519Point): [] { seen.insert(persistentHash<Curve25519Point>(disclose(pool)), true); }'

try store "a Curve25519Point kept in the ledger" '
export ledger keys: Map<Bytes<32>, Curve25519Point>;
export circuit f(id: Bytes<32>, pool: Curve25519Point): [] { keys.insert(disclose(id), disclose(pool)); }'

try equal "two Curve25519Points compared with ==" '
export ledger last: Boolean;
export circuit f(a: Curve25519Point, b: Curve25519Point): [] { last = disclose(a == b); }'

try whatis "(meant to fail: the error names the type)" '
export ledger last: Field;
export circuit f(pool: Curve25519Point): [] { last = disclose(pool); }'

try fieldx "(meant to fail or pass: does it have a field x?)" '
export ledger last: Field;
export circuit f(pool: Curve25519Point): [] { last = disclose(pool.x); }'

try accessor "(meant to fail or pass: is there a curve25519PointX?)" '
export ledger last: Boolean;
export circuit f(a: Curve25519Point, b: Curve25519Point): [] { last = disclose(curve25519PointX(a) == curve25519PointX(b)); }'

try degrade "degradeToTransient: a Bytes<32> hash as a Field" '
export ledger last: Field;
export circuit f(b: Bytes<32>): [] { last = disclose(degradeToTransient(persistentHash<Bytes<32>>(b))); }'

try mixed "transientHash over a Field and a Bytes<32>" '
export ledger last: Field;
export circuit f(b: Bytes<32>): [] { last = disclose(transientHash<[Field, Bytes<32>]>([7 as Field, b])); }'


try tree13 "a 13-level Merkle path, transientHash nodes, the side given by a witness bit" '
export ledger last: Field;
struct Step { sibling: Field; right: Boolean; }
witness path(): Vector<13, Step>;
export circuit f(leaf: Field): [] {
  const p = path();
  const top = fold((acc, s) => s.right
      ? transientHash<[Field, Field, Field]>([2 as Field, s.sibling, acc])
      : transientHash<[Field, Field, Field]>([2 as Field, acc, s.sibling]),
    disclose(leaf), p);
  last = disclose(top);
}'

try tree13p "the same path with persistentHash (SHA-256) nodes: how much bigger" '
export ledger last: Bytes<32>;
struct Step { sibling: Bytes<32>; right: Boolean; }
witness path(): Vector<13, Step>;
export circuit f(leaf: Bytes<32>): [] {
  const p = path();
  const top = fold((acc, s) => s.right
      ? persistentHash<[Bytes<32>, Bytes<32>, Bytes<32>]>([pad(32, "node"), s.sibling, acc])
      : persistentHash<[Bytes<32>, Bytes<32>, Bytes<32>]>([pad(32, "node"), acc, s.sibling]),
    disclose(leaf), p);
  last = disclose(top);
}'

try stdtree "the standard library Merkle path (merkleTreePathRoot)" '
export ledger last: Boolean;
export sealed ledger root: MerkleTreeDigest;
witness path(): MerkleTreePath<13, Bytes<32>>;
constructor(r: MerkleTreeDigest) { root = disclose(r); }
export circuit f(): [] { last = disclose(merkleTreePathRoot<13, Bytes<32>>(path()) == root); }'

try message "a link message hashed in the contract, then ed25519Verify (slow: about 2.5 minutes)" '
struct Link { domain: Bytes<32>; deployment: ContractAddress; operator: Bytes<32>; number: Field; }
export ledger linked: Map<Bytes<32>, Boolean>;
export pure circuit linkMessageOf(deployment: ContractAddress, operator: Bytes<32>, number: Uint<64>): Bytes<32> {
  return persistentHash<Link>(Link { domain: pad(32, "nightcast:pool-link:v1"), deployment: deployment, operator: operator, number: number as Field });
}
export circuit f(operator: Bytes<32>, sig: Ed25519Signature, pool: Curve25519Point): [] {
  const id = disclose(operator);
  assert(ed25519Verify<32>(linkMessageOf(kernel.self(), id, 0), disclose(sig), disclose(pool)), "not signed");
  linked.insert(id, true);
}'
rm -rf "$W"/out-*
echo "(logs: $W)"
