<#
.SYNOPSIS
    End-to-end test for the VMware vSphere MCP route through the Caddy gateway.

    The same per-user gateway token used for Cohesity is reused here. Keep it in
    $env:COHESITY_GATEWAY_TOKEN. The script never echoes or writes the token.

.EXAMPLE
    $env:COHESITY_GATEWAY_TOKEN = '<token issued to you>'
    .\Test-VsphereMcp.ps1

.EXAMPLE
    $env:COHESITY_GATEWAY_TOKEN = '<token issued to you>'
    .\Test-VsphereMcp.ps1 -BaseUrl https://10.53.19.120:8088 -AllowUntrustedCertificate
#>
[CmdletBinding()]
param(
    [string]$BaseUrl = 'http://10.53.19.120:8081',
    [switch]$AllowUntrustedCertificate
)

$ErrorActionPreference = 'Stop'
$BaseUrl = $BaseUrl.TrimEnd('/')
$script:Passed = 0
$script:Failed = 0

if (-not $env:COHESITY_GATEWAY_TOKEN) {
    throw 'Set $env:COHESITY_GATEWAY_TOKEN to your gateway token before running this test.'
}

if ($AllowUntrustedCertificate) {
    [System.Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }
}

function Invoke-McpJsonRpc {
    param(
        [Parameter(Mandatory)][int]$Id,
        [Parameter(Mandatory)][string]$Method,
        [hashtable]$Params = @{},
        [string]$Token = $env:COHESITY_GATEWAY_TOKEN
    )
    $payload = @{
        jsonrpc = '2.0'
        id      = $Id
        method  = $Method
        params  = $Params
    } | ConvertTo-Json -Depth 8 -Compress

    Invoke-RestMethod `
        -Uri "$BaseUrl/vsphere/mcp" `
        -Method Post `
        -Headers @{
            'X-Gateway-Token' = $Token
            'Accept'          = 'application/json, text/event-stream'
        } `
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

Write-Host "vSphere MCP gateway test - $BaseUrl"
Write-Host

try {
    if ($BaseUrl -like 'https:*') {
        # PowerShell 5.1 can fail the first HTTPS GET against the local-CA
        # listener even with the validation callback set. curl.exe is reliable
        # here; no token or credential is involved in a health request.
        $healthTmp = [IO.Path]::GetTempFileName()
        try {
            $code = ((& curl.exe -sS -o $healthTmp -w '%{http_code}' --max-time 15 --ssl-no-revoke "$BaseUrl/vsphere/health") | Out-String).Trim()
            $health = Get-Content -LiteralPath $healthTmp -Raw | ConvertFrom-Json
            Assert-Test 'Bridge health endpoint' (([int]$code -eq 200) -and $health.ok -eq $true -and $health.auth -eq 'gateway_token' -and $health.server -eq 'vsphere') "(status $code)"
        } finally {
            Remove-Item -LiteralPath $healthTmp -Force -ErrorAction SilentlyContinue
        }
    } else {
        $health = Invoke-RestMethod -Uri "$BaseUrl/vsphere/health" -TimeoutSec 15
        Assert-Test 'Bridge health endpoint' ($health.ok -eq $true -and $health.auth -eq 'gateway_token' -and $health.server -eq 'vsphere')
    }
} catch {
    Assert-Test 'Bridge health endpoint' $false $_.Exception.Message
}

try {
    $init = Invoke-McpJsonRpc -Id 1 -Method 'initialize' -Params @{
        protocolVersion = '2025-06-18'
        capabilities    = @{}
        clientInfo      = @{ name = 'caddy-gateway-test'; version = '2.0' }
    }
    Assert-Test 'MCP initialize' ($init.result.serverInfo.name -eq 'vsphere-http-bridge')
} catch {
    Assert-Test 'MCP initialize' $false $_.Exception.Message
}

try {
    $tools = Invoke-McpJsonRpc -Id 2 -Method 'tools/list'
    $count = @($tools.result.tools).Count
    Assert-Test 'MCP tools/list' ($count -eq 12) "(returned $count tools)"
} catch {
    Assert-Test 'MCP tools/list' $false $_.Exception.Message
}

try {
    $call = Invoke-McpJsonRpc -Id 3 -Method 'tools/call' -Params @{
        name      = 'vsphere_connection_status'
        arguments = @{}
    }
    $text = Get-CallText $call
    Assert-Test 'MCP tools/call vsphere_connection_status' ((-not [bool]$call.result.isError) -and ($text -match 'version')) $text
} catch {
    Assert-Test 'MCP tools/call vsphere_connection_status' $false $_.Exception.Message
}

try {
    $call = Invoke-McpJsonRpc -Id 4 -Method 'tools/call' -Params @{
        name      = 'vsphere_list_vms'
        arguments = @{}
    }
    $script:VmList = @($call.result.structuredContent.result)
    $count = $script:VmList.Count
    Assert-Test 'MCP tools/call vsphere_list_vms' ((-not [bool]$call.result.isError) -and ($count -gt 0)) "VM count: $count"
} catch {
    Assert-Test 'MCP tools/call vsphere_list_vms' $false $_.Exception.Message
}

try {
    $vCenterCount = @($script:VmList | ForEach-Object { $_.vCenter } | Where-Object { $_ } | Select-Object -Unique).Count
    Assert-Test 'List tools search all configured vCenters' ($vCenterCount -gt 1) "vCenters: $vCenterCount"
} catch {
    Assert-Test 'List tools search all configured vCenters' $false $_.Exception.Message
}

try {
    $sampleVm = $script:VmList | Where-Object { $_.name -and $_.vm } | Select-Object -First 1
    if (-not $sampleVm) { throw 'No VM available for lookup test' }
    $call = Invoke-McpJsonRpc -Id 5 -Method 'tools/call' -Params @{
        name      = 'vsphere_get_vm'
        arguments = @{ vm = [string]$sampleVm.name }
    }
    $returnedName = [string]$call.result.structuredContent.name
    Assert-Test 'MCP tools/call vsphere_get_vm by name' ((-not [bool]$call.result.isError) -and ($returnedName -ieq $sampleVm.name)) "name=$returnedName"
} catch {
    Assert-Test 'MCP tools/call vsphere_get_vm by name' $false $_.Exception.Message
}

try {
    $call = Invoke-McpJsonRpc -Id 6 -Method 'tools/call' -Params @{
        name      = 'vsphere_get_vm'
        arguments = @{ vm = 'definitely-not-a-vm-xyz' }
    }
    $text = Get-CallText $call
    Assert-Test 'Unknown VM name gives a clear error' ([bool]$call.result.isError -and ($text -match 'No vSphere VM found')) $text
} catch {
    Assert-Test 'Unknown VM name gives a clear error' $false $_.Exception.Message
}

$arrayTools = @(
    'vsphere_list_hosts'
    'vsphere_list_clusters'
    'vsphere_list_datastores'
    'vsphere_list_networks'
    'vsphere_list_datacenters'
)
$arrayToolId = 7
foreach ($toolName in $arrayTools) {
    try {
        $call = Invoke-McpJsonRpc -Id $arrayToolId -Method 'tools/call' -Params @{
            name      = $toolName
            arguments = @{}
        }
        $count = @($call.result.structuredContent.result).Count
        Assert-Test "MCP tools/call $toolName" ((-not [bool]$call.result.isError) -and ($count -gt 0)) "item count: $count"
    } catch {
        Assert-Test "MCP tools/call $toolName" $false $_.Exception.Message
    }
    $arrayToolId++
}

try {
    $call = Invoke-McpJsonRpc -Id 20 -Method 'tools/call' -Params @{
        name      = 'vsphere_list_tags'
        arguments = @{}
    }
    $count = [int]$call.result.structuredContent.count
    Assert-Test 'MCP tools/call vsphere_list_tags' ((-not [bool]$call.result.isError) -and ($count -gt 0)) "tag count: $count"
} catch {
    Assert-Test 'MCP tools/call vsphere_list_tags' $false $_.Exception.Message
}

try {
    $call = Invoke-McpJsonRpc -Id 21 -Method 'tools/call' -Params @{
        name      = 'vsphere_list_vm_tags'
        arguments = @{ limit = 5 }
    }
    $sc = $call.result.structuredContent
    $ok = (-not [bool]$call.result.isError) -and ([int]$sc.totalVms -gt 0) -and (@($sc.vms).Count -le 5)
    Assert-Test 'MCP tools/call vsphere_list_vm_tags' $ok "totalVms: $($sc.totalVms), returned: $(@($sc.vms).Count)"
} catch {
    Assert-Test 'MCP tools/call vsphere_list_vm_tags' $false $_.Exception.Message
}

try {
    $call = Invoke-McpJsonRpc -Id 22 -Method 'tools/call' -Params @{
        name      = 'vsphere_list_vm_details'
        arguments = @{ limit = 5 }
    }
    $sc = $call.result.structuredContent
    $first = @($sc.vms) | Select-Object -First 1
    $ok = (-not [bool]$call.result.isError) -and ([int]$sc.count -gt 0) -and $first.name -and $first.datacenter
    Assert-Test 'MCP tools/call vsphere_list_vm_details' $ok "count: $($sc.count), first: $($first.name) in $($first.datacenter)/$($first.cluster) created $($first.created)"
} catch {
    Assert-Test 'MCP tools/call vsphere_list_vm_details' $false $_.Exception.Message
}

try {
    $call = Invoke-McpJsonRpc -Id 23 -Method 'tools/call' -Params @{
        name      = 'vsphere_list_vm_details'
        arguments = @{ created_after = 'not-a-date' }
    }
    $text = Get-CallText $call
    Assert-Test 'Invalid created_after gives a clear error' ([bool]$call.result.isError -and ($text -match 'ISO 8601')) $text
} catch {
    Assert-Test 'Invalid created_after gives a clear error' $false $_.Exception.Message
}

try {
    Invoke-McpJsonRpc -Id 9 -Method 'tools/list' -Token '' -ErrorAction Stop | Out-Null
    Assert-Test 'Missing token is rejected' $false '(request unexpectedly succeeded)'
} catch {
    $code = [int]$_.Exception.Response.StatusCode
    Assert-Test 'Missing token is rejected' ($code -eq 401) "(status $code)"
}

try {
    Invoke-McpJsonRpc -Id 10 -Method 'tools/list' -Token 'not-a-real-token' -ErrorAction Stop | Out-Null
    Assert-Test 'Invalid token is rejected' $false '(request unexpectedly succeeded)'
} catch {
    $code = [int]$_.Exception.Response.StatusCode
    Assert-Test 'Invalid token is rejected' ($code -eq 403) "(status $code)"
}

Write-Host
Write-Host ("Result: {0} passed, {1} failed" -f $script:Passed, $script:Failed) -ForegroundColor Cyan
if ($script:Failed -gt 0) { exit 1 }
