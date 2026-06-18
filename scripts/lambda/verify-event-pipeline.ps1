param(
    [Parameter(Mandatory = $true)]
    [string]$SourceObjectKey,
    [string]$Bucket = "bin-ecommerce",
    [string]$Region = "ap-southeast-1",
    [string]$CdnUrl = "https://drdt6fwp5vyhz.cloudfront.net",
    [int]$MaxAttempts = 20,
    [int]$DelaySeconds = 2
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

# Dừng smoke test khi AWS CLI trả mã lỗi để không báo pipeline thành công giả.
function Assert-LastExitCode {
    param([string]$Step)

    if ($LASTEXITCODE -ne 0) {
        throw "$Step failed with exit code $LASTEXITCODE."
    }
}

$assetId = [Guid]::NewGuid().ToString()
$ownerId = "lambda-pipeline-smoke"
$originalKey = "uploads/original/avatar/$ownerId/$assetId/source.jpg"
$processedPrefix = "media/processed/avatar/$ownerId/$assetId"
$variantKeys = @(
    "$processedPrefix/thumb.webp",
    "$processedPrefix/medium.webp",
    "$processedPrefix/large.webp"
)

try {
    Write-Host "Checking source object: $SourceObjectKey"
    aws s3api head-object `
        --bucket $Bucket `
        --key $SourceObjectKey `
        --region $Region `
        --no-cli-pager | Out-Null
    Assert-LastExitCode "Check source S3 object"

    # Copy sang key mới trong uploads/original để phát sinh ObjectCreated event thật, không invoke Lambda trực tiếp.
    Write-Host "Creating pipeline test object: $originalKey"
    $encodedCopySource = [Uri]::EscapeDataString("$Bucket/$SourceObjectKey").Replace("%2F", "/")
    aws s3api copy-object `
        --bucket $Bucket `
        --copy-source $encodedCopySource `
        --key $originalKey `
        --content-type "image/jpeg" `
        --metadata-directive REPLACE `
        --region $Region `
        --no-cli-pager | Out-Null
    Assert-LastExitCode "Create S3 pipeline test object"

    $allVariantsReady = $false

    # SQS và Lambda xử lý bất đồng bộ nên poll S3 trong thời gian giới hạn thay vì chờ cố định.
    for ($attempt = 1; $attempt -le $MaxAttempts; $attempt += 1) {
        $readyCount = 0

        foreach ($variantKey in $variantKeys) {
            aws s3api head-object `
                --bucket $Bucket `
                --key $variantKey `
                --region $Region `
                --no-cli-pager 2>$null | Out-Null

            if ($LASTEXITCODE -eq 0) {
                $readyCount += 1
            }
        }

        Write-Host "Attempt $attempt/${MaxAttempts}: $readyCount/3 variants ready"

        if ($readyCount -eq 3) {
            $allVariantsReady = $true
            break
        }

        Start-Sleep -Seconds $DelaySeconds
    }

    if (-not $allVariantsReady) {
        throw "S3 -> SQS -> Lambda pipeline did not create all variants in time."
    }

    foreach ($variantKey in $variantKeys) {
        $publicUrl = "$($CdnUrl.TrimEnd('/'))/$variantKey"
        $response = Invoke-WebRequest `
            -Uri $publicUrl `
            -Method Head `
            -UseBasicParsing `
            -TimeoutSec 20

        if ($response.StatusCode -ne 200 -or $response.Headers["Content-Type"] -ne "image/webp") {
            throw "CloudFront did not return the expected WebP image: $publicUrl"
        }

        Write-Host "OK -> $publicUrl"
    }

    Write-Host "Event pipeline succeeded: S3 -> SQS -> Lambda -> S3 -> CloudFront."
}
finally {
    # Xóa đúng các object smoke test vừa tạo để không làm bẩn bucket.
    $cleanupKeys = @($originalKey) + $variantKeys
    foreach ($cleanupKey in $cleanupKeys) {
        aws s3api delete-object `
            --bucket $Bucket `
            --key $cleanupKey `
            --region $Region `
            --no-cli-pager 2>$null | Out-Null
    }
}
