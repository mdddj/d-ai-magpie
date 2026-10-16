#!/usr/bin/env bash
# End-to-end check for the D.AI magpie plugin, in a throwaway HOME so the
# real magpie, its providers and its sign-ins are never touched.
#
#   DAI_API_KEY=ddsk_…  ./e2e.sh
#   DAI_API_KEY=ddsk_…  ./e2e.sh --live   # also calls both APIs
#
# Writes a summary to $E2E_OUT (default: mktemp) and prints it. Exit code is
# the number of failed checks.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIVE=0
[[ "${1:-}" == "--live" ]] && LIVE=1
KEY="${DAI_API_KEY:-}"
if [[ -z "$KEY" ]]; then
	echo "DAI_API_KEY is required (a ddsk_… key from the D.AI console)" >&2
	exit 2
fi

SB="$(mktemp -d "${TMPDIR:-/tmp}/dai-magpie-e2e.XXXXXX")"
OUT="${E2E_OUT:-$SB/summary.txt}"
FAILED=0
m() { env HOME="$SB" XDG_CONFIG_HOME="$SB/.config" XDG_CACHE_HOME="$SB/.cache" magpie "$@"; }
# One `magpie` command is one plugin host: the sandbox is small, so we accept
# the extra startup cost rather than run a gateway for the whole script.
report() { printf '%s\n' "$*" | tee -a "$OUT"; }
check() { # check <name> <expected> <actual> [pattern]
	local name="$1" want="$2" got="$3" want_re="${4:-}"
	if [[ -n "$want_re" ]]; then
		if [[ "$got" =~ $want_re ]]; then
			report "ok    $name: ${BASH_REMATCH[0]}"
		else
			report "FAIL  $name: no /$want_re/ in: ${got:0:200}"
			FAILED=$((FAILED + 1))
		fi
	elif [[ "$want" == "$got" ]]; then
		report "ok    $name: $got"
	else
		report "FAIL  $name: expected $want, got $got"
		FAILED=$((FAILED + 1))
	fi
}

{
	echo "D.AI magpie plugin end-to-end"
	echo "plugin:   $HERE"
	echo "sandbox:  $SB"
	echo "magpie:   $(magpie --version 2>/dev/null)"
	echo "date:     $(date -u +%Y-%m-%dT%H:%M:%SZ)"
	echo
} >>"$OUT"

m plugin add "$HERE" </dev/null >/dev/null 2>&1
printf '%s\n' "$KEY" | m plugin login dai >/dev/null 2>&1

LIST="$(m plugin 2>/dev/null)"
check "provider loads" "1" "$(grep -c 'dai (D.AI' <<<"$LIST")"
check "sign-in stored" "1" "$(grep -c 'signed in' <<<"$LIST")"

JSON="$(m plugin --json 2>/dev/null | python3 -c '
import json, sys
d = json.load(sys.stdin)
p = d["providers"][0]
print(json.dumps({
    "count": len(p["models"]),
    "ids": sorted(m["id"] for m in p["models"]),
    "apis": sorted({m["npm"] for m in p["models"]}),
    "variants": len([m for m in p["models"] if m.get("variants")]),
    "icon": p.get("icon", ""),
    "methods": [m["type"] for m in p.get("methods", [])],
}))' 2>/dev/null)"
check "catalog size" "15" "$(python3 -c "import json,sys;print(json.loads(sys.argv[1])['count'])" "$JSON")"
check "two APIs" 1 "$JSON" "anthropic|@ai-sdk/anthropic"
check "sign-in method" "api" "$(python3 -c "import json,sys;print(json.loads(sys.argv[1])['methods'][0])" "$JSON" 2>/dev/null)"
check "plugin icon" 1 "$JSON" "data:image/svg|https://[^\"]+\\.svg"

QUOTA="$(m quota 2>/dev/null | grep '^dai' || true)"
# The balance card needs the backend endpoint; a deployment that predates it
# still answers from the call log, and both are a passing card.
check "usage hook" 1 "$QUOTA" "D.AI balance|D.AI calls"

if [[ "$LIVE" == "1" ]]; then
	TEST="$(m provider test dai 2>&1)"
	check "live chat" 1 "$TEST" "✓ chat"
	check "live anthropic" 1 "$TEST" "✓ anthropic"
fi

report ""
report "sandbox kept at $SB (remove it when done)"
exit "$FAILED"
