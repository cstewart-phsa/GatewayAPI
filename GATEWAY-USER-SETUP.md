# Cohesity + HPEGreenLake + Lansweeper + vSphere MCP gateway — user setup

This guide is for users connecting an AI harness or MCP client to the Cohesity,
HPEGreenLake, Lansweeper, and vSphere MCP gateways. All four use the **same gateway token**.

## Important terminology

The **gateway API key** is also called the **gateway token**. It is the secret
value you receive from the gateway owner. It identifies you to the gateway.

You do **not** configure a personal Cohesity/Helios API key, GreenLake
credential, Lansweeper Windows/AD credential, or vCenter domain password. Those
secrets stay on the gateway server and are never sent to clients.

```
Your AI harness / MCP client
        |
        |  X-Gateway-Token: <your gateway token>
        v
Caddy gateway  http://10.53.19.120:8081/cohesity/mcp
               http://10.53.19.120:8081/hpegreenlake/mcp
               http://10.53.19.120:8081/lansweeper/mcp
               http://10.53.19.120:8081/vsphere/mcp
        |
        v
Gateway validates your token, role, and allowed tools
        |
        +--> Cohesity MCP + server-side DPAPI shared Cohesity key
        |
        +--> HPEGreenLake MCP + server-side DPAPI GreenLake credential
        |
        +--> Lansweeper MCP + server-side DPAPI Windows/AD credential
        |
        +--> vSphere MCP + server-side DPAPI domain credential
```

---

## 1. What you need

| Item | Value |
|---|---|
| Cohesity URL, HTTP | `http://10.53.19.120:8081/cohesity/mcp` |
| Cohesity URL, HTTPS | `https://10.53.19.120:8088/cohesity/mcp` |
| Cohesity health | `http://10.53.19.120:8081/cohesity/health` |
| HPEGreenLake URL, HTTP | `http://10.53.19.120:8081/hpegreenlake/mcp` |
| HPEGreenLake URL, HTTPS | `https://10.53.19.120:8088/hpegreenlake/mcp` |
| HPEGreenLake health | `http://10.53.19.120:8081/hpegreenlake/health` |
| Lansweeper URL, HTTP | `http://10.53.19.120:8081/lansweeper/mcp` |
| Lansweeper URL, HTTPS | `https://10.53.19.120:8088/lansweeper/mcp` |
| Lansweeper health | `http://10.53.19.120:8081/lansweeper/health` |
| vSphere URL, HTTP | `http://10.53.19.120:8081/vsphere/mcp` |
| vSphere URL, HTTPS | `https://10.53.19.120:8088/vsphere/mcp` |
| vSphere health | `http://10.53.19.120:8081/vsphere/health` |
| Your credential | The gateway token from the gateway owner |
| Environment variable name | `COHESITY_GATEWAY_TOKEN` |
| Header name | `X-Gateway-Token` |

Most users have the `read-only` role. Ray Fung has the `admin` role.

---

## 2. Set the gateway token on your machine

### Windows PowerShell

Run this in a terminal and replace the placeholder with your token:

```powershell
setx COHESITY_GATEWAY_TOKEN "<paste-your-gateway-token-here>"
```

Then **open a new terminal** so the variable is visible.

Check it without displaying the token:

```powershell
if ($env:COHESITY_GATEWAY_TOKEN) { Write-Host 'Gateway token is set.' } else { Write-Host 'Gateway token is NOT set.' }
```

### macOS / Linux

```bash
export COHESITY_GATEWAY_TOKEN='<paste-your-gateway-token-here>'
```

To make it permanent, add that line to your shell profile such as
`~/.zshrc` or `~/.bashrc`, then open a new terminal.

> Do not paste your token into chat, tickets, code, or a shared config file.
> If you accidentally expose it, ask the gateway owner to rotate it.

---

## 3. Configure your MCP client

If the client already has a `cohesity` server entry using
`X-Cohesity-API-Key`, `X-Helios-API-Key`, `Authorization: Bearer`, or
`X-Gateway-User`, remove those headers. Only send `X-Gateway-Token`.

### OpenCode 2.x

File: `%USERPROFILE%\.config\opencode\opencode.json`

Merge this into the existing JSON:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "cohesity": {
        "type": "remote",
        "url": "http://10.53.19.120:8081/cohesity/mcp",
        "oauth": false,
        "headers": {
          "X-Gateway-Token": "{env:COHESITY_GATEWAY_TOKEN}"
        }
      },
      "hpegreenlake": {
        "type": "remote",
        "url": "http://10.53.19.120:8081/hpegreenlake/mcp",
        "oauth": false,
        "headers": {
          "X-Gateway-Token": "{env:COHESITY_GATEWAY_TOKEN}"
        }
      },
      "lansweeper": {
        "type": "remote",
        "url": "http://10.53.19.120:8081/lansweeper/mcp",
        "oauth": false,
        "headers": {
          "X-Gateway-Token": "{env:COHESITY_GATEWAY_TOKEN}"
        }
      },
      "vsphere": {
        "type": "remote",
        "url": "http://10.53.19.120:8081/vsphere/mcp",
        "oauth": false,
        "headers": {
          "X-Gateway-Token": "{env:COHESITY_GATEWAY_TOKEN}"
        }
      }
    }
  }
}
```

`oauth: false` is required. Keep any other entries already in `"servers"`.

If you just set or changed `COHESITY_GATEWAY_TOKEN`, restart the OpenCode
service so it inherits the new environment:

```powershell
opencode service restart
```

### OpenCode 1.x

File: `%USERPROFILE%\.config\opencode\opencode.json`

```json
{
  "mcp": {
    "cohesity": {
      "type": "remote",
      "url": "http://10.53.19.120:8081/cohesity/mcp",
      "enabled": true,
      "headers": {
        "X-Gateway-Token": "{env:COHESITY_GATEWAY_TOKEN}"
      }
    },
    "hpegreenlake": {
      "type": "remote",
      "url": "http://10.53.19.120:8081/hpegreenlake/mcp",
      "enabled": true,
      "headers": {
        "X-Gateway-Token": "{env:COHESITY_GATEWAY_TOKEN}"
      }
    },
    "lansweeper": {
      "type": "remote",
      "url": "http://10.53.19.120:8081/lansweeper/mcp",
      "enabled": true,
      "headers": {
        "X-Gateway-Token": "{env:COHESITY_GATEWAY_TOKEN}"
      }
    },
    "vsphere": {
      "type": "remote",
      "url": "http://10.53.19.120:8081/vsphere/mcp",
      "enabled": true,
      "headers": {
        "X-Gateway-Token": "{env:COHESITY_GATEWAY_TOKEN}"
      }
    }
  }
}
```

OpenCode 1.x uses `enabled: true` instead of `oauth: false`.

### Claude Code / Claude Desktop

File: `.mcp.json` in your repo, or `claude_desktop_config.json`

```json
{
  "mcpServers": {
    "cohesity": {
      "type": "http",
      "url": "http://10.53.19.120:8081/cohesity/mcp",
      "headers": {
        "X-Gateway-Token": "${COHESITY_GATEWAY_TOKEN}"
      }
    },
    "hpegreenlake": {
      "type": "http",
      "url": "http://10.53.19.120:8081/hpegreenlake/mcp",
      "headers": {
        "X-Gateway-Token": "${COHESITY_GATEWAY_TOKEN}"
      }
    },
    "lansweeper": {
      "type": "http",
      "url": "http://10.53.19.120:8081/lansweeper/mcp",
      "headers": {
        "X-Gateway-Token": "${COHESITY_GATEWAY_TOKEN}"
      }
    },
    "vsphere": {
      "type": "http",
      "url": "http://10.53.19.120:8081/vsphere/mcp",
      "headers": {
        "X-Gateway-Token": "${COHESITY_GATEWAY_TOKEN}"
      }
    }
  }
}
```

### Other MCP harnesses

Add four servers:

| Name | URL |
|---|---|
| `cohesity` | `http://10.53.19.120:8081/cohesity/mcp` |
| `hpegreenlake` | `http://10.53.19.120:8081/hpegreenlake/mcp` |
| `lansweeper` | `http://10.53.19.120:8081/lansweeper/mcp` |
| `vsphere` | `http://10.53.19.120:8081/vsphere/mcp` |

For each:

- Type: `http` or `remote`
- OAuth: disabled, if the harness has that option
- Header: `X-Gateway-Token: <value from COHESITY_GATEWAY_TOKEN>`

Merge with existing server entries. Do not replace unrelated configuration.

---

## 4. Verify the gateway

### Check reachability

This endpoint needs no token:

```powershell
Invoke-RestMethod http://10.53.19.120:8081/cohesity/health -TimeoutSec 10
Invoke-RestMethod http://10.53.19.120:8081/hpegreenlake/health -TimeoutSec 10
Invoke-RestMethod http://10.53.19.120:8081/lansweeper/health -TimeoutSec 10
Invoke-RestMethod http://10.53.19.120:8081/vsphere/health -TimeoutSec 10
```

Expected for each:

```text
ok          : True
auth        : gateway_token
```

### List tools

This uses your token but does not print it:

```powershell
curl.exe -sS `
  -H "X-Gateway-Token: $env:COHESITY_GATEWAY_TOKEN" `
  -H "Accept: application/json, text/event-stream" `
  -H "Content-Type: application/json" `
  --data-binary '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' `
  http://10.53.19.120:8081/cohesity/mcp

curl.exe -sS `
  -H "X-Gateway-Token: $env:COHESITY_GATEWAY_TOKEN" `
  -H "Accept: application/json, text/event-stream" `
  -H "Content-Type: application/json" `
  --data-binary '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' `
  http://10.53.19.120:8081/hpegreenlake/mcp

curl.exe -sS `
  -H "X-Gateway-Token: $env:COHESITY_GATEWAY_TOKEN" `
  -H "Accept: application/json, text/event-stream" `
  -H "Content-Type: application/json" `
  --data-binary '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' `
  http://10.53.19.120:8081/lansweeper/mcp

curl.exe -sS `
  -H "X-Gateway-Token: $env:COHESITY_GATEWAY_TOKEN" `
  -H "Accept: application/json, text/event-stream" `
  -H "Content-Type: application/json" `
  --data-binary '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' `
  http://10.53.19.120:8081/vsphere/mcp
```

Expected: a JSON response containing a `"tools"` array for each.

For OpenCode, you can also use:

```text
/mcps
```

or:

```powershell
opencode mcp list
```

---

## 5. Roles and guardrails

### Read-only users

Most users are `read-only`. You can use read and GET-style tools, including:

- listing clusters, protection groups, policies, alerts, and sources
- getting cluster/protection-group details
- searching objects
- listing recoveries and audit logs
- read-only usage reports
- `api_request` with `method: "GET"` only

Read-only users cannot:

- run backups
- collect/store new usage snapshots
- call `api_request` with `POST`, `PUT`, `PATCH`, or `DELETE`
- send a request body with `api_request`
- call any hidden admin tool

If a tool is hidden or returns an error saying `admin-only` or `GET only`, that
is the gateway working correctly. Ask the gateway owner if you need different
access.

HPEGreenLake currently has no admin-only tools. All six GreenLake tools are
read-only, so read-only users see and can call all of them:

- `greenlake_connection_status`
- `greenlake_auth_status`
- `greenlake_list_storage_systems`
- `greenlake_capacity_summary`
- `greenlake_list_ports`
- `greenlake_port_summary`

Lansweeper also has no admin-only tools. All five Lansweeper tools are
read-only, so read-only users see and can call all of them:

- `lansweeper_connection_status`
- `lansweeper_auth_status`
- `lansweeper_discover_endpoints`
- `lansweeper_list_assets`
- `lansweeper_fetch_page`

vSphere also has no admin-only tools. All nine vSphere tools are read-only, so
read-only users see and can call all of them:

- `vsphere_connection_status`
- `vsphere_inventory_summary`
- `vsphere_list_vms`
- `vsphere_get_vm`
- `vsphere_list_hosts`
- `vsphere_list_clusters`
- `vsphere_list_datastores`
- `vsphere_list_networks`
- `vsphere_list_datacenters`
- `vsphere_list_tags`
- `vsphere_list_vm_tags`
- `vsphere_list_vm_details`

### Admin

The admin token has the full REST/tool command set, including mutating
operations. Admin access is limited to Ray Fung.

---

## 6. HTTPS option

HTTP `:8081` sends the gateway token in cleartext on the LAN. Use HTTPS when
your machine trusts the local Caddy CA.

If your client can trust the Caddy root certificate, replace the URL with:

```text
https://10.53.19.120:8088/cohesity/mcp
https://10.53.19.120:8088/hpegreenlake/mcp
https://10.53.19.120:8088/lansweeper/mcp
https://10.53.19.120:8088/vsphere/mcp
```

With `curl.exe`, you can test without installing the CA using:

```powershell
curl.exe --ssl-no-revoke ...
```

If you install the Caddy local root certificate, no `--ssl-no-revoke` flag is
needed.

---

## 7. Troubleshooting

| Symptom | Meaning / fix |
|---|---|
| `A gateway token is required` | The `X-Gateway-Token` header is missing. Check your MCP config. |
| Header contains an unexpanded placeholder | Your client sent literal `${COHESITY_GATEWAY_TOKEN}` or `{env:COHESITY_GATEWAY_TOKEN}`. Set the environment variable and restart the client/service. |
| HTTP 403 `This gateway token is not authorized` | The token is wrong, revoked, or not in the ACL. Ask the gateway owner to check. |
| Tool error says `admin-only` | Your token is read-only. This is expected unless you are the admin. |
| Tool error says `GET only` | `api_request` is restricted to GET for read-only users. |
| HTTP 400 about client-supplied keys | Remove GreenLake/HPE/Cohesity/Lansweeper/vSphere key headers. Send only `X-Gateway-Token`. |
| `Connection refused` | The gateway host or a bridge may be down. Check `/cohesity/health`, `/hpegreenlake/health`, `/lansweeper/health`, or `/vsphere/health`. |
| HTTPS certificate error | Use HTTP `:8081`, install the Caddy local root certificate, or use `--ssl-no-revoke` with curl.exe on Windows. |
| OpenCode does not see the token | Run `opencode service restart` after changing `COHESITY_GATEWAY_TOKEN`, or start OpenCode from a new terminal. |

---

## 8. Let your AI harness configure itself

There is now **one** prompt for all gateway MCP servers and for both new and returning users:

```text
C:\caddy-gateway\GATEWAY-ONE-PROMPT-WITH-TOKEN.md
```

- **Before pasting:** set your gateway token in your own environment, then paste
  the whole document into your harness. Do not paste the token into the chat.

  ```powershell
  $env:COHESITY_GATEWAY_TOKEN = '<token issued by gateway owner>'   # current session
  setx COHESITY_GATEWAY_TOKEN '<token issued by gateway owner>'      # persistent
  ```

- **New or returning user:** paste the entire document as-is. The top section is
  marked for the harness to ignore; the harness only checks whether the variable
  exists and never reads its value.
- The prompt reads the catalog at `http://10.53.19.120:8081/mcp/servers`, so it
  configures all current MCP servers and picks up new ones added later. You do
  not need to edit the prompt when another MCP server is published.

The harness should never ask you for the token. If it does, set
`COHESITY_GATEWAY_TOKEN` locally and paste the prompt again. Never paste the
token into a shared channel.
