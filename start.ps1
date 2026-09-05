param(
    [int]$Port = 8765,
    [string]$HostAddress = "127.0.0.1",
    [string]$ComfyUIUrl = "http://127.0.0.1:8188",
    [string]$Token = ""
)

$scriptPath = Join-Path $PSScriptRoot "server.mjs"
$scriptArgs = @()
if ($Token) { $scriptArgs += @("--token", $Token) }
node $scriptPath --host $HostAddress --port $Port --comfy-url $ComfyUIUrl @scriptArgs
