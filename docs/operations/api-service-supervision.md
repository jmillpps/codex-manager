# Operations: Always-On API Service

## Purpose

This runbook defines the supported way to keep the Codex Manager API running continuously on a Linux machine, including after logout/reboot/resume.

The recommended approach is a **user-level systemd service** with `Restart=always`.

## Why this is the right model

- `systemd --user` keeps one authoritative process owner for the API.
- `Restart=always` restarts the API automatically if it exits/crashes.
- `enable --now` makes startup persistent and immediate.
- user-level service avoids requiring root for normal operation.

## Install and enable

From repository root:

```bash
./scripts/install-api-user-service.sh
```

What this does:

- writes `~/.config/systemd/user/codex-manager-api.service`
- reloads user systemd units
- enables and starts the service (`enable --now`)
- attempts `loginctl enable-linger $USER` so service can run at boot even without an active login session

If linger cannot be enabled automatically, run:

```bash
sudo loginctl enable-linger "$USER"
```

## Day-to-day operations

Check status:

```bash
systemctl --user status codex-manager-api.service
```

Follow logs:

```bash
journalctl --user -u codex-manager-api.service -f
```

Restart:

```bash
systemctl --user restart codex-manager-api.service
```

Stop:

```bash
systemctl --user stop codex-manager-api.service
```

Start:

```bash
systemctl --user start codex-manager-api.service
```

Disable (no auto-start):

```bash
systemctl --user disable --now codex-manager-api.service
```

Health probe:

```bash
curl -sf http://127.0.0.1:3001/api/health
```

## Configuration source

The service reads API config from:

- `apps/api/.env` (optional but recommended)
- process environment provided by systemd unit

At minimum ensure `apps/api/.env` sets:

```env
HOST=127.0.0.1
PORT=3001
LOG_LEVEL=info
```

Codex runtime controls are also read from `apps/api/.env`, including:

- `CODEX_BIN`
- `CODEX_HOME`
- `DATA_DIR`
- `DEFAULT_APPROVAL_POLICY`
- `DEFAULT_SANDBOX_MODE`
- `DEFAULT_NETWORK_ACCESS`
- `SESSION_DEFAULTS_LOCKED`

## Failure modes and recovery

If service is flapping:

1. check logs: `journalctl --user -u codex-manager-api.service -n 200 --no-pager`
2. verify `pnpm` and `codex` are available for the user account
3. verify `apps/api/.env` contains valid values
4. run the service command manually for direct output:

```bash
pnpm --filter @repo/api dev
```

If service starts but health endpoint fails:

1. verify `PORT` in `apps/api/.env`
2. check for port conflicts (`ss -ltnp | rg 3001`)
3. inspect API logs for startup/config errors

