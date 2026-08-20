param(
    [string]$FunctionName = "bin-ecommerce-media-video-processor",
    [string]$BucketName = "bin-ecommerce",
    [string]$QueueName = "bin-ecommerce-media-video-resize",
    [string]$DlqName = "bin-ecommerce-media-video-resize-dlq",
    [string]$Region = "ap-southeast-1",
    [string]$AccountId = "",
    [string]$RoleName = "bin-ecommerce-media-image-processor-role",
    [switch]$SkipIamPolicy
)

$ErrorActionPreference = "Stop"

# Kiểm tra AWS CLI trả lỗi ngay để không tạo pipeline nửa chừng mà không biết.
function Assert-LastExitCode {
    param([string]$Step)
    if ($LASTEXITCODE -ne 0) { throw "$Step failed with exit code $LASTEXITCODE." }
}

# Lấy ARN của queue theo tên; queue đã tồn tại thì tái sử dụng để script chạy idempotent.
function Get-QueueArn {
    param([string]$Name)
    # Queue chưa tồn tại là trường hợp bình thường ở lần setup đầu tiên,
    # không được để stderr của AWS CLI làm dừng toàn bộ script PowerShell.
    $previousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $url = & aws sqs get-queue-url --queue-name $Name --region $Region --query QueueUrl --output text 2>&1
        if ($LASTEXITCODE -ne 0) { return $null }
    } finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
    $arn = aws sqs get-queue-attributes --queue-url $url --attribute-names QueueArn --region $Region --query Attributes.QueueArn --output text
    Assert-LastExitCode "Read queue ARN for $Name"
    return @{ Url = $url; Arn = $arn }
}

# Tạo queue chính và DLQ, giữ visibility timeout đủ dài cho Lambda xử lý video.
function Ensure-Queue {
    param([string]$Name, [int]$VisibilityTimeout = 900)
    $existing = Get-QueueArn $Name
    if ($null -ne $existing) { return $existing }

    $url = aws sqs create-queue --queue-name $Name --attributes "VisibilityTimeout=$VisibilityTimeout,MessageRetentionPeriod=345600,ReceiveMessageWaitTimeSeconds=5" --region $Region --query QueueUrl --output text
    Assert-LastExitCode "Create queue $Name"
    $arn = aws sqs get-queue-attributes --queue-url $url --attribute-names QueueArn --region $Region --query Attributes.QueueArn --output text
    Assert-LastExitCode "Read created queue ARN for $Name"
    return @{ Url = $url; Arn = $arn }
}

if (-not $AccountId) {
    $AccountId = aws sts get-caller-identity --query Account --output text
    Assert-LastExitCode "Read AWS account id"
}

$dlq = Ensure-Queue $DlqName
$queue = Ensure-Queue $QueueName

# Gắn DLQ vào queue chính để message lỗi được giữ lại thay vì retry vô hạn.
$redrivePolicy = (@{ deadLetterTargetArn = $dlq.Arn; maxReceiveCount = 3 } | ConvertTo-Json -Compress)
$redrivePolicyFile = Join-Path $env:TEMP "bin-ecommerce-video-redrive-policy.json"
$redriveAttributes = @{ RedrivePolicy = $redrivePolicy } | ConvertTo-Json -Compress
$redriveAttributes | Set-Content -LiteralPath $redrivePolicyFile -Encoding ascii
aws sqs set-queue-attributes --queue-url $queue.Url --attributes "file://$redrivePolicyFile" --region $Region
Assert-LastExitCode "Configure video queue DLQ"

# Cho S3 gửi đúng video product vào queue video; cấu hình hiện có của queue ảnh được giữ nguyên.
$s3Policy = (@{
    Version = "2012-10-17"
    Statement = @(@{
        Sid = "AllowS3SendVideoMessage"
        Effect = "Allow"
        Principal = @{ Service = "s3.amazonaws.com" }
        Action = "sqs:SendMessage"
        Resource = $queue.Arn
        Condition = @{ ArnLike = @{ "aws:SourceArn" = "arn:aws:s3:::$BucketName" } }
    })
} | ConvertTo-Json -Depth 8 -Compress)
$s3PolicyFile = Join-Path $env:TEMP "bin-ecommerce-video-sqs-policy.json"
$s3Attributes = @{ Policy = $s3Policy } | ConvertTo-Json -Compress
$s3Attributes | Set-Content -LiteralPath $s3PolicyFile -Encoding ascii
aws sqs set-queue-attributes --queue-url $queue.Url --attributes "file://$s3PolicyFile" --region $Region
Assert-LastExitCode "Allow S3 to publish video events"

# S3 không cho phép hai rule cùng event có prefix chồng lấn. Rule ảnh cũ dùng
# uploads/original/ nên phải được tách theo từng purpose trước khi thêm rule video.
$existingNotificationJson = aws s3api get-bucket-notification-configuration --bucket $BucketName --region $Region
Assert-LastExitCode "Read existing S3 notification configuration"
$existingNotification = if ([string]::IsNullOrWhiteSpace($existingNotificationJson)) { @{} } else { $existingNotificationJson | ConvertFrom-Json }
$queueConfigurations = @()
if ($null -ne $existingNotification.QueueConfigurations) {
    $queueConfigurations += @($existingNotification.QueueConfigurations | Where-Object {
        $_.Id -ne "resize-original-images" -and
        $_.Id -ne "resize-original-videos" -and
        $_.Id -notlike "resize-original-image-*"
    })
}

# Mỗi purpose ảnh có prefix riêng để không nhận video và không tạo rule overlap.
$imagePurposes = @("avatar", "product_image", "shop_avatar", "shop_cover", "seller_document", "review_image", "chat_image")
foreach ($purpose in $imagePurposes) {
    $queueConfigurations += [pscustomobject]@{
        Id = "resize-original-image-$purpose"
        QueueArn = "arn:aws:sqs:${Region}:${AccountId}:bin-media-image-resize"
        Events = @("s3:ObjectCreated:*")
        Filter = [pscustomobject]@{ Key = [pscustomobject]@{ FilterRules = @([pscustomobject]@{ Name = "prefix"; Value = "uploads/original/$purpose/" }) } }
    }
}

$queueConfigurations += [pscustomobject]@{
    Id = "resize-original-videos"
    QueueArn = $queue.Arn
    Events = @("s3:ObjectCreated:*")
    Filter = [pscustomobject]@{ Key = [pscustomobject]@{ FilterRules = @([pscustomobject]@{ Name = "prefix"; Value = "uploads/original/product_video/" }) } }
}
$notification = [pscustomobject]@{ QueueConfigurations = $queueConfigurations }
$notificationFile = Join-Path $env:TEMP "bin-ecommerce-video-notification.json"
$notification | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $notificationFile -Encoding ascii
aws s3api put-bucket-notification-configuration --bucket $BucketName --notification-configuration file://$notificationFile --region $Region
Assert-LastExitCode "Configure S3 video notification"

if (-not $SkipIamPolicy) {
    # Role ảnh được dùng chung để không tạo thêm role rời; policy chỉ bổ sung quyền đúng queue/prefix video.
    $policy = @{
        Version = "2012-10-17"
        Statement = @(
            @{ Sid = "ReadOriginalMedia"; Effect = "Allow"; Action = @("s3:GetObject"); Resource = "arn:aws:s3:::$BucketName/uploads/original/*" },
            @{ Sid = "WriteProcessedMedia"; Effect = "Allow"; Action = @("s3:PutObject"); Resource = "arn:aws:s3:::$BucketName/media/processed/*" },
            @{ Sid = "ConsumeVideoResizeQueue"; Effect = "Allow"; Action = @("sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes", "sqs:ChangeMessageVisibility"); Resource = $queue.Arn }
        )
    }
    $policyFile = Join-Path $env:TEMP "bin-ecommerce-video-lambda-policy.json"
    $policy | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $policyFile -Encoding ascii
    aws iam put-role-policy --role-name $RoleName --policy-name bin-ecommerce-media-video-processor-access --policy-document file://$policyFile
    Assert-LastExitCode "Update Lambda video role policy"
}

$functionArn = aws lambda get-function --function-name $FunctionName --region $Region --query Configuration.FunctionArn --output text
Assert-LastExitCode "Read video Lambda ARN"
$mapping = aws lambda list-event-source-mappings --function-name $functionArn --event-source-arn $queue.Arn --region $Region --query 'EventSourceMappings[0].UUID' --output text 2>$null
if ($LASTEXITCODE -ne 0 -or $mapping -eq "None" -or [string]::IsNullOrWhiteSpace($mapping)) {
    aws lambda create-event-source-mapping --function-name $functionArn --event-source-arn $queue.Arn --batch-size 1 --maximum-batching-window-in-seconds 0 --function-response-types ReportBatchItemFailures --scaling-config MaximumConcurrency=2 --region $Region --no-cli-pager | Out-Null
    Assert-LastExitCode "Create video Lambda event source mapping"
} else {
    aws lambda update-event-source-mapping --uuid $mapping --batch-size 1 --function-response-types ReportBatchItemFailures --scaling-config MaximumConcurrency=2 --region $Region --no-cli-pager | Out-Null
    Assert-LastExitCode "Update video Lambda event source mapping"
}

Remove-Item -LiteralPath $notificationFile -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $redrivePolicyFile, $s3PolicyFile -Force -ErrorAction SilentlyContinue
Write-Host "Video pipeline configured: $QueueName -> $FunctionName"
