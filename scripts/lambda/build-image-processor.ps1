param(
    [string]$DockerImage = "public.ecr.aws/lambda/nodejs:24"
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$serviceRoot = Resolve-Path (Join-Path $PSScriptRoot "../..")
$sourceDirectory = Join-Path $serviceRoot "lambda/image-processor"
$compiledDirectory = Join-Path $serviceRoot "dist/lambda/image-processor"
$packageDirectory = Join-Path $serviceRoot ".lambda-package"
$zipPath = Join-Path $serviceRoot "image-processor.zip"

# Dừng script ngay khi một chương trình bên ngoài như npm, Docker hoặc tar trả mã lỗi.
function Assert-LastExitCode {
    param([string]$Step)

    if ($LASTEXITCODE -ne 0) {
        throw "$Step failed with exit code $LASTEXITCODE."
    }
}

Write-Host "[1/5] Type-check and compile Lambda..."
Push-Location $serviceRoot
try {
    npm run type-check
    Assert-LastExitCode "Type-check media-service"

    npm run build:lambda
    Assert-LastExitCode "Compile Lambda"
}
finally {
    Pop-Location
}

Write-Host "[2/5] Create clean package directory..."
Remove-Item -LiteralPath $packageDirectory -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $zipPath -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $packageDirectory | Out-Null

Copy-Item -Path (Join-Path $compiledDirectory "*") -Destination $packageDirectory -Recurse -Force
Copy-Item -LiteralPath (Join-Path $sourceDirectory "package.json") -Destination $packageDirectory
Copy-Item -LiteralPath (Join-Path $sourceDirectory "package-lock.json") -Destination $packageDirectory

Write-Host "[3/5] Install minimal Linux x64 runtime dependencies..."
$dockerPackageDirectory = $packageDirectory.Replace("\", "/")
docker run --rm `
    --entrypoint bash `
    -v "${dockerPackageDirectory}:/asset" `
    -w /asset `
    $DockerImage `
    -lc "npm ci --omit=dev --cpu=x64 --os=linux"
Assert-LastExitCode "Cài dependency Lambda"

# npm tạo symlink trong node_modules/.bin; Lambda không dùng thư mục này và Windows khó nén symlink Linux.
Remove-Item -LiteralPath (Join-Path $packageDirectory "node_modules/.bin") `
    -Recurse `
    -Force `
    -ErrorAction SilentlyContinue

Write-Host "[4/5] Create deployment package..."
tar -a -cf $zipPath -C $packageDirectory .
Assert-LastExitCode "Nén image-processor.zip"

Write-Host "[5/5] Validate required runtime files..."
$archiveEntries = tar -tf $zipPath
Assert-LastExitCode "Đọc deployment package"

$requiredEntries = @(
    "./index.js",
    "./node_modules/sharp/package.json",
    "./node_modules/semver/functions/coerce.js"
)

foreach ($entry in $requiredEntries) {
    if ($archiveEntries -notcontains $entry) {
        throw "Deployment package is missing required file: $entry"
    }
}

$zip = Get-Item $zipPath
Write-Host "Build succeeded: $($zip.FullName) ($([Math]::Round($zip.Length / 1MB, 2)) MB)"
