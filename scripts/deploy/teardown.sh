#!/bin/bash
# WarmReach Stack Teardown
#
# Idempotently removes all warmreach AWS resources so the next `npm run deploy`
# starts from a clean account. Discovers resources dynamically (no hardcoded
# physical IDs), handles versioned S3 buckets, S3 Vectors buckets+indexes,
# Cognito user pools, DynamoDB tables, the CloudFormation stack, and orphan
# IAM roles created by failed deploys.
#
# Usage:
#   bash scripts/deploy/teardown.sh           # interactive confirm
#   bash scripts/deploy/teardown.sh --yes     # skip confirm
#   bash scripts/deploy/teardown.sh --dry-run # list what would be deleted
#
# Preserved (NOT deleted):
#   - sam-deploy-warmreach-${ACCOUNT}-${REGION}  (SAM artifact bucket)
#   - /warmreach/* SSM SecureString parameters   (your secrets)

set -uo pipefail

REGION="us-east-1"
STACK_NAME="warmreach"
DRY_RUN=false
SKIP_CONFIRM=false

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --yes|-y)  SKIP_CONFIRM=true ;;
    -h|--help)
      head -25 "$0" | sed 's|^# \?||'
      exit 0 ;;
    *) echo "Unknown flag: $arg" >&2; exit 1 ;;
  esac
done

run() {
  if [ "$DRY_RUN" = true ]; then
    echo "  [dry-run] $*"
  else
    "$@"
  fi
}

banner() {
  echo
  echo "============================================================"
  echo "$1"
  echo "============================================================"
}

warn() {
  echo "  ⚠ $1" >&2
}

# ----------------------------------------------------------------------------
# Pre-flight + discovery
# ----------------------------------------------------------------------------

ACCOUNT=$(aws sts get-caller-identity --query Account --output text 2>/dev/null) || {
  echo "AWS credentials not configured. Run \`aws configure\`." >&2; exit 1; }

banner "WarmReach Teardown — account $ACCOUNT, region $REGION"

# Discover what's actually present so the user can see before confirming
echo "Discovering resources..."

STACK_STATUS=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$REGION" \
  --query "Stacks[0].StackStatus" --output text 2>/dev/null || echo "absent")

USER_POOLS=$(aws cognito-idp list-user-pools --region "$REGION" --max-results 60 \
  --query 'UserPools[?contains(Name, `warmreach`)].Id' --output text 2>/dev/null)

DDB_TABLES=$(aws dynamodb list-tables --region "$REGION" \
  --query 'TableNames[?contains(@, `warmreach`)]' --output text 2>/dev/null)

S3_BUCKETS=$(aws s3api list-buckets \
  --query 'Buckets[?starts_with(Name, `warmreach-`) && !contains(Name, `sam-deploy`)].Name' \
  --output text 2>/dev/null)

S3VEC_BUCKETS=$(aws s3vectors list-vector-buckets --region "$REGION" \
  --query 'vectorBuckets[?contains(vectorBucketName, `warmreach`)].vectorBucketName' \
  --output text 2>/dev/null)

CWLOG_ROLES=$(aws iam list-roles \
  --query 'Roles[?starts_with(RoleName, `warmreach-ApiGatewayCloudWatchLogsRole-`)].RoleName' \
  --output text 2>/dev/null)

cat <<EOF

Stack:              $STACK_STATUS
Cognito pools:      ${USER_POOLS:-none}
DynamoDB tables:    ${DDB_TABLES:-none}
S3 buckets:         ${S3_BUCKETS:-none}
S3 Vectors buckets: ${S3VEC_BUCKETS:-none}
CW Logs roles:      ${CWLOG_ROLES:-none}

Preserved (will NOT be deleted):
  - SAM artifact bucket: sam-deploy-warmreach-${ACCOUNT}-${REGION}
  - SSM secrets:         /warmreach/*
EOF

if [ "$DRY_RUN" = false ] && [ "$SKIP_CONFIRM" = false ]; then
  echo
  read -p "Proceed with teardown? Type 'yes' to confirm: " ans
  [ "$ans" = "yes" ] || { echo "Aborted."; exit 0; }
fi

# ----------------------------------------------------------------------------
# 1. S3 Vectors — indexes inside each bucket, then the buckets
# ----------------------------------------------------------------------------

if [ -n "$S3VEC_BUCKETS" ]; then
  banner "S3 Vectors"
  for vb in $S3VEC_BUCKETS; do
    # Paginate explicitly: delete-vector-bucket fails if any index remains,
    # so missing a page would leave a permanent orphan.
    INDEXES=""
    NEXT_TOKEN=""
    while :; do
      if [ -n "$NEXT_TOKEN" ]; then
        page=$(aws s3vectors list-indexes --region "$REGION" --vector-bucket-name "$vb" \
          --max-results 100 --next-token "$NEXT_TOKEN" --output json 2>/dev/null) || break
      else
        page=$(aws s3vectors list-indexes --region "$REGION" --vector-bucket-name "$vb" \
          --max-results 100 --output json 2>/dev/null) || break
      fi
      page_indexes=$(echo "$page" | python3 -c "import sys,json; d=json.load(sys.stdin); print(' '.join(i['indexName'] for i in d.get('indexes', [])))" 2>/dev/null)
      INDEXES="$INDEXES $page_indexes"
      NEXT_TOKEN=$(echo "$page" | python3 -c "import sys,json; t=json.load(sys.stdin).get('nextToken'); print(t or '')" 2>/dev/null)
      [ -z "$NEXT_TOKEN" ] || [ "$NEXT_TOKEN" = "None" ] && break
    done
    for idx in $INDEXES; do
      echo "Delete index $idx in $vb"
      run aws s3vectors delete-index --region "$REGION" \
        --vector-bucket-name "$vb" --index-name "$idx"
    done
    echo "Delete vector bucket $vb"
    run aws s3vectors delete-vector-bucket --region "$REGION" --vector-bucket-name "$vb"
  done
fi

# ----------------------------------------------------------------------------
# 2. Cognito user pools
# ----------------------------------------------------------------------------

if [ -n "$USER_POOLS" ]; then
  banner "Cognito user pools"
  for pool in $USER_POOLS; do
    echo "Delete user pool $pool"
    run aws cognito-idp delete-user-pool --user-pool-id "$pool" --region "$REGION"
  done
fi

# ----------------------------------------------------------------------------
# 3. DynamoDB tables (top-level + nested ragstack)
# ----------------------------------------------------------------------------

if [ -n "$DDB_TABLES" ]; then
  banner "DynamoDB tables"
  for t in $DDB_TABLES; do
    echo "Delete table $t"
    run aws dynamodb delete-table --table-name "$t" --region "$REGION"
  done
fi

# ----------------------------------------------------------------------------
# 4. S3 buckets — empty all versions + delete markers, then bucket
# ----------------------------------------------------------------------------

FAILURE=0

# Drain a bucket of every version + delete-marker, paging through API
# results so buckets with >1000 objects don't leave orphans behind.
empty_bucket_paginated() {
  local b="$1"
  local kind="$2"  # "Versions" or "DeleteMarkers"
  local next_token=""
  local cli_args=(--bucket "$b" --region "$REGION" --max-items 1000 --output json)
  while :; do
    if [ -n "$next_token" ]; then
      list_json=$(aws s3api list-object-versions "${cli_args[@]}" \
        --starting-token "$next_token" \
        --query "{Objects: ${kind}[].{Key:Key,VersionId:VersionId}, NextToken: NextToken}" 2>/dev/null)
    else
      list_json=$(aws s3api list-object-versions "${cli_args[@]}" \
        --query "{Objects: ${kind}[].{Key:Key,VersionId:VersionId}, NextToken: NextToken}" 2>/dev/null)
    fi
    if [ -z "$list_json" ] || ! echo "$list_json" | grep -q '"Key"'; then
      break
    fi
    objects=$(echo "$list_json" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(json.dumps({"Objects": d.get("Objects") or []}))')
    if echo "$objects" | grep -q '"Key"'; then
      if ! aws s3api delete-objects --bucket "$b" --region "$REGION" \
          --delete "$objects" >/dev/null 2>&1; then
        warn "delete-objects failed for $b ($kind page)"
        FAILURE=1
      fi
    fi
    next_token=$(echo "$list_json" | python3 -c 'import json,sys; d=json.load(sys.stdin); t=d.get("NextToken"); print(t or "")')
    if [ -z "$next_token" ]; then break; fi
  done
}

if [ -n "$S3_BUCKETS" ]; then
  banner "S3 buckets (version-aware cleanup)"
  for b in $S3_BUCKETS; do
    echo "Empty + delete bucket $b"
    if [ "$DRY_RUN" = false ]; then
      empty_bucket_paginated "$b" "Versions"
      empty_bucket_paginated "$b" "DeleteMarkers"
      if ! aws s3 rb "s3://$b" --region "$REGION" 2>&1 | head -3; then
        warn "rb failed for s3://$b"
        FAILURE=1
      fi
    else
      echo "  [dry-run] empty + rb s3://$b"
    fi
  done
fi

# ----------------------------------------------------------------------------
# 5. CloudFormation stack
# ----------------------------------------------------------------------------

if [ "$STACK_STATUS" != "absent" ]; then
  banner "CloudFormation stack"
  echo "Delete stack $STACK_NAME (status: $STACK_STATUS)"
  if [ "$DRY_RUN" = false ]; then
    if ! aws cloudformation delete-stack --stack-name "$STACK_NAME" --region "$REGION"; then
      warn "delete-stack call failed"
      FAILURE=1
    fi
    echo "Waiting for stack delete to complete (this can take ~5 minutes)..."
    if ! aws cloudformation wait stack-delete-complete --stack-name "$STACK_NAME" --region "$REGION"; then
      warn "stack delete did not complete cleanly — final status:"
      aws cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$REGION" \
        --query "Stacks[0].StackStatus" --output text 2>&1 | head -1 || true
      FAILURE=1
    fi
  else
    run aws cloudformation delete-stack --stack-name "$STACK_NAME" --region "$REGION"
  fi
fi

# ----------------------------------------------------------------------------
# 6. Stale CloudWatch Logs roles (Retain policy orphans from failed deploys)
# ----------------------------------------------------------------------------

# Re-discover after stack delete: only roles that survived stack deletion are stale
CWLOG_ROLES=$(aws iam list-roles \
  --query 'Roles[?starts_with(RoleName, `warmreach-ApiGatewayCloudWatchLogsRole-`)].RoleName' \
  --output text 2>/dev/null)

if [ -n "$CWLOG_ROLES" ]; then
  banner "Stale IAM roles"
  for r in $CWLOG_ROLES; do
    echo "Detach policies + delete role $r"
    if [ "$DRY_RUN" = false ]; then
      for arn in $(aws iam list-attached-role-policies --role-name "$r" \
          --query 'AttachedPolicies[].PolicyArn' --output text 2>/dev/null); do
        if ! aws iam detach-role-policy --role-name "$r" --policy-arn "$arn" 2>&1 | head -1; then
          warn "detach-role-policy failed for $r / $arn"
          FAILURE=1
        fi
      done
      if ! aws iam delete-role --role-name "$r" 2>&1 | head -1; then
        warn "delete-role failed for $r"
        FAILURE=1
      fi
    fi
  done
fi

# Re-query stale CW Logs roles to detect any that survived the deletion attempt
REMAINING_CWLOG_ROLES=$(aws iam list-roles \
  --query 'Roles[?starts_with(RoleName, `warmreach-ApiGatewayCloudWatchLogsRole-`)].RoleName' \
  --output text 2>/dev/null)

# ----------------------------------------------------------------------------
# 7. Final verification
# ----------------------------------------------------------------------------

banner "Verification"
if [ "$DRY_RUN" = true ]; then
  echo "(dry run — nothing was actually deleted)"
  exit 0
fi

REMAINING_DDB=$(aws dynamodb list-tables --region "$REGION" \
  --query 'TableNames[?contains(@, `warmreach`)]' --output text)
REMAINING_POOLS=$(aws cognito-idp list-user-pools --region "$REGION" --max-results 60 \
  --query 'UserPools[?contains(Name, `warmreach`)].Id' --output text)
REMAINING_BUCKETS=$(aws s3api list-buckets \
  --query 'Buckets[?starts_with(Name, `warmreach-`) && !contains(Name, `sam-deploy`)].Name' --output text)
REMAINING_VECBUCKETS=$(aws s3vectors list-vector-buckets --region "$REGION" \
  --query 'vectorBuckets[?contains(vectorBucketName, `warmreach`)].vectorBucketName' --output text 2>/dev/null)

echo "DynamoDB:   ${REMAINING_DDB:-clean}"
echo "Cognito:    ${REMAINING_POOLS:-clean}"
echo "S3:         ${REMAINING_BUCKETS:-clean}"
echo "S3 Vectors: ${REMAINING_VECBUCKETS:-clean}"
echo "CW roles:   ${REMAINING_CWLOG_ROLES:-clean}"

if [ "$FAILURE" -ne 0 ]; then
  banner "Teardown encountered failures — see warnings above"
  exit 1
fi

if [ -z "$REMAINING_DDB$REMAINING_POOLS$REMAINING_BUCKETS$REMAINING_VECBUCKETS$REMAINING_CWLOG_ROLES" ]; then
  banner "Teardown complete — ready for npm run deploy"
else
  banner "Some resources remain — re-run or investigate above"
  exit 1
fi
