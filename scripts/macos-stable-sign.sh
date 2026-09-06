#!/bin/bash
# 稳定本地代码签名：TCC 按 bundle id 认应用，不再绑每次打包都变的 ad-hoc cdhash。
set -euo pipefail

IDENTITY_CN="${DSH_CODESIGN_CN:-DeepSeek Harness Local}"
BUNDLE_ID="${DSH_BUNDLE_ID:-ai.deepseek.harness.desktop}"
LOGIN_KC="${HOME}/Library/Keychains/login.keychain-db"
LOGIN_PASS="${DSH_KEYCHAIN_PASSWORD:-1234}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEFAULT_ENTITLEMENTS="${SCRIPT_DIR}/../src-tauri/entitlements.plist"
ENTITLEMENTS="${DSH_ENTITLEMENTS:-$DEFAULT_ENTITLEMENTS}"
if [[ ! -f "${ENTITLEMENTS}" ]]; then
  echo "[sign] missing entitlements: ${ENTITLEMENTS}" >&2
  exit 1
fi

ensure_identity() {
  if security find-identity -v -p codesigning 2>/dev/null | grep -q "${IDENTITY_CN}"; then
    echo "[sign] reuse identity: ${IDENTITY_CN}"
    return 0
  fi
  echo "[sign] create identity: ${IDENTITY_CN}"
  local tmp
  tmp="$(mktemp -d)"
  cat >"${tmp}/cert.cnf" <<EOF
[req]
distinguished_name = req_distinguished_name
prompt = no
x509_extensions = v3_codesign
[req_distinguished_name]
CN = ${IDENTITY_CN}
O = DeepSeek Harness
C = CN
[v3_codesign]
basicConstraints = CA:FALSE
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
subjectKeyIdentifier = hash
EOF
  openssl req -new -newkey rsa:2048 -nodes \
    -keyout "${tmp}/dsh.key" -x509 -days 3650 \
    -out "${tmp}/dsh.crt" -config "${tmp}/cert.cnf" >/dev/null 2>&1
  openssl pkcs12 -export \
    -inkey "${tmp}/dsh.key" -in "${tmp}/dsh.crt" \
    -out "${tmp}/dsh.p12" -passout pass:dshlocal \
    -name "${IDENTITY_CN}" >/dev/null 2>&1
  security unlock-keychain -p "${LOGIN_PASS}" "${LOGIN_KC}" >/dev/null 2>&1 || true
  security import "${tmp}/dsh.p12" -k "${LOGIN_KC}" -P dshlocal \
    -T /usr/bin/codesign -T /usr/bin/security -T /usr/bin/productsign >/dev/null
  security set-key-partition-list -S apple-tool:,apple:,codesign: -s \
    -k "${LOGIN_PASS}" "${LOGIN_KC}" >/dev/null 2>&1 || true
  rm -rf "${tmp}"
}

inject_usage_strings() {
  local app="$1"
  local plist="${app}/Contents/Info.plist"
  /usr/libexec/PlistBuddy -c 'Add :NSAccessibilityUsageDescription string DeepSeek Harness 需要「辅助功能」权限，以便读取本机应用界面并代为点击、输入。' "$plist" 2>/dev/null || \
    /usr/libexec/PlistBuddy -c 'Set :NSAccessibilityUsageDescription DeepSeek Harness 需要「辅助功能」权限，以便读取本机应用界面并代为点击、输入。' "$plist"
  /usr/libexec/PlistBuddy -c 'Add :NSScreenCaptureUsageDescription string DeepSeek Harness 需要「屏幕录制」权限，以便截取窗口画面核对界面状态。' "$plist" 2>/dev/null || \
    /usr/libexec/PlistBuddy -c 'Set :NSScreenCaptureUsageDescription DeepSeek Harness 需要「屏幕录制」权限，以便截取窗口画面核对界面状态。' "$plist"
  /usr/libexec/PlistBuddy -c 'Add :NSAppleEventsUsageDescription string DeepSeek Harness 需要通过 Apple Events 与其他应用协作。' "$plist" 2>/dev/null || \
    /usr/libexec/PlistBuddy -c 'Set :NSAppleEventsUsageDescription DeepSeek Harness 需要通过 Apple Events 与其他应用协作。' "$plist"
}

sign_helper() {
  local helper="$1"
  local identifier="$2"
  local args=(--force --sign "${IDENTITY_CN}" --identifier "${identifier}" --options runtime --timestamp=none)
  if [[ -n "${ENTITLEMENTS}" && -f "${ENTITLEMENTS}" ]]; then
    args+=(--entitlements "${ENTITLEMENTS}")
  fi
  codesign "${args[@]}" "${helper}"
}

sign_app() {
  local app="$1"
  inject_usage_strings "$app"
  xattr -cr "$app" 2>/dev/null || true
  # 先签内嵌 helper，再签 bundle。Node/V8 在 hardened runtime 下必须带 JIT
  # entitlements，否则 Isolate::Init 会 FatalOOM: Failed to reserve virtual
  # memory for CodeRange（别人机器上 Gatekeeper 更严，本地可能碰巧能跑）。
  if [[ -x "${app}/Contents/Resources/runtime/node" ]]; then
    sign_helper "${app}/Contents/Resources/runtime/node" "${BUNDLE_ID}.node"
  fi
  if [[ -x "${app}/Contents/MacOS/deepseek-harness-desktop" ]]; then
    sign_helper "${app}/Contents/MacOS/deepseek-harness-desktop" "${BUNDLE_ID}"
  fi
  local req="=designated => identifier \"${BUNDLE_ID}\""
  local bundle_args=(--force --sign "${IDENTITY_CN}" --identifier "${BUNDLE_ID}" --requirements "${req}" --options runtime --timestamp=none)
  if [[ -n "${ENTITLEMENTS}" && -f "${ENTITLEMENTS}" ]]; then
    bundle_args+=(--entitlements "${ENTITLEMENTS}")
  fi
  # 只签主 bundle，不要 --deep：node_modules 里几百个二进制会被重签，TCC 只认主应用 DR。
  codesign "${bundle_args[@]}" "$app"
  codesign --verify --strict "$app"
  echo "[sign] designated requirement:"
  codesign -d -r- "$app" 2>&1 | tail -1
}

write_tcc_identifier() {
  local client="$1"
  local reqfile
  reqfile="$(mktemp)"
  csreq -r "=identifier \"${client}\"" -b "$reqfile"
  python3 - "$client" "$reqfile" <<'PY'
import sqlite3, sys, os, time, subprocess, textwrap
client, reqfile = sys.argv[1], sys.argv[2]
blob = open(reqfile, "rb").read()
now = int(time.time())
user_db = os.path.expanduser("~/Library/Application Support/com.apple.TCC/TCC.db")
sys_db = "/Library/Application Support/com.apple.TCC/TCC.db"
svcs = (
    "kTCCServiceAccessibility",
    "kTCCServiceScreenCapture",
    "kTCCServiceListenEvent",
    "kTCCServicePostEvent",
    "kTCCServiceAppleEvents",
)

def patch_con(con):
    for svc in svcs:
        row = con.execute(
            "SELECT COUNT(*) FROM access WHERE service=? AND client=?",
            (svc, client),
        ).fetchone()[0]
        if row:
            con.execute(
                "UPDATE access SET csreq=?, auth_value=2, last_modified=? WHERE service=? AND client=?",
                (blob, now, svc, client),
            )
        elif svc in ("kTCCServiceAccessibility", "kTCCServiceScreenCapture"):
            con.execute(
                "INSERT INTO access (service, client, client_type, auth_value, auth_reason, auth_version, csreq, flags, last_modified) VALUES (?,?,0,2,0,1,?,0,?)",
                (svc, client, blob, now),
            )
    con.commit()

if os.path.exists(user_db):
    con = sqlite3.connect(user_db)
    patch_con(con)
    con.close()
    print(f"[tcc] updated {user_db} for {client} csreq={len(blob)}B")

if os.path.exists(sys_db):
    env = os.environ.copy()
    env.setdefault("SUDO_ASKPASS", "/tmp/askpass.sh")
    helper = "/tmp/dsh_tcc_patch.py"
    open(helper, "w").write(textwrap.dedent(f"""
        import sqlite3, time
        blob = {blob!r}
        now = {now}
        client = {client!r}
        db = {sys_db!r}
        svcs = {svcs!r}
        con = sqlite3.connect(db)
        for svc in svcs:
            row = con.execute("SELECT COUNT(*) FROM access WHERE service=? AND client=?", (svc, client)).fetchone()[0]
            if row:
                con.execute("UPDATE access SET csreq=?, auth_value=2, last_modified=? WHERE service=? AND client=?", (blob, now, svc, client))
            elif svc in ("kTCCServiceAccessibility","kTCCServiceScreenCapture"):
                con.execute("INSERT INTO access (service, client, client_type, auth_value, auth_reason, auth_version, csreq, flags, last_modified) VALUES (?,?,0,2,0,1,?,0,?)", (svc, client, blob, now))
        con.commit()
    """))
    r = subprocess.run(["sudo", "-A", "python3", helper], env=env, capture_output=True, text=True)
    if r.returncode != 0:
        print(f"[tcc] system db skip: {r.stderr.strip()[:240]}")
    else:
        print(f"[tcc] updated {sys_db} for {client} csreq={len(blob)}B")
PY
  rm -f "$reqfile"
}

APP="${1:-}"
if [[ -z "$APP" ]]; then
  echo "usage: $0 /path/to/DeepSeek Harness.app" >&2
  exit 2
fi
ensure_identity
sign_app "$APP"
write_tcc_identifier "${BUNDLE_ID}"
write_tcc_identifier "com.pchatbridge.app.computer-use"
write_tcc_identifier "com.pchatapi.app.computer-use"
echo "[sign] done $APP"
