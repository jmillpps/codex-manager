#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/.." && pwd)"
service_name="codex-manager-api.service"
service_dir="${XDG_CONFIG_HOME:-${HOME}/.config}/systemd/user"
service_path="${service_dir}/${service_name}"
env_file="${repo_root}/apps/api/.env"

if ! command -v systemctl >/dev/null 2>&1; then
  echo "error: systemctl is not available on this machine." >&2
  exit 1
fi

if ! systemctl --user --version >/dev/null 2>&1; then
  echo "error: systemd user manager is unavailable (cannot use user services)." >&2
  exit 1
fi

if ! command -v pnpm >/dev/null 2>&1; then
  echo "error: pnpm is required but not found on PATH." >&2
  exit 1
fi

pnpm_bin="$(command -v pnpm)"
codex_bin="$(command -v codex || true)"
if [[ -z "${codex_bin}" ]]; then
  echo "warning: codex binary not found on PATH while installing service." >&2
  echo "warning: ensure CODEX_BIN is set in ${env_file} or codex is available in systemd user PATH." >&2
fi

mkdir -p "${service_dir}"

path_value="${HOME}/.local/share/pnpm:${HOME}/.local/bin:/usr/local/bin:/usr/bin:/bin"
if [[ -n "${codex_bin}" ]]; then
  codex_dir="$(dirname "${codex_bin}")"
  path_value="${codex_dir}:${path_value}"
fi

cat > "${service_path}" <<EOF
[Unit]
Description=Codex Manager API (development)
After=default.target
StartLimitIntervalSec=0

[Service]
Type=simple
WorkingDirectory=${repo_root}
Environment=NODE_ENV=development
Environment=PATH=${path_value}
EnvironmentFile=-${env_file}
ExecStart=${pnpm_bin} --filter @repo/api dev
Restart=always
RestartSec=2
TimeoutStopSec=20
KillMode=mixed

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now "${service_name}"

if command -v loginctl >/dev/null 2>&1; then
  if ! loginctl enable-linger "${USER}" >/dev/null 2>&1; then
    echo "warning: could not enable linger for ${USER}. Boot-time auto-start may require root to run:" >&2
    echo "warning:   sudo loginctl enable-linger ${USER}" >&2
  fi
fi

echo "installed: ${service_path}"
echo "active service status:"
systemctl --user --no-pager --lines=0 status "${service_name}" || true
echo
echo "health check:"
curl -sf "http://127.0.0.1:3001/api/health" | head -c 400 || true
echo
