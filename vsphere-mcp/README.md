# vSphere MCP (gateway copy)

Read-only MCP server for VMware vCenter inventory and monitoring. It uses the
official vSphere REST API and exposes no mutating tools.

This copy is exposed through the Caddy gateway at `/vsphere/mcp`. See
`C:\caddy-gateway\VSPHERE-MCP.md` for gateway setup, token/ACL details, and
credential rotation.

## Credentials

On the gateway host, run `Set-VsphereGatewayCredential.ps1` from this folder to
set or rotate the server-side domain credential, or
`Initialize-VsphereSharedKey.ps1` to copy the existing DPAPI-protected
CStorageDashboard credential. The password is protected by Windows DPAPI for the
current Windows user. Credentials and vSphere session IDs are never returned by
MCP tools or browser APIs and are never accepted from MCP clients.

## Read-only tools

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

The server has no generic request tool and accepts no arbitrary API path, HTTP
method, or command. Upstream requests are fixed GETs, except for these fixed
POSTs that read data or manage only this server's own session (enforced by
allowlists in `src/vsphere-client.mjs`):

- REST session login (`/rest/com/vmware/cis/session`)
- Tag associations: `/api/cis/tagging/tag-association?action=list-attached-objects-on-tags`
- VI/JSON (`/sdk/vim25/<release>/...`, used by `vsphere_list_vm_details`):
  `Login`, `Logout`, `CreateContainerView`, `DestroyView`,
  `RetrievePropertiesEx`, `ContinueRetrievePropertiesEx`. The container view
  is scoped to the session and destroyed, and the session logged out, after
  every call.

### New tool notes

- `vsphere_list_vm_tags` with `without: true` lists VMs that have no matching
  tag, e.g. `{ "tag_prefix": "Bkp_", "without": true }` for VMs with no backup tag.
- `vsphere_list_vm_details` needs vCenter 8.0 U1 or later (VI/JSON API). Set
  `VSPHERE_VIM_RELEASE` to change the API release path (default `8.0.1.0`).
- `vsphere_list_vms` falls back to per-cluster and per-standalone-host listing
  when vCenter refuses the unfiltered list (more than 4,000 VMs).
- Tag and VI/JSON reads need the service account to have read access to tags
  and inventory at each vCenter's root (Read-only role, propagated).

## Start and test

`npm run check`

`npm run smoke`

`node server.mjs`

If vCenter uses a private CA that Node does not trust, set `VSPHERE_CA_FILE` to a
PEM certificate chain on the backend host. Do not disable TLS verification.
