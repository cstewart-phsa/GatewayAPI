r"""
HTTP bridge for the VMware vSphere/vCenter stdio MCP server.

The vCenter username/password is server-side only. It is stored in DPAPI-protected
files under C:\caddy-gateway\secrets and decrypted by a restricted PowerShell
helper that is spawned by the short-lived Node stdio process. The bridge itself
never receives the raw password and never accepts it from a client.

Clients authenticate with the same per-user gateway token used by Cohesity,
HPEGreenLake, Lansweeper, and the other gateway MCP servers:

    X-Gateway-Token: <token issued to that user>

The bridge maps the token SHA-256 fingerprint to a name and role in the shared
named-user ACL (C:\caddy-gateway\secrets\cohesity-gateway-acl.json). Unknown or
missing tokens are denied. All current vSphere tools are read-only.

Each MCP request starts a short-lived Node stdio process. Stateless mode is
deliberate: the vCenter session lives entirely inside one HTTP request.

The bridge listens on 127.0.0.1 only; Caddy exposes it through /vsphere/*.
"""

from __future__ import annotations

import contextvars
import hashlib
import json
import os
import re
import shutil
import sys
import time
from contextlib import AsyncExitStack, asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, AsyncIterator

import uvicorn
from mcp import types
from mcp.client.session import ClientSession
from mcp.client.stdio import StdioServerParameters, stdio_client
from mcp.server.lowlevel.server import Server
from mcp.server.streamable_http_manager import StreamableHTTPSessionManager
from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.responses import JSONResponse
from starlette.routing import Route

HERE = Path(__file__).resolve().parent
UPSTREAM_SCRIPT = HERE / "server.mjs"
SECRETS_DIR = HERE.parent / "secrets"
DEFAULT_ACL_PATH = SECRETS_DIR / "cohesity-gateway-acl.json"
ACL_PATH = Path(os.environ.get("VSPHERE_GATEWAY_ACL", str(DEFAULT_ACL_PATH)))
NODE = os.environ.get("VSPHERE_NODE") or shutil.which("node") or "node"

CREDENTIAL_FILE = Path(
    os.environ.get("VSPHERE_CREDENTIAL_FILE", str(SECRETS_DIR / "vsphere.xml"))
)
SERVER_FILE = Path(
    os.environ.get("VSPHERE_SERVER_FILE", str(SECRETS_DIR / "vsphere-server.txt"))
)

for _path in (CREDENTIAL_FILE, SERVER_FILE):
    if not _path.is_file():
        raise RuntimeError(
            f"Missing protected vSphere credential file: {_path}. "
            "Run Initialize-VsphereSharedKey.ps1 or "
            "Set-VsphereGatewayCredential.ps1, then Start-VsphereBridge.ps1."
        )

# Fingerprint the DPAPI-protected files, not the password. This changes when the
# domain credential is rotated but never exposes the username or password.
CREDENTIAL_FP = hashlib.sha256(
    CREDENTIAL_FILE.read_bytes() + b"\0" + SERVER_FILE.read_bytes()
).hexdigest()[:12]

USER_VAR: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "gateway_user", default=None
)
ROLE_VAR: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "gateway_role", default=None
)
TOKEN_FP_VAR: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "gateway_token_fingerprint", default=None
)
CLIENT_IP_VAR: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "client_ip", default=None
)

USAGE_LOG = Path(os.environ.get("VSPHERE_USAGE_LOG", str(HERE / "usage.jsonl")))

_acl_cache: tuple[int, dict[str, tuple[str, str]]] | None = None

ADMIN_ROLE = "admin"
READ_ONLY_ROLE = "read-only"

# Every current vSphere tool is read-only. There are no admin-only vSphere
# tools today. If a mutating tool is added upstream it stays hidden and denied
# until it is explicitly placed in this allowlist.
ADMIN_ONLY_TOOLS: set[str] = set()
READ_ONLY_TOOLS = {
    "vsphere_connection_status",
    "vsphere_inventory_summary",
    "vsphere_list_vms",
    "vsphere_get_vm",
    "vsphere_list_hosts",
    "vsphere_list_clusters",
    "vsphere_list_datastores",
    "vsphere_list_networks",
    "vsphere_list_datacenters",
    "vsphere_list_tags",
    "vsphere_list_vm_tags",
    "vsphere_list_vm_details",
}

PLACEHOLDER_PREFIXES = ("${", "{env:")


def sha256_hex(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def token_fingerprint(token: str) -> str:
    return sha256_hex(token)


def short_fingerprint(fingerprint: str | None) -> str | None:
    return fingerprint[:12] if fingerprint else None


def load_acl() -> dict[str, tuple[str, str]]:
    """Return {token_sha256: (user name, role)}, reloading when the file changes."""
    global _acl_cache
    try:
        stat = ACL_PATH.stat()
    except FileNotFoundError:
        return {}

    mtime = stat.st_mtime_ns
    if _acl_cache is not None and _acl_cache[0] == mtime:
        return _acl_cache[1]

    mapping: dict[str, tuple[str, str]] = {}
    try:
        data = json.loads(ACL_PATH.read_text(encoding="utf-8-sig"))
        for entry in data.get("users", []):
            name = str(entry.get("name", "")).strip()
            fingerprint = str(entry.get("token_fp", "")).strip().lower()
            role = str(entry.get("role", READ_ONLY_ROLE)).strip().lower()
            if role not in {ADMIN_ROLE, READ_ONLY_ROLE}:
                role = READ_ONLY_ROLE  # fail closed on unknown roles
            if name and len(fingerprint) >= 12:
                mapping[fingerprint] = (name, role)
    except Exception as exc:
        print(f"Cannot read gateway ACL {ACL_PATH}: {safe_error(exc)}", file=sys.stderr)

    _acl_cache = (mtime, mapping)
    return mapping


def write_usage(event: str, **fields: Any) -> None:
    token_fp = TOKEN_FP_VAR.get()
    entry = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "server": "vsphere",
        "event": event,
        "user": USER_VAR.get() or "unauthenticated",
        "role": ROLE_VAR.get() or "none",
        "key_fp": CREDENTIAL_FP,
        "token_fp": short_fingerprint(token_fp),
        "client_ip": CLIENT_IP_VAR.get(),
        **fields,
    }
    USAGE_LOG.parent.mkdir(parents=True, exist_ok=True)
    with USAGE_LOG.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(entry, separators=(",", ":")) + "\n")


def safe_error(error: Exception) -> str:
    text = str(error)
    text = re.sub(r"Bearer\s+\S+", "Bearer [REDACTED]", text, flags=re.IGNORECASE)
    text = re.sub(r"(?i)(password|passwd|pwd)\s*[:=]\s*\S+", r"\1=[REDACTED]", text)
    return text[:300]


def _decode(value: bytes | str) -> str:
    return value.decode("latin-1") if isinstance(value, bytes) else value


def extract_gateway_token(headers: dict[bytes, bytes]) -> str | None:
    value = headers.get(b"x-gateway-token")
    if not value:
        return None
    token = _decode(value).strip()
    return token or None


def extract_client_credential(headers: dict[bytes, bytes]) -> str | None:
    """Detect client-supplied upstream credentials so they can be rejected."""
    for name in (
        b"x-vsphere-username",
        b"x-vsphere-password",
        b"x-vsphere-api-key",
        b"x-vcenter-username",
        b"x-vcenter-password",
        b"x-vcenter-api-key",
        b"x-api-key",
        b"x-client-secret",
        b"x-cohesity-api-key",
        b"x-helios-api-key",
        b"x-hpegreenlake-api-key",
        b"x-greenlake-api-key",
        b"x-hpe-api-key",
        b"x-lansweeper-api-key",
        b"x-lansweeper-key",
        b"x-lansweeper-username",
        b"x-lansweeper-password",
    ):
        value = headers.get(name)
        if value and _decode(value).strip():
            return _decode(value).strip()

    auth = headers.get(b"authorization")
    if auth:
        parts = _decode(auth).strip().split(None, 1)
        if len(parts) == 2 and parts[0].lower() in {"bearer", "apikey", "token", "basic"}:
            return parts[1].strip()
    return None


class RequireGatewayTokenMiddleware:
    """Authenticate the caller with the shared gateway token, never with vCenter keys."""

    def __init__(self, app: Any):
        self.app = app

    async def __call__(self, scope: dict[str, Any], receive: Any, send: Any) -> None:
        if scope.get("type") != "http" or scope.get("path") == "/health":
            await self.app(scope, receive, send)
            return

        headers = dict(scope.get("headers", []))
        token = extract_gateway_token(headers)
        fingerprint = token_fingerprint(token) if token else None
        client = scope.get("client")
        client_ip = client[0] if client else None

        ip_token = CLIENT_IP_VAR.set(client_ip)
        fp_token = TOKEN_FP_VAR.set(fingerprint)
        user_token = USER_VAR.set(None)
        role_token = ROLE_VAR.set(None)

        async def deny(status: int, message: str, event: str, reason: str) -> None:
            write_usage(event, reason=reason, http_status=status)
            response = JSONResponse({"error": message}, status_code=status)
            await response(scope, receive, send)

        try:
            if extract_client_credential(headers):
                await deny(
                    400,
                    "Client-supplied vSphere credentials are not accepted. "
                    "Use X-Gateway-Token; the vCenter credential is configured "
                    "on the server.",
                    "auth_rejected",
                    "legacy_api_key_header",
                )
                return

            if not token:
                await deny(
                    401,
                    "A gateway token is required. Send X-Gateway-Token: <token>.",
                    "auth_denied",
                    "missing_token",
                )
                return

            if token.startswith(PLACEHOLDER_PREFIXES):
                await deny(
                    401,
                    "The X-Gateway-Token header contains an unexpanded placeholder. "
                    "Use {env:COHESITY_GATEWAY_TOKEN} in OpenCode, or set the token "
                    "in the client environment and restart the client.",
                    "auth_denied",
                    "placeholder_token",
                )
                return

            acl_entry = load_acl().get(fingerprint or "")
            if not acl_entry:
                await deny(
                    403,
                    "This gateway token is not authorized for vSphere MCP.",
                    "auth_denied",
                    "unknown_token",
                )
                return

            user, role = acl_entry
            auth_user_token = USER_VAR.set(user)
            auth_role_token = ROLE_VAR.set(role)
            try:
                await self.app(scope, receive, send)
            finally:
                USER_VAR.reset(auth_user_token)
                ROLE_VAR.reset(auth_role_token)
        finally:
            ROLE_VAR.reset(role_token)
            USER_VAR.reset(user_token)
            TOKEN_FP_VAR.reset(fp_token)
            CLIENT_IP_VAR.reset(ip_token)


@asynccontextmanager
async def upstream_session() -> AsyncIterator[ClientSession]:
    env = os.environ.copy()
    env["VSPHERE_BRIDGE"] = "true"
    params = StdioServerParameters(
        command=NODE,
        args=[str(UPSTREAM_SCRIPT)],
        cwd=str(HERE),
        env=env,
    )
    async with AsyncExitStack() as stack:
        read_stream, write_stream = await stack.enter_async_context(
            stdio_client(params, errlog=sys.stderr)
        )
        session = await stack.enter_async_context(
            ClientSession(read_stream, write_stream)
        )
        await session.initialize()
        yield session


def role_is_admin() -> bool:
    return ROLE_VAR.get() == ADMIN_ROLE


def clone_tool(tool: types.Tool, **updates: Any) -> types.Tool:
    if hasattr(tool, "model_copy"):
        return tool.model_copy(deep=True, update=updates)
    copied = tool.copy(deep=True)
    return copied.copy(update=updates)


def forbidden_call_reason(name: str, arguments: dict[str, Any]) -> str | None:
    if role_is_admin():
        return None
    if name in ADMIN_ONLY_TOOLS:
        return "This tool is admin-only and is not available to your account."
    if name not in READ_ONLY_TOOLS:
        return "This tool is not available to read-only users."
    return None


def denied_tool_result(message: str) -> types.CallToolResult:
    return types.CallToolResult(
        content=[types.TextContent(type="text", text=message)],
        isError=True,
    )


mcp_server = Server("vsphere-http-bridge", version="1.0.0")


@mcp_server.list_tools()
async def list_tools() -> types.ListToolsResult:
    started = time.monotonic()
    try:
        async with upstream_session() as session:
            result = await session.list_tools()
            tools = list(result.tools)

        if not role_is_admin():
            visible = []
            for tool in tools:
                if tool.name not in READ_ONLY_TOOLS:
                    continue
                annotations = getattr(tool, "annotations", None)
                if annotations is None or getattr(annotations, "readOnlyHint", None) is not True:
                    annotation_data: dict[str, Any] = {}
                    if annotations is not None and hasattr(annotations, "model_dump"):
                        annotation_data = annotations.model_dump()
                    annotation_data.update(
                        readOnlyHint=True,
                        destructiveHint=False,
                        idempotentHint=True,
                        openWorldHint=False,
                    )
                    tool = clone_tool(
                        tool,
                        annotations=types.ToolAnnotations(**annotation_data),
                        description=(
                            str(getattr(tool, "description", "") or "")
                            + " (Gateway-enforced read-only tool.)"
                        ).strip(),
                    )
                visible.append(tool)
            tools = visible

        write_usage(
            "tools/list",
            ok=True,
            tool_count=len(tools),
            duration_ms=round((time.monotonic() - started) * 1000, 1),
        )
        return types.ListToolsResult(tools=tools)
    except Exception as exc:
        write_usage(
            "tools/list",
            ok=False,
            error=safe_error(exc),
            duration_ms=round((time.monotonic() - started) * 1000, 1),
        )
        raise


@mcp_server.call_tool(validate_input=False)
async def call_tool(name: str, arguments: dict[str, Any]) -> types.CallToolResult:
    args = arguments or {}
    reason = forbidden_call_reason(name, args)
    if reason:
        write_usage(
            "tool_denied",
            ok=False,
            tool=name,
            reason=reason,
        )
        return denied_tool_result(reason)

    started = time.monotonic()
    try:
        async with upstream_session() as session:
            result = await session.call_tool(name, args)
        write_usage(
            "tools/call",
            ok=not bool(result.isError),
            tool=name,
            duration_ms=round((time.monotonic() - started) * 1000, 1),
        )
        return result
    except Exception as exc:
        write_usage(
            "tools/call",
            ok=False,
            tool=name,
            error=safe_error(exc),
            duration_ms=round((time.monotonic() - started) * 1000, 1),
        )
        raise


session_manager = StreamableHTTPSessionManager(
    app=mcp_server,
    json_response=True,
    stateless=True,
)


class McpAsgiApp:
    def __init__(self, manager: StreamableHTTPSessionManager):
        self.manager = manager

    async def __call__(self, scope: dict[str, Any], receive: Any, send: Any) -> None:
        await self.manager.handle_request(scope, receive, send)


async def health(_request: Any) -> JSONResponse:
    return JSONResponse(
        {
            "ok": True,
            "server": "vsphere",
            "upstream": str(UPSTREAM_SCRIPT),
            "mode": "stateless",
            "auth": "gateway_token",
            "credential_store": "dpapi",
            "key_fp": CREDENTIAL_FP,
            "acl_users": len(load_acl()),
            "acl_file": str(ACL_PATH),
        }
    )


@asynccontextmanager
async def lifespan(_app: Starlette):
    async with session_manager.run():
        yield


app = Starlette(
    routes=[
        Route("/health", health, methods=["GET"]),
        Route("/mcp", McpAsgiApp(session_manager), methods=["GET", "POST", "DELETE"]),
    ],
    lifespan=lifespan,
    middleware=[Middleware(RequireGatewayTokenMiddleware)],
)


if __name__ == "__main__":
    host = os.environ.get("VSPHERE_BRIDGE_HOST", "127.0.0.1")
    port = int(os.environ.get("VSPHERE_BRIDGE_PORT", "8403"))
    uvicorn.run(app, host=host, port=port, log_level="info")
