#!/usr/bin/env bash
set -euo pipefail

STACK_NAME=${1:-warmreach}

echo "📊 Fetching outputs from stack: $STACK_NAME"
echo ""

# Get outputs in JSON
OUTPUTS=$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --query 'Stacks[0].Outputs' \
  --output json)

# Parse outputs
API_URL=$(echo "$OUTPUTS" | jq -r '.[] | select(.OutputKey=="ApiUrl") | .OutputValue')
USER_POOL_ID=$(echo "$OUTPUTS" | jq -r '.[] | select(.OutputKey=="UserPoolId") | .OutputValue')
USER_POOL_CLIENT_ID=$(echo "$OUTPUTS" | jq -r '.[] | select(.OutputKey=="UserPoolClientId") | .OutputValue')
TABLE_NAME=$(echo "$OUTPUTS" | jq -r '.[] | select(.OutputKey=="DynamoDBTableName") | .OutputValue')
WEBSOCKET_URL=$(echo "$OUTPUTS" | jq -r '.[] | select(.OutputKey=="WebSocketApiUrl") | .OutputValue')
REGION=$(aws configure get region)

echo "✅ Stack outputs retrieved!"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📝 UPDATE YOUR .env FILE WITH THESE VALUES:"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "# Frontend (React/Vite) - AWS Configuration"
echo "VITE_API_GATEWAY_URL=$API_URL"
echo "VITE_AWS_REGION=$REGION"
echo "VITE_COGNITO_USER_POOL_ID=$USER_POOL_ID"
echo "VITE_COGNITO_USER_POOL_WEB_CLIENT_ID=$USER_POOL_CLIENT_ID"
echo "VITE_WEBSOCKET_URL=$WEBSOCKET_URL"
echo ""
echo "# Backend (Puppeteer) - AWS Configuration"
echo "API_GATEWAY_BASE_URL=$API_URL"
echo "AWS_REGION=$REGION"
echo "DYNAMODB_TABLE=$TABLE_NAME"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "📋 Key Endpoints:"
echo "  • API Base:    $API_URL"
echo "  • Edge:        $API_URL/edge"
echo "  • Search:      $API_URL/search"
echo "  • DynamoDB:    $API_URL/dynamodb"
echo ""
echo "🔐 Cognito:"
echo "  • User Pool:   $USER_POOL_ID"
echo "  • Client ID:   $USER_POOL_CLIENT_ID"
echo ""
echo "💾 Storage:"
echo "  • DynamoDB:    $TABLE_NAME"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "💡 To update .env automatically:"
echo "   ./get-env-vars.sh $STACK_NAME --update-env"
echo ""

# Check if --update-env flag is passed
if [[ "${2}" == "--update-env" ]]; then
    ENV_FILE="../.env"

    if [ ! -f "$ENV_FILE" ]; then
        echo "❌ $ENV_FILE not found!"
        echo ""
        echo "📋 First-time setup required:"
        echo "   cd .."
        echo "   cp .env.example .env"
        echo "   cd scripts/deploy"
        echo "   ./get-env-vars.sh $STACK_NAME --update-env"
        exit 1
    fi

    echo "📝 Updating $ENV_FILE..."

    # Function to update or append env var
    update_env_var() {
        local key=$1
        local value=$2
        local file=$3

        if grep -q "^${key}=" "$file"; then
            # Update existing
            if [[ "$OSTYPE" == "darwin"* ]]; then
                sed -i '' "s|^${key}=.*|${key}=${value}|" "$file"
            else
                sed -i "s|^${key}=.*|${key}=${value}|" "$file"
            fi
            echo "  ✓ Updated $key"
        else
            # Append new
            echo "${key}=${value}" >> "$file"
            echo "  ✓ Added $key"
        fi
    }

    # Update all variables
    update_env_var "VITE_API_GATEWAY_URL" "$API_URL" "$ENV_FILE"
    update_env_var "VITE_AWS_REGION" "$REGION" "$ENV_FILE"
    update_env_var "VITE_COGNITO_USER_POOL_ID" "$USER_POOL_ID" "$ENV_FILE"
    update_env_var "VITE_COGNITO_USER_POOL_WEB_CLIENT_ID" "$USER_POOL_CLIENT_ID" "$ENV_FILE"
    update_env_var "VITE_WEBSOCKET_URL" "$WEBSOCKET_URL" "$ENV_FILE"
    update_env_var "API_GATEWAY_BASE_URL" "$API_URL" "$ENV_FILE"
    update_env_var "AWS_REGION" "$REGION" "$ENV_FILE"
    update_env_var "DYNAMODB_TABLE" "$TABLE_NAME" "$ENV_FILE"

    echo ""
    echo "✅ Updated $ENV_FILE with AWS deployment outputs!"
    echo ""
    echo "🔄 Next steps:"
    echo "   1. Restart your dev server: npm run dev"
    echo "   2. Restart client backend: npm run dev:client"
fi
