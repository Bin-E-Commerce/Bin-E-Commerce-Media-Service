param(
    [Parameter(Mandatory = $true)]
    [string]$ObjectKey,
    [string]$FunctionName = "bin-media-image-processor",
    [string]$Bucket = "bin-ecommerce",
    [string]$Region = "ap-southeast-1",
    [string]$CdnUrl = "https://drdt6fwp5vyhz.cloudfront.net"
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$serviceRoot = Resolve-Path (Join-Path $PSScriptRoot "../..")
$payloadPath = Join-Path $serviceRoot ".lambda-verify-payload.json"
$resultPath = Join-Path $serviceRoot ".lambda-verify-result.json"

# Dừng smoke test khi AWS CLI trả mã lỗi để không bỏ sót lỗi invoke hoặc lỗi đọc S3.
function Assert-LastExitCode {
    param([string]$Step)

    if ($LASTEXITCODE -ne 0) {
        throw "$Step failed with exit code $LASTEXITCODE."
    }
}

# Tách object key gốc để suy ra chính xác prefix output của ba ảnh WebP.
function Get-ProcessedPrefix {
    param([string]$OriginalObjectKey)

    $parts = $OriginalObjectKey.Split("/")
    if ($parts.Length -lt 6 -or $parts[0] -ne "uploads" -or $parts[1] -ne "original") {
        throw "ObjectKey must match uploads/original/{purpose}/{ownerId}/{assetId}/{file}."
    }

    return "media/processed/$($parts[2])/$($parts[3])/$($parts[4])"
}

try {
    $payload = @{
        Records = @(
            @{
                s3 = @{
                    object = @{
                        key = $ObjectKey
                    }
                }
            }
        )
    } | ConvertTo-Json -Depth 8 -Compress

    Set-Content -LiteralPath $payloadPath -Value $payload -Encoding ascii

    Write-Host "Checking source object: $ObjectKey"
    aws s3api head-object `
        --bucket $Bucket `
        --key $ObjectKey `
        --region $Region `
        --no-cli-pager | Out-Null
    Assert-LastExitCode "Check source S3 object"

    Write-Host "Invoking Lambda with object: $ObjectKey"
    aws lambda invoke `
        --function-name $FunctionName `
        --cli-binary-format raw-in-base64-out `
        --payload "file://$payloadPath" `
        --region $Region `
        $resultPath `
        --no-cli-pager | Out-Null
    Assert-LastExitCode "Invoke Lambda"

    $lambdaResult = Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json
    if ($lambdaResult.statusCode -ne 200) {
        throw "Lambda returned an unsuccessful result: $($lambdaResult | ConvertTo-Json -Compress)"
    }

    $processedPrefix = Get-ProcessedPrefix $ObjectKey
    $variants = @("thumb", "medium", "large")

    foreach ($variant in $variants) {
        $variantKey = "$processedPrefix/$variant.webp"

        aws s3api head-object `
            --bucket $Bucket `
            --key $variantKey `
            --region $Region `
            --no-cli-pager | Out-Null
        Assert-LastExitCode "Kiểm tra S3 object $variantKey"

        $publicUrl = "$($CdnUrl.TrimEnd('/'))/$variantKey"
        $response = Invoke-WebRequest `
            -Uri $publicUrl `
            -Method Head `
            -UseBasicParsing `
            -TimeoutSec 20

        if ($response.StatusCode -ne 200 -or $response.Headers["Content-Type"] -ne "image/webp") {
            throw "CloudFront did not return the expected WebP image: $publicUrl"
        }

        Write-Host "OK $variant -> $publicUrl"
    }

    Write-Host "Smoke test succeeded: S3 and CloudFront expose all three WebP variants."
}
finally {
    Remove-Item -LiteralPath $payloadPath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $resultPath -Force -ErrorAction SilentlyContinue
}
