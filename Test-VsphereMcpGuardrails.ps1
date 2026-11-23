<#
.SYNOPSIS
    Verify vSphere read-only guardrails on the gateway endpoint.

    Uses the same two gateway tokens as the Cohesity guardrail test. Values are
    never echoed.

.EXAMPLE
    $env:COHESITY_GATEWAY_ADMIN_TOKEN = '<ray.fung token>'
    $env:COHESITY_GATEWAY_READONLY_TOKEN = '<read-only user token>'
    .\Test-VsphereMcpGuardrails.ps1
#>
[CmdletBinding()]
param(
    [string]$BaseUrl = 'http://10.53.19.120:8081',
    [string]$AdminToken = $env:COHESITY_GATEWAY_ADMIN_TOKEN,
    [string]$ReadOnlyToken = $env:COHESITY_GATEWAY_READONLY_TOKEN,
    [switch]$AllowUntrustedCertificate
)

$ErrorActionPreference = 'Stop'
$BaseUrl = $BaseUrl.TrimEnd('/')
$script:Passed = 0
$script:Failed = 0

if (-not $AdminToken) { throw 'Set -AdminToken or $env:COHESITY_GATEWAY_ADMIN_TOKEN.' }
if (-not $ReadOnlyToken) { throw 'Set -ReadOnlyToken or $env:COHESITY_GATEWAY_READONLY_TOKEN.' }

if ($AllowUntrustedCertificate) {
    [System.Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }
}

$ExpectedTools = @(
    'vsphere_connection_status'
    'vsphere_inventory_summary'
    'vsphere_list_vms'
    'vsphere_get_vm'
    'vsphere_list_hosts'
    'vsphere_list_clusters'
    'vsphere_list_datastores'
    'vsphere_list_networks'
    'vsphere_list_datacenters'
    'vsphere_list_tags'
    'vsphere_list_vm_tags'
    'vsphere_list_vm_details'
)

function Invoke-Mcp {
    param(
        [Parameter(Mandatory)][string]$Token,
        [Parameter(Mandatory)][int]$Id,
        [Parameter(Mandatory)][string]$Method,
        [hashtable]$Params = @{},
        [hashtable]$ExtraHeaders = @{}
    )
    $payload = @{
        jsonrpc = '2.0'
        id      = $Id
        method  = $Method
        params  = $Params
    } | ConvertTo-Json -Depth 8 -Compress

    $headers = @{
        'X-Gateway-Token' = $Token
        'Accept'          = 'application/json, text/event-stream'
    }
    foreach ($key in $ExtraHeaders.Keys) {
        $headers[$key] = $ExtraHeaders[$key]
    }

    Invoke-RestMethod `
        -Uri "$BaseUrl/vsphere/mcp" `
        -Method Post `
        -Headers $headers `
        -ContentType 'application/json' `
        -Body $payload `
        -TimeoutSec 180
}

function Assert-Test {
    param(
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][bool]$Condition,
        [string]$Detail = ''
    )
    if ($Condition) {
        Write-Host ("  PASS  {0}" -f $Name) -ForegroundColor Green
        $script:Passed++
    } else {
        Write-Host ("  FAIL  {0} {1}" -f $Name, $Detail) -ForegroundColor Red
        $script:Failed++
    }
}

function Get-CallText {
    param($Result)
    return (@($Result.result.content | ForEach-Object { $_.text }) -join ' ')
}

Write-Host "vSphere MCP guardrail test - $BaseUrl"
Write-Host

$adminTools = $null
$roTools = $null

try {
    $adminTools = Invoke-Mcp -Token $AdminToken -Id 1 -Method 'tools/list'
    $names = @($adminTools.result.tools | ForEach-Object { $_.name })
    $missing = @($ExpectedTools | Where-Object { $_ -notin $names })
    Assert-Test 'Admin sees all vSphere tools' ($missing.Count -eq 0) "(missing: $($missing -join ','))"
} catch {
    Assert-Test 'Admin sees all vSphere tools' $false $_.Exception.Message
}

try {
    $roTools = Invoke-Mcp -Token $ReadOnlyToken -Id 2 -Method 'tools/list'
    $names = @($roTools.result.tools | ForEach-Object { $_.name })
    $unexpected = @($names | Where-Object { $_ -notin $ExpectedTools })
    Assert-Test 'Read-only sees only allowlisted tools' ($unexpected.Count -eq 0) "(unexpected: $($unexpected -join ','))"
} catch {
    Assert-Test 'Read-only sees only allowlisted tools' $false $_.Exception.Message
}

try {
    $bad = @($roTools.result.tools | Where-Object {
        ([bool]$_.annotations.readOnlyHint -ne $true) -or ([bool]$_.annotations.destructiveHint -ne $false)
    })
    Assert-Test 'Read-only tools are annotated read-only' ($bad.Count -eq 0) "(bad: $(@($bad | ForEach-Object { $_.name }) -join ','))"
} catch {
    Assert-Test 'Read-only tools are annotated read-only' $false $_.Exception.Message
}

try {
    $r = Invoke-Mcp -Token $ReadOnlyToken -Id 3 -Method 'tools/call' -Params @{
        name = 'not_a_real_tool'; arguments = @{}
    }
    $text = Get-CallText $r
    Assert-Test 'Read-only unknown tool is denied' ([bool]$r.result.isError -and $text -match 'not available') $text
} catch {
    Assert-Test 'Read-only unknown tool is denied' $false $_.Exception.Message
}

try {
    $r = Invoke-Mcp -Token $ReadOnlyToken -Id 4 -Method 'tools/call' -Params @{
        name = 'vsphere_connection_status'; arguments = @{}
    }
    $text = Get-CallText $r
    Assert-Test 'Read-only connection status is allowed' ((-not [bool]$r.result.isError) -and ($text -match 'version')) $text
} catch {
    Assert-Test 'Read-only connection status is allowed' $false $_.Exception.Message
}

try {
    Invoke-Mcp -Token $ReadOnlyToken -Id 5 -Method 'tools/list' -ExtraHeaders @{ 'X-Vsphere-Password' = 'client-supplied-value' } -ErrorAction Stop | Out-Null
    Assert-Test 'Client-supplied credential is rejected' $false '(request unexpectedly succeeded)'
} catch {
    $code = [int]$_.Exception.Response.StatusCode
    Assert-Test 'Client-supplied credential is rejected' ($code -eq 400) "(status $code)"
}

Write-Host
Write-Host ("Result: {0} passed, {1} failed" -f $script:Passed, $script:Failed) -ForegroundColor Cyan
if ($script:Failed -gt 0) { exit 1 }
