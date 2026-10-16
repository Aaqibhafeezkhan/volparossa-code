#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-only
# Exact core-owned AppArmor profile, scoped to this disposable source build.
set -euo pipefail
test "$#" -eq 0
python3 -B scripts/opencode_ci.py guard
core="$PWD/build/ci-core"
selected_core=$(python3 -B scripts/opencode_ci.py select --model-profile "${MODEL_PROFILE:-qwen3-0.6b-v1}" --inference-backend "${INFERENCE_BACKEND:-torch}")
test "$(git -C "$core" rev-parse HEAD)" = "${selected_core#core_revision=}"
profile="$core/tests/integration/native-coding-bwrap.apparmor"
test "$(sha256sum "$profile" | cut -d ' ' -f 1)" = 3f3fefdfc6fe46e882af9b803ddcddd6691083e434b26f5fb244ceddf05b6794
test "$(dpkg-query -S /usr/bin/bwrap)" = 'bubblewrap: /usr/bin/bwrap'
test -z "$(dpkg --verify bubblewrap)"
test "$(stat -c '%u:%a' /usr/bin/bwrap)" = 0:755
test ! -L /usr/bin/bwrap
staged=/run/volparossa-opencode-ci.apparmor
test ! -e "$staged" && test ! -L "$staged"
inventory=$(sudo -n cat /sys/kernel/security/apparmor/profiles)
if grep -Eq 'bwrap|volparossa_ci_native' <<<"$inventory"; then exit 1; fi
restriction=$(< /proc/sys/kernel/apparmor_restrict_unprivileged_userns)
test "$restriction" = 1
owned=0
attempted=0
build_pid=
build_status=null
# shellcheck disable=SC2317
cleanup() {
  result=$?
  trap - EXIT INT TERM
  cleanup_result=0
  if test -n "$build_pid"; then
    kill -TERM -- "-$build_pid" 2>/dev/null || true
    for _ in {1..20}; do
      kill -0 "$build_pid" 2>/dev/null || break
      sleep 0.25
    done
    kill -KILL -- "-$build_pid" 2>/dev/null || true
    wait "$build_pid" 2>/dev/null || true
  fi
  if test "$attempted" = 1; then
    sudo -n /usr/sbin/apparmor_parser --remove --skip-cache "$staged" || cleanup_result=1
    remaining=$(sudo -n cat /sys/kernel/security/apparmor/profiles) || cleanup_result=1
    if grep -q volparossa_ci_native <<<"${remaining:-}"; then cleanup_result=1; fi
  fi
  if test "$owned" = 1; then sudo -n rm -- "$staged" || cleanup_result=1; fi
  test "$(< /proc/sys/kernel/apparmor_restrict_unprivileged_userns)" = "$restriction" || cleanup_result=1
  (umask 077; printf '{"version":1,"ci_bwrap_cleanup_complete":%s,"source_build_exit_status":%s}\n' \
    "$([ "$cleanup_result" = 0 ] && printf true || printf false)" "$build_status" >build/ci-build-cleanup.json)
  if test "$cleanup_result" != 0; then result=1; fi
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
sudo -n install -o root -g root -m 0600 -- "$profile" "$staged"
owned=1
attempted=1
sudo -n /usr/sbin/apparmor_parser --add --skip-cache "$staged"
setsid python3 -B scripts/opencode_ci.py build &
build_pid=$!
if wait "$build_pid"; then build_status=0; else build_status=$?; fi
build_pid=
exit "$build_status"
