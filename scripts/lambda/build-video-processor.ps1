param(
    [string]$DockerImage = "public.ecr.aws/lambda/nodejs:20"
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$serviceRoot = Resolve-Path (Join-Path $PSScriptRoot "../..")
$packageRoot = Join-Path $serviceRoot "lambda/video-processor"

# Dùng TypeScript compiler của media-service để đảm bảo Lambda có cùng compiler settings với repo.
Push-Location $serviceRoot
try {
    npm run build:lambda
    if ($LASTEXITCODE -ne 0) { throw "Compile video Lambda failed." }
}
finally {
    Pop-Location
}

$distFile = Join-Path $serviceRoot "dist/lambda/video-processor/index.js"
if (-not (Test-Path -LiteralPath $distFile)) {
    throw "Compiled video Lambda was not found: $distFile"
}

Write-Host "Building video processor container image..."
docker build --platform linux/amd64 --provenance=false --file (Join-Path $packageRoot "Dockerfile") --tag bin-ecommerce-media-video-processor:latest $serviceRoot
if ($LASTEXITCODE -ne 0) { throw "Build video processor image failed." }

Write-Host "Video processor image built successfully."
