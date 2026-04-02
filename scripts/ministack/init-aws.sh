#!/bin/bash
# MiniStack initialization script
# Provisions AWS resources matching the SAM template for local development

set -euo pipefail

ENDPOINT="${MINISTACK_ENDPOINT:-http://localhost:4566}"
REGION="${AWS_DEFAULT_REGION:-us-east-1}"
TABLE_NAME="warmreach-test"
BUCKET_NAME="warmreach-screenshots-test"
QUEUE_NAME="profile-processing-test"
DLQ_NAME="profile-processing-dlq-test"
POOL_NAME="warmreach-test"

aws="aws --endpoint-url=$ENDPOINT --region=$REGION"

echo "==> Creating DynamoDB table: $TABLE_NAME"
$aws dynamodb create-table \
  --table-name "$TABLE_NAME" \
  --attribute-definitions \
    AttributeName=PK,AttributeType=S \
    AttributeName=SK,AttributeType=S \
    AttributeName=GSI1PK,AttributeType=S \
    AttributeName=GSI1SK,AttributeType=S \
  --key-schema \
    AttributeName=PK,KeyType=HASH \
    AttributeName=SK,KeyType=RANGE \
  --global-secondary-indexes \
    "[{\"IndexName\":\"GSI1\",\"KeySchema\":[{\"AttributeName\":\"GSI1PK\",\"KeyType\":\"HASH\"},{\"AttributeName\":\"GSI1SK\",\"KeyType\":\"RANGE\"}],\"Projection\":{\"ProjectionType\":\"ALL\"}}]" \
  --billing-mode PAY_PER_REQUEST \
  --no-cli-pager 2>/dev/null || echo "    Table already exists"

echo "==> Creating S3 bucket: $BUCKET_NAME"
$aws s3 mb "s3://$BUCKET_NAME" --no-cli-pager 2>/dev/null || echo "    Bucket already exists"

echo "==> Creating SQS DLQ: $DLQ_NAME"
DLQ_URL=$($aws sqs create-queue --queue-name "$DLQ_NAME" --no-cli-pager --query 'QueueUrl' --output text 2>/dev/null)
DLQ_ARN=$($aws sqs get-queue-attributes --queue-url "$DLQ_URL" --attribute-names QueueArn --query 'Attributes.QueueArn' --output text)

echo "==> Creating SQS queue: $QUEUE_NAME (with DLQ redrive)"
$aws sqs create-queue \
  --queue-name "$QUEUE_NAME" \
  --attributes "{\"RedrivePolicy\":\"{\\\"deadLetterTargetArn\\\":\\\"$DLQ_ARN\\\",\\\"maxReceiveCount\\\":\\\"3\\\"}\"}" \
  --no-cli-pager 2>/dev/null || echo "    Queue already exists"

echo "==> Creating Cognito User Pool: $POOL_NAME"
POOL_ID=$($aws cognito-idp create-user-pool \
  --pool-name "$POOL_NAME" \
  --auto-verified-attributes email \
  --username-attributes email \
  --no-cli-pager --query 'UserPool.Id' --output text 2>/dev/null) || POOL_ID=""

if [ -n "$POOL_ID" ]; then
  echo "==> Creating Cognito User Pool Client"
  CLIENT_ID=$($aws cognito-idp create-user-pool-client \
    --user-pool-id "$POOL_ID" \
    --client-name "test-client" \
    --explicit-auth-flows ALLOW_USER_PASSWORD_AUTH ALLOW_REFRESH_TOKEN_AUTH \
    --no-cli-pager --query 'UserPoolClient.ClientId' --output text)

  echo "==> Creating test user: testuser@example.com"
  $aws cognito-idp admin-create-user \
    --user-pool-id "$POOL_ID" \
    --username "testuser@example.com" \
    --temporary-password "TempPass123!" \
    --user-attributes Name=email,Value=testuser@example.com Name=email_verified,Value=true \
    --message-action SUPPRESS \
    --no-cli-pager 2>/dev/null || echo "    User already exists"

  $aws cognito-idp admin-set-user-password \
    --user-pool-id "$POOL_ID" \
    --username "testuser@example.com" \
    --password "TestPass123!" \
    --permanent \
    --no-cli-pager 2>/dev/null || true

  echo "==> Writing outputs to /tmp/ministack-outputs.env"
  cat > /tmp/ministack-outputs.env <<EOF
COGNITO_USER_POOL_ID=$POOL_ID
COGNITO_CLIENT_ID=$CLIENT_ID
DYNAMODB_TABLE_NAME=$TABLE_NAME
S3_BUCKET_NAME=$BUCKET_NAME
SQS_QUEUE_NAME=$QUEUE_NAME
MINISTACK_ENDPOINT=$ENDPOINT
EOF
else
  echo "    User Pool already exists (skipping client + user creation)"
fi

echo "==> MiniStack initialization complete"
