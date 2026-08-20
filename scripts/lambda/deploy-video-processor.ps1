param(
    [string]$FunctionName = "bin-ecommerce-media-video-processor",
    [string]$RepositoryName = "bin-ecommerce-media-video-processor",
    [string]$Region = "ap-southeast-1",
    [string]$AccountId = "",
    [string]$ExecutionRoleArn = "",
    [string]$BucketName = "bin-ecommerce",
    [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
$serviceRoot = Resolve-Path (Join-Path $PSScriptRoot "../..")
$buildScript = Join-Path $PSScriptRoot "build-video-processor.ps1"

function Assert-LastExitCode {
    param([string]$Step)
    if ($LASTEXITCODE -ne 0) { throw "$Step failed with exit code $LASTEXITCODE." }
}

if (-not $SkipBuild) { & $buildScript }

aws sts get-caller-identity | Out-Null
Assert-LastExitCode "Check AWS credentials"

if (-not $AccountId) {
    $AccountId = aws sts get-caller-identity --query Account --output text
    Assert-LastExitCode "Read AWS account id"
}

$repositoryUri = "$AccountId.dkr.ecr.$Region.amazonaws.com/$RepositoryName"
aws ecr describe-repositories --repository-names $RepositoryName --region $Region | Out-Null
if ($LASTEXITCODE -ne 0) {
    aws ecr create-repository --repository-name $RepositoryName --region $Region | Out-Null
    Assert-LastExitCode "Create ECR repository"
}

$loginPassword = aws ecr get-login-password --region $Region
Assert-LastExitCode "Read ECR login token"
$loginPassword | docker login --username AWS --password-stdin "$AccountId.dkr.ecr.$Region.amazonaws.com"
Assert-LastExitCode "Login to ECR"

docker tag bin-ecommerce-media-video-processor:latest "${repositoryUri}:latest"
docker push "${repositoryUri}:latest"
Assert-LastExitCode "Push video processor image"

# AWS trả mã 254 khi Lambda chưa tồn tại. Đây là trạng thái hợp lệ ở lần deploy đầu,
# vì vậy không để ErrorActionPreference=Stop biến kết quả kiểm tra này thành exception.
$previousErrorActionPreference = $ErrorActionPreference
$ErrorActionPreference = "Continue"
try {
    $null = & aws lambda get-function --function-name $FunctionName --region $Region 2>&1
    $functionExists = $LASTEXITCODE -eq 0
} finally {
    $ErrorActionPreference = $previousErrorActionPreference
}
$createdFunction = $false
if ($functionExists) {
    aws lambda update-function-code --function-name $FunctionName --image-uri "$repositoryUri:latest" --region $Region --no-cli-pager | Out-Null
    Assert-LastExitCode "Update Lambda function code"
} else {
    if (-not $ExecutionRoleArn) {
        throw "Lambda does not exist. Provide -ExecutionRoleArn for the first deployment."
    }
    aws lambda create-function `
        --function-name $FunctionName `
        --package-type Image `
        --code ImageUri="${repositoryUri}:latest" `
        --role $ExecutionRoleArn `
        --memory-size 3008 `
        --timeout 900 `
        --environment "Variables={AWS_S3_BUCKET=$BucketName}" `
        --region $Region `
        --no-cli-pager | Out-Null
    Assert-LastExitCode "Create video processor Lambda"
    $createdFunction = $true
}

# Lambda mới cần chờ trạng thái Active; Lambda đã tồn tại chỉ cần chờ bản cập nhật hoàn tất.
if ($createdFunction) {
    aws lambda wait function-active-v2 --function-name $FunctionName --region $Region
    Assert-LastExitCode "Wait for Lambda activation"
} else {
    aws lambda wait function-updated-v2 --function-name $FunctionName --region $Region
    Assert-LastExitCode "Wait for Lambda update"
}
aws lambda get-function-configuration --function-name $FunctionName --region $Region --query "{FunctionName:FunctionName,PackageType:PackageType,State:State,LastUpdateStatus:LastUpdateStatus,MemorySize:MemorySize,Timeout:Timeout}" --output json
