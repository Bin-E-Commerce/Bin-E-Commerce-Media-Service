param(
    [string]$FunctionName = "bin-media-image-processor",
    [string]$Region = "ap-southeast-1",
    [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$serviceRoot = Resolve-Path (Join-Path $PSScriptRoot "../..")
$buildScript = Join-Path $PSScriptRoot "build-image-processor.ps1"
$zipPath = Join-Path $serviceRoot "image-processor.zip"

# Dừng deploy nếu AWS CLI hoặc script build trả mã lỗi để tránh báo thành công giả.
function Assert-LastExitCode {
    param([string]$Step)

    if ($LASTEXITCODE -ne 0) {
        throw "$Step failed with exit code $LASTEXITCODE."
    }
}

if (-not $SkipBuild) {
    & $buildScript
}

if (-not (Test-Path -LiteralPath $zipPath)) {
    throw "image-processor.zip was not found. Run npm run lambda:build first."
}

Write-Host "Checking AWS credentials..."
aws sts get-caller-identity | Out-Null
Assert-LastExitCode "Kiểm tra AWS credentials"

Write-Host "Deploying $FunctionName in $Region..."
aws lambda update-function-code `
    --function-name $FunctionName `
    --zip-file "fileb://$zipPath" `
    --region $Region `
    --no-cli-pager | Out-Null
Assert-LastExitCode "Upload Lambda code"

Write-Host "Waiting for Lambda update..."
aws lambda wait function-updated `
    --function-name $FunctionName `
    --region $Region
Assert-LastExitCode "Chờ Lambda update"

$configuration = aws lambda get-function-configuration `
    --function-name $FunctionName `
    --region $Region `
    --query "{FunctionName:FunctionName,Runtime:Runtime,State:State,LastUpdateStatus:LastUpdateStatus,CodeSize:CodeSize}" `
    --output json
Assert-LastExitCode "Đọc Lambda configuration"

Write-Host "Deploy succeeded:"
Write-Host $configuration
