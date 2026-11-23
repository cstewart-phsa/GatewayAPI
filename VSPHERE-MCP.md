# VMware vSphere/vCenter MCP through the Caddy gateway

The read-only vSphere MCP from `C:\Code\CStorageDashboard\mcp-configs\vsphere`
has been copied to `C:\caddy-gateway\vsphere-mcp` and exposed through a local
HTTP bridge on `127.0.0.1:8403`. Caddy proxies `/vsphere/*` to that bridge on
both gateway listeners.

This server uses the **same gateway token and named-user ACL as Cohesity,
HPEGreenLake, and Lansweeper**. A user who can call `/cohesity/mcp` can also
call `/vsphere/mcp` with the same `X-Gateway-Token` header and the same
`admin`/`read-only` role. The DPAPI-backed credential-store pattern described
below is now shared by all four MCPs; each has its own protected record and
restricted local decryption helper.

vCenter does not provide a general-purpose API key/PAT for this REST API. The
MCP authenticates with a domain username/password, obtains a short-lived vCenter
session ID, and uses that session only inside the gateway process. The domain
credential is stored server-side in DPAPI-protected files and is never accepted
from clients.

```
MCP client (X-Gateway-Token only)
        |
        v
Caddy :8081 / :8088  /vsphere/mcp
        |
        v
vSphere HTTP bridge 127.0.0.1:8403
   - validates token against the shared ACL
   - spawns a short-lived Node stdio process per request
        |
        v
Node process + restricted PowerShell helper
   - decrypts DPAPI credential on the gateway host
        |
        v
vCenter REST API (session login + read-only GETs)
```

## Gateway URLs

| Use | URL |
|---|---|
| HTTP (no cert/admin needed) | `http://10.53.19.120:8081/vsphere/mcp` |
| HTTPS (local Caddy CA) | `https://10.53.19.120:8088/vsphere/mcp` |
| Bridge health (no auth) | `http://10.53.19.120:8081/vsphere/health` |

Header on **every** MCP request (initialize, tools/list, tools/call):

```text
X-Gateway-Token: <your existing gateway token>
```

Do **not** send `X-Vsphere-Username`, `X-Vsphere-Password`,
`X-Vsphere-Api-Key`, `X-VCenter-Username`, `X-VCenter-Password`, `X-Api-Key`,
`X-Client-Secret`, `Authorization: Bearer`, or any other upstream credential
header. The bridge rejects client-supplied upstream credentials with HTTP 400.

---

## 1. Gateway owner: configure the domain user/pass locally

There are two ways to populate the server-only credential. Both keep the
password out of chat, prompts, client configs, Caddy, and the copied MCP folder.

### Option A — reuse the credential already configured for CStorageDashboard

This was used for the initial build. The existing DPAPI-protected files were
copied from:

```text
C:\Code\CStorageDashboard\credentials\vsphere.xml
C:\Code\CStorageDashboard\credentials\vsphere-server.txt
```

into:

```text
C:\caddy-gateway\secrets\vsphere.xml
C:\caddy-gateway\secrets\vsphere-server.txt
```

To refresh the copy after the source credential changes:

```powershell
C:\caddy-gateway\vsphere-mcp\Initialize-VsphereSharedKey.ps1 -Force
C:\caddy-gateway\vsphere-mcp\Stop-VsphereBridge.ps1
C:\caddy-gateway\vsphere-mcp\Start-VsphereBridge.ps1
```

### Option B — enter/rotate the domain credential directly

Run this **on the gateway host**, as the same Windows account that starts the
bridge:

```powershell
C:\caddy-gateway\vsphere-mcp\Set-VsphereGatewayCredential.ps1
```

The script prompts for the username and a masked password. It writes only a
DPAPI-protected `vsphere.xml` and the server list to
`C:\caddy-gateway\secrets`, restricted to the current user, SYSTEM, and
Administrators.

If the password was ever pasted into chat, shown in a terminal transcript, or
stored in a ticket, rotate it in Active Directory and rerun this script. Do not
paste the new value anywhere.

> DPAPI is tied to the Windows account that created the file. Run the setup
> script and `Start-VsphereBridge.ps1` under the same account. Do not start the
> bridge as SYSTEM or a different service account unless you recreate the
> protected credential under that account.

Optional: if vCenter uses a private CA that Node does not trust, place the CA
certificate at:

```text
C:\caddy-gateway\secrets\vsphere-ca.pem
```

`Start-VsphereBridge.ps1` sets `VSPHERE_CA_FILE` automatically when that file is
present.

---

## 2. Gateway owner: tokens and roles

No second token list is needed. vSphere reads the existing ACL:

```text
C:\caddy-gateway\secrets\cohesity-gateway-acl.json
```

Manage users with the existing scripts:

```powershell
C:\caddy-gateway\cohesity-mcp\Get-CohesityGatewayAcl.ps1
C:\caddy-gateway\cohesity-mcp\New-CohesityGatewayToken.ps1 -Name 'alice@example.com' -Role read-only
C:\caddy-gateway\cohesity-mcp\Set-CohesityGatewayRole.ps1 -Name 'alice@example.com' -Role admin
C:\caddy-gateway\cohesity-mcp\Remove-CohesityGatewayToken.ps1 -Name 'alice@example.com'
```

ACL changes take effect on the next request; no bridge restart is needed.

### Read-only guardrails

All current vSphere tools are read-only:

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

Read-only users see and can call all of them. There are no admin-only vSphere
tools today. If a future upstream tool is mutating, it remains hidden from
`tools/list` and denied by `tools/call` until it is added to the explicit
read-only allowlist in `http_bridge.py`.

The bridge enforces `readOnlyHint: true` and `destructiveHint: false` on every
tool it advertises to read-only users. The source MCP has no generic request
tool and accepts no arbitrary API path or HTTP method. Its only upstream POSTs
are session login/logout and a fixed allowlist of read-only calls (tag
associations and VI/JSON property retrieval); see `vsphere-mcp/README.md`.

---

## 3. Gateway owner: start the bridge

```powershell
C:\caddy-gateway\vsphere-mcp\Start-VsphereBridge.ps1
```

Expected:

```text
vSphere MCP bridge started on http://127.0.0.1:8403/mcp (PID 1234).
Auth: shared gateway-token ACL; ACL users: 15
Credential: DPAPI-protected files in C:\caddy-gateway\secrets (values not loaded into the bridge).
Logs: C:\caddy-gateway\vsphere-mcp\bridge.log
Errors: C:\caddy-gateway\vsphere-mcp\bridge.err.log
```

Stop it with:

```powershell
C:\caddy-gateway\vsphere-mcp\Stop-VsphereBridge.ps1
```

Caddy is already reloaded with the `/vsphere/*` route. If you rebuild the
Caddyfile:

```powershell
caddy validate --config C:\caddy-gateway\Caddyfile
caddy reload --config C:\caddy-gateway\Caddyfile
```

---

## 4. Each user: configure your MCP client

Reuse the same `COHESITY_GATEWAY_TOKEN` environment variable and add a
`vsphere` server entry. Keep existing `cohesity`, `hpegreenlake`, and
`lansweeper` entries.

The consolidated prompt in
**[GATEWAY-ONE-PROMPT-WITH-TOKEN.md](GATEWAY-ONE-PROMPT-WITH-TOKEN.md)** does
this automatically by reading `/mcp/servers`. It assumes the user has already
set `COHESITY_GATEWAY_TOKEN` locally and never handles the token value itself.

### OpenCode 2.x

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "vsphere": {
        "type": "remote",
        "url": "http://10.53.19.120:8081/vsphere/mcp",
        "oauth": false,
        "headers": { "X-Gateway-Token": "{env:COHESITY_GATEWAY_TOKEN}" }
      }
    }
  }
}
```

After changing the token or config, run:

```powershell
opencode service restart
```

### OpenCode 1.x

```json
{
  "mcp": {
    "vsphere": {
      "type": "remote",
      "url": "http://10.53.19.120:8081/vsphere/mcp",
      "enabled": true,
      "headers": { "X-Gateway-Token": "{env:COHESITY_GATEWAY_TOKEN}" }
    }
  }
}
```

### Claude Code / Claude Desktop

```json
{
  "mcpServers": {
    "vsphere": {
      "type": "http",
      "url": "http://10.53.19.120:8081/vsphere/mcp",
      "headers": { "X-Gateway-Token": "${COHESITY_GATEWAY_TOKEN}" }
    }
  }
}
```

Use HTTPS URLs instead if your client trusts the Caddy local CA.

---

## 5. Tool behavior

| Tool | What it does |
|---|---|
| `vsphere_connection_status` | Logs in to every configured vCenter and returns per-vCenter product versions plus a combined online count. |
| `vsphere_inventory_summary` | Returns combined and per-vCenter counts for VMs, hosts, clusters, datastores, networks, and datacenters. |
| `vsphere_list_vms` | Lists virtual machines from all configured vCenters; each result includes its `vCenter`. |
| `vsphere_get_vm` | Returns one VM by managed-object id (`vm-123`), exact inventory name, short name, or FQDN. It searches all configured vCenters and reports which vCenter owns the VM. |
| `vsphere_list_hosts` | Lists ESXi hosts from all configured vCenters. |
| `vsphere_list_clusters` | Lists clusters from all configured vCenters. |
| `vsphere_list_datastores` | Lists datastores from all configured vCenters. |
| `vsphere_list_networks` | Lists networks from all configured vCenters. |
| `vsphere_list_datacenters` | Lists datacenter objects from all configured vCenters. |

All vSphere tools query every URL in `C:\caddy-gateway\secrets\vsphere-server.txt` by default. A vCenter that is temporarily unreachable is reported in `failures` rather than aborting the whole query.

Each gateway request starts a short-lived Node stdio process. The vCenter
session lives only inside that request; no session ID, username, or password is
returned to the client.

---

## 6. Test the endpoint

Set the token for the current session:

```powershell
$env:COHESITY_GATEWAY_TOKEN = '<your gateway token>'
```

Then run:

```powershell
C:\caddy-gateway\Test-VsphereMcp.ps1
C:\caddy-gateway\Test-VsphereMcp-Curl.ps1
```

Expected: 6 passed / 0 failed and 7 passed / 0 failed.

Guardrail verification (uses one admin and one read-only token):

```powershell
$env:COHESITY_GATEWAY_ADMIN_TOKEN = '<ray.fung token>'
$env:COHESITY_GATEWAY_READONLY_TOKEN = '<a read-only user token>'
C:\caddy-gateway\Test-VsphereMcpGuardrails.ps1
```

Expected: 6 passed / 0 failed.

HTTPS variants:

```powershell
C:\caddy-gateway\Test-VsphereMcp-Curl.ps1 -BaseUrl https://10.53.19.120:8088 -CurlArgs '--ssl-no-revoke'
C:\caddy-gateway\Test-VsphereMcp.ps1 -BaseUrl https://10.53.19.120:8088 -AllowUntrustedCertificate
```

One-line raw check:

```powershell
curl.exe -sS -H "X-Gateway-Token: $env:COHESITY_GATEWAY_TOKEN" -H "Accept: application/json, text/event-stream" -H "Content-Type: application/json" --data-binary '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' http://10.53.19.120:8081/vsphere/mcp
```

---

## 7. Monitoring usage

Neither log contains the domain password, the DPAPI file contents, or a raw
gateway token.

- Caddy access log: `C:\caddy-gateway\logs\access.log`
- vSphere MCP usage log: `C:\caddy-gateway\vsphere-mcp\usage.jsonl`

```powershell
C:\caddy-gateway\Get-VsphereMcpUsage.ps1
C:\caddy-gateway\Get-VsphereMcpUsage.ps1 -SinceHours 168 -Top 50
```

Entries include `server`, `user`, `role`, `token_fp`, `client_ip`, `event`,
`tool`, and a non-reversible `key_fp` fingerprint of the protected credential
files.

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| HTTP 401 `A gateway token is required` | Client is not sending `X-Gateway-Token`. |
| HTTP 401 unexpanded placeholder | Restart the client after setting `COHESITY_GATEWAY_TOKEN`. |
| HTTP 403 `not authorized for vSphere MCP` | Token is missing from the shared ACL or was rotated. |
| HTTP 400 about client-supplied credentials | Remove vSphere/vCenter/Cohesity/HPE/Lansweeper key headers; send only `X-Gateway-Token`. |
| Tool says `not available to read-only users` | The tool is not on the explicit allowlist. Ask the gateway owner. |
| Tool says `No vSphere VM found for ...` or `Multiple vSphere VMs match ...` | Use `vsphere_list_vms` to get the exact VM id (`vm-123`) and call `vsphere_get_vm` with that id. |
| Tool says `vSphere API returned HTTP 404 ...` | The requested VM id no longer exists. Re-run `vsphere_list_vms` and use a current id or name. |
| Tool says `unhandled errors in a TaskGroup` | The client is using an older bridge build. Reload the client/bridge; array results are now wrapped as objects. |
| Tool result says login failed or HTTP 401 from vCenter | Update the domain credential with `Set-VsphereGatewayCredential.ps1` and restart the bridge. |
| `The protected vSphere credential record could not be loaded` | Run setup as the same Windows user, or recreate the DPAPI record. |
| TLS/self-signed certificate error from vCenter | Place the internal CA PEM at `C:\caddy-gateway\secrets\vsphere-ca.pem` and restart the bridge. |
| `Connection refused` on `127.0.0.1:8403` | Run `Start-VsphereBridge.ps1`. |
| Gateway returns the generic Caddy message | Reload Caddy with the `/vsphere/*` route. |

**Security note:** HTTP `:8081` sends the gateway token in cleartext on the LAN.
Use HTTPS `:8088` wherever the client can trust the Caddy local CA.
