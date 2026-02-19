#!/usr/bin/env node
/**
 * SAM Deployment Script
 *
 * Deploys the WarmReach backend via SAM.
 * - Prompts for configuration if not present
 * - Generates samconfig.toml
 * - Executes SAM build and deploy
 * - Captures outputs to .env file
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { execSync, spawn } from 'child_process';
import { createInterface } from 'readline';
import { resolve, join, dirname } from 'path';
import { fileURLToPath } from 'url';

// Derive PROJECT_ROOT from script location, not cwd()
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = resolve(__dirname, '..', '..');  // scripts/deploy -> root
const BACKEND_DIR = join(PROJECT_ROOT, 'backend');
const CONFIG_FILE = '.deploy-config.json';

/**
 * Prompts user for input with optional secret masking
 */
function prompt(question, defaultValue = '', isSecret = false) {
  return new Promise((resolve) => {
    const displayQuestion = defaultValue && !isSecret
      ? `${question} [${defaultValue}]: `
      : `${question}: `;

    if (isSecret) {
      // Secret input - mask with asterisks
      process.stdout.write(displayQuestion);
      let input = '';

      if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
      }
      process.stdin.resume();
      process.stdin.setEncoding('utf8');

      const onData = (char) => {
        if (char === '\n' || char === '\r') {
          process.stdin.setRawMode && process.stdin.setRawMode(false);
          process.stdin.removeListener('data', onData);
          process.stdin.pause();
          process.stdout.write('\n');
          resolve(input.trim() || defaultValue);
        } else if (char === '\u0003') {
          // Ctrl+C
          process.exit(1);
        } else if (char === '\u007F' || char === '\b') {
          // Backspace
          if (input.length > 0) {
            input = input.slice(0, -1);
            process.stdout.write('\b \b');
          }
        } else {
          input += char;
          process.stdout.write('*');
        }
      };

      process.stdin.on('data', onData);
    } else {
      // Normal input
      const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      rl.question(displayQuestion, (answer) => {
        rl.close();
        resolve(answer.trim() || defaultValue);
      });
    }
  });
}

/**
 * Parses existing samconfig.toml and extracts parameter overrides
 */
function parseSamConfig() {
  const samConfigPath = join(BACKEND_DIR, 'samconfig.toml');

  if (!existsSync(samConfigPath)) {
    return null;
  }

  try {
    const content = readFileSync(samConfigPath, 'utf-8');
    const config = {
      stackName: '',
      region: '',
      s3Bucket: '',
      environment: '',
      openaiApiKey: '',
      deployRAGStack: 'true',
      adminEmail: '',
      ragstackEndpoint: '',
      ragstackApiKey: '',
    };

    // Extract stack_name
    const stackMatch = content.match(/stack_name\s*=\s*"([^"]+)"/);
    if (stackMatch) config.stackName = stackMatch[1];

    // Extract region
    const regionMatch = content.match(/region\s*=\s*"([^"]+)"/);
    if (regionMatch) config.region = regionMatch[1];

    // Extract s3_bucket
    const s3Match = content.match(/s3_bucket\s*=\s*"([^"]+)"/);
    if (s3Match) config.s3Bucket = s3Match[1];

    // Extract parameter_overrides - handle both array format [...] and string format "..."
    const arrayParamMatch = content.match(/parameter_overrides\s*=\s*\[([\s\S]*?)\]/);
    const stringParamMatch = content.match(/parameter_overrides\s*=\s*"([^"]+)"/);

    let params = '';
    if (arrayParamMatch) {
      // Array format: extract all quoted strings and join them
      const arrayContent = arrayParamMatch[1];
      const items = arrayContent.match(/"([^"]+)"/g);
      if (items) {
        params = items.map((s) => s.replace(/"/g, '')).join(' ');
      }
    } else if (stringParamMatch) {
      params = stringParamMatch[1];
    }

    if (params) {
      const envMatch = params.match(/Environment=(\S+)/);
      if (envMatch) config.environment = envMatch[1];

      const openaiMatch = params.match(/OpenAIApiKey=(\S+)/);
      if (openaiMatch) config.openaiApiKey = openaiMatch[1];

      const deployRAGStackMatch = params.match(/DeployRAGStack=(true|false)/);
      if (deployRAGStackMatch) config.deployRAGStack = deployRAGStackMatch[1];

      const adminEmailMatch = params.match(/AdminEmail=(\S+)/);
      if (adminEmailMatch) config.adminEmail = adminEmailMatch[1];

      const ragEndpointMatch = params.match(/RagstackGraphqlEndpoint=(\S+)/);
      if (ragEndpointMatch) config.ragstackEndpoint = ragEndpointMatch[1];

      const ragKeyMatch = params.match(/RagstackApiKey=(\S+)/);
      if (ragKeyMatch) config.ragstackApiKey = ragKeyMatch[1];
    }

    return config;
  } catch (error) {
    console.warn('⚠ Failed to parse existing samconfig.toml:', error.message);
    return null;
  }
}

/**
 * Loads existing configuration or returns defaults
 */
function loadConfig() {
  // First try to load from existing samconfig.toml (preserves secrets)
  const samConfig = parseSamConfig();
  if (samConfig && samConfig.stackName) {
    console.log('✓ Loaded existing configuration from backend/samconfig.toml');
    return samConfig;
  }

  // Fall back to .deploy-config.json
  const configPath = join(PROJECT_ROOT, CONFIG_FILE);

  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      console.log('✓ Loaded existing configuration from', CONFIG_FILE);
      return config;
    } catch (error) {
      console.warn('⚠ Failed to parse existing config, starting fresh');
    }
  }

  return {
    stackName: 'warmreach',
    region: 'us-east-1',  // Default to us-east-1 for Nova Multimodal Embeddings
    s3Bucket: '',
    environment: 'prod',
    openaiApiKey: '',
    deployRAGStack: 'true',  // New: deploy nested RAGStack
    adminEmail: '',  // New: admin email for RAGStack
    ragstackEndpoint: '',
    ragstackApiKey: '',
  };
}

/**
 * Saves configuration to file (excludes secrets)
 */
function saveConfig(config) {
  const configPath = join(PROJECT_ROOT, CONFIG_FILE);
  // Don't persist secrets to disk
  const safeConfig = {
    stackName: config.stackName,
    region: config.region,
    environment: config.environment,
  };
  writeFileSync(configPath, JSON.stringify(safeConfig, null, 2));
  console.log('✓ Configuration saved to', CONFIG_FILE);
}

/**
 * Gets AWS account ID
 */
function getAwsAccountId() {
  try {
    const result = execSync('aws sts get-caller-identity --query Account --output text', {
      encoding: 'utf-8',
    });
    return result.trim();
  } catch (error) {
    throw new Error('Failed to get AWS account ID. Ensure AWS CLI is configured.');
  }
}

/**
 * Validates AWS credentials
 */
function validateAwsCredentials() {
  console.log('\n🔐 Validating AWS credentials...');
  try {
    const identity = execSync('aws sts get-caller-identity --output json', {
      encoding: 'utf-8',
    });
    const parsed = JSON.parse(identity);
    console.log(`✓ Authenticated as: ${parsed.Arn}`);
    return true;
  } catch (error) {
    throw new Error('AWS credentials not configured or invalid. Run `aws configure` first.');
  }
}

/**
 * Validates SAM CLI is installed
 */
function validateSamCli() {
  console.log('\n🔧 Checking SAM CLI...');
  try {
    const version = execSync('sam --version', { encoding: 'utf-8' });
    console.log(`✓ SAM CLI: ${version.trim()}`);
    return true;
  } catch (error) {
    throw new Error('SAM CLI not found. Install from https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html');
  }
}

/**
 * Escapes a string for safe inclusion in TOML
 * Handles backslashes, double quotes, and special characters
 */
function escapeTomlValue(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/\\/g, '\\\\')  // Escape backslashes first
    .replace(/"/g, '\\"')    // Escape double quotes
    .replace(/\n/g, '\\n')   // Escape newlines
    .replace(/\r/g, '\\r')   // Escape carriage returns
    .replace(/\t/g, '\\t');  // Escape tabs
}

/**
 * Generates samconfig.toml for deployment
 */
function generateSamConfig(config, accountId) {
  const paramOverrides = [
    `Environment=${escapeTomlValue(config.environment)}`,
  ];

  if (config.openaiApiKey) {
    paramOverrides.push(`OpenAIApiKey=${escapeTomlValue(config.openaiApiKey)}`);
  }

  // RAGStack nested stack parameters
  if (config.deployRAGStack) {
    paramOverrides.push(`DeployRAGStack=${escapeTomlValue(config.deployRAGStack)}`);
  }
  if (config.adminEmail && config.deployRAGStack === 'true') {
    paramOverrides.push(`AdminEmail=${escapeTomlValue(config.adminEmail)}`);
  }

  // External RAGStack parameters (used only if DeployRAGStack=false)
  if (config.ragstackEndpoint && config.deployRAGStack === 'false') {
    paramOverrides.push(`RagstackGraphqlEndpoint=${escapeTomlValue(config.ragstackEndpoint)}`);
  }
  if (config.ragstackApiKey && config.deployRAGStack === 'false') {
    paramOverrides.push(`RagstackApiKey=${escapeTomlValue(config.ragstackApiKey)}`);
  }

  // Use existing s3_bucket or fall back to resolve_s3
  const s3Config = config.s3Bucket
    ? `s3_bucket = "${escapeTomlValue(config.s3Bucket)}"`
    : `resolve_s3 = true\ns3_prefix = "${escapeTomlValue(config.stackName)}"`;

  const samConfig = `# Auto-generated by deploy-sam.js
# Do not edit manually

version = 0.1

[default.deploy.parameters]
stack_name = "${escapeTomlValue(config.stackName)}"
${s3Config}
region = "${escapeTomlValue(config.region)}"
confirm_changeset = false
capabilities = "CAPABILITY_IAM CAPABILITY_AUTO_EXPAND"
parameter_overrides = "${paramOverrides.join(' ')}"
disable_rollback = false

[default.build.parameters]
cached = true
parallel = true
`;

  const samConfigPath = join(BACKEND_DIR, 'samconfig.toml');
  writeFileSync(samConfigPath, samConfig);
  console.log('✓ Generated samconfig.toml');
  return samConfigPath;
}

/**
 * Runs SAM build
 */
async function runSamBuild() {
  console.log('\n📦 Running SAM build...');

  return new Promise((resolve, reject) => {
    const proc = spawn('sam', ['build'], {
      cwd: BACKEND_DIR,
      stdio: 'inherit',
    });

    proc.on('close', (code) => {
      if (code === 0) {
        console.log('✓ SAM build completed');
        resolve();
      } else {
        reject(new Error(`SAM build failed with code ${code}`));
      }
    });

    proc.on('error', (error) => {
      reject(new Error(`Failed to start SAM build: ${error.message}`));
    });
  });
}

/**
 * Runs SAM deploy
 */
async function runSamDeploy() {
  console.log('\n🚀 Running SAM deploy...');

  return new Promise((resolve, reject) => {
    const proc = spawn('sam', ['deploy', '--no-confirm-changeset'], {
      cwd: BACKEND_DIR,
      stdio: 'inherit',
    });

    proc.on('close', (code) => {
      if (code === 0) {
        console.log('✓ SAM deploy completed');
        resolve();
      } else {
        reject(new Error(`SAM deploy failed with code ${code}`));
      }
    });

    proc.on('error', (error) => {
      reject(new Error(`Failed to start SAM deploy: ${error.message}`));
    });
  });
}

/**
 * Validates AWS stack name (alphanumeric, hyphens, underscores, 1-128 chars)
 */
function isValidStackName(name) {
  return /^[a-zA-Z0-9_-]{1,128}$/.test(name);
}

/**
 * Validates AWS region format (e.g., us-west-2, eu-central-1)
 */
function isValidRegion(region) {
  return /^[a-z]{2}-[a-z]+-\d{1}$/.test(region);
}

/**
 * Retrieves CloudFormation stack outputs
 */
function getStackOutputs(stackName, region) {
  console.log('\n📋 Retrieving stack outputs...');

  // Validate inputs to prevent shell injection
  if (!isValidStackName(stackName)) {
    throw new Error(`Invalid stack name: ${stackName}. Must be alphanumeric with hyphens/underscores, 1-128 chars.`);
  }
  if (!isValidRegion(region)) {
    throw new Error(`Invalid region: ${region}. Must be a valid AWS region (e.g., us-west-2).`);
  }

  try {
    const result = execSync(
      `aws cloudformation describe-stacks --stack-name ${stackName} --region ${region} --query "Stacks[0].Outputs" --output json`,
      { encoding: 'utf-8' }
    );

    const outputs = JSON.parse(result);
    const outputMap = {};

    for (const output of outputs) {
      outputMap[output.OutputKey] = output.OutputValue;
    }

    return outputMap;
  } catch (error) {
    throw new Error(`Failed to get stack outputs: ${error.message}`);
  }
}

/**
 * Updates or creates .env file with stack outputs
 */
function updateEnvFile(outputs, config) {
  const envPath = join(PROJECT_ROOT, '.env');
  let existingEnv = {};

  // Read existing .env if it exists
  if (existsSync(envPath)) {
    const content = readFileSync(envPath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        const [key, ...valueParts] = trimmed.split('=');
        if (key) {
          existingEnv[key] = valueParts.join('=');
        }
      }
    }
  }

  // Update with new values
  const updates = {
    VITE_API_GATEWAY_URL: outputs.ApiUrl || '',
    VITE_AWS_REGION: config.region,
    VITE_COGNITO_USER_POOL_ID: outputs.UserPoolId || '',
    VITE_COGNITO_USER_POOL_WEB_CLIENT_ID: outputs.UserPoolClientId || '',
    API_GATEWAY_BASE_URL: outputs.ApiUrl || '',
    AWS_REGION: config.region,
    DYNAMODB_TABLE: outputs.DynamoDBTableName || '',
  };

  // Add RAGStack outputs if deployed as nested stack
  if (config.deployRAGStack === 'true') {
    if (outputs.RAGStackGraphQLEndpoint) {
      updates.RAGSTACK_GRAPHQL_ENDPOINT = outputs.RAGStackGraphQLEndpoint;
    }
    if (outputs.RAGStackDashboardUrl) {
      updates.RAGSTACK_DASHBOARD_URL = outputs.RAGStackDashboardUrl;
    }
    // API key is injected into Lambda env vars from the nested stack output.
    // Retrieve it from a Lambda's configuration if needed for manual testing.
    console.log('\n📝 RAGStack deployed as nested stack. Retrieve API key from Lambda env vars:');
    console.log(`   aws lambda get-function-configuration --function-name linkedin-edge-processing-${config.environment || 'prod'} --query 'Environment.Variables.RAGSTACK_API_KEY' --output text`);
  }

  // Merge with existing
  const merged = { ...existingEnv, ...updates };

  // Write back
  const envContent = Object.entries(merged)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

  writeFileSync(envPath, envContent + '\n');
  console.log('✓ Environment variables written to .env');

  // Display updates
  console.log('\n📝 Updated .env with:');
  for (const [key, value] of Object.entries(updates)) {
    if (value) {
      console.log(`  ${key}=${value.substring(0, 50)}${value.length > 50 ? '...' : ''}`);
    }
  }
}

/**
 * Prompts for a secret with masked default display
 */
async function promptSecret(question, existingValue) {
  const maskedDefault = existingValue ? '***' : '';
  const displayQuestion = maskedDefault
    ? `${question} [${maskedDefault}]: `
    : `${question}: `;

  process.stdout.write(displayQuestion);
  let input = '';

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();
  process.stdin.setEncoding('utf8');

  return new Promise((resolve) => {
    const onData = (char) => {
      if (char === '\n' || char === '\r') {
        process.stdin.setRawMode && process.stdin.setRawMode(false);
        process.stdin.removeListener('data', onData);
        process.stdin.pause();
        process.stdout.write('\n');
        // If empty input, keep existing value
        resolve(input.trim() || existingValue || '');
      } else if (char === '\u0003') {
        // Ctrl+C
        process.exit(1);
      } else if (char === '\u007F' || char === '\b') {
        // Backspace
        if (input.length > 0) {
          input = input.slice(0, -1);
          process.stdout.write('\b \b');
        }
      } else {
        input += char;
        process.stdout.write('*');
      }
    };

    process.stdin.on('data', onData);
  });
}

/**
 * Prompts for configuration values
 */
async function collectConfiguration(config) {
  console.log('\n📝 SAM Deployment Configuration\n');

  // Collect and validate stack name
  config.stackName = await prompt('Stack name', config.stackName);
  if (!isValidStackName(config.stackName)) {
    throw new Error(`Invalid stack name: "${config.stackName}". Must be alphanumeric with hyphens/underscores, 1-128 chars.`);
  }

  // Collect and validate region
  config.region = await prompt('AWS region', config.region);
  if (!isValidRegion(config.region)) {
    throw new Error(`Invalid region: "${config.region}". Must be a valid AWS region (e.g., us-west-2).`);
  }

  config.environment = await prompt('Environment (dev/prod)', config.environment);

  // RAGStack deployment option
  console.log('\n🔍 RAGStack Integration (semantic search for profiles)\n');
  const deployChoice = await prompt('Deploy RAGStack as nested stack? (true/false)', config.deployRAGStack);
  config.deployRAGStack = deployChoice.toLowerCase() === 'true' ? 'true' : 'false';

  if (config.deployRAGStack === 'true') {
    // Nested stack deployment - need admin email
    console.log('\n📧 RAGStack Configuration (nested stack)\n');
    config.adminEmail = await prompt('Admin email for RAGStack', config.adminEmail || '');

    // Validate email if provided
    if (config.adminEmail && !config.adminEmail.match(/^[\w.+-]+@([\w-]+\.)+[\w-]{2,6}$/)) {
      throw new Error(`Invalid email format: ${config.adminEmail}`);
    }
  } else {
    // External RAGStack - need endpoint and API key
    console.log('\n🔗 External RAGStack Configuration\n');

    // Check for .env.ragstack file first
    const ragstackEnvPath = join(PROJECT_ROOT, '.env.ragstack');
    if (existsSync(ragstackEnvPath)) {
      console.log('✓ Found .env.ragstack - loading external RAGStack configuration');
      const ragstackEnv = readFileSync(ragstackEnvPath, 'utf-8');

      const cleanEnvValue = (value) => {
        const trimmed = value.trim();
        return trimmed.replace(/^["']|["']$/g, '');
      };

      for (const line of ragstackEnv.split('\n')) {
        if (line.startsWith('RAGSTACK_GRAPHQL_ENDPOINT=')) {
          config.ragstackEndpoint = cleanEnvValue(line.substring(line.indexOf('=') + 1));
        }
        if (line.startsWith('RAGSTACK_API_KEY=')) {
          config.ragstackApiKey = cleanEnvValue(line.substring(line.indexOf('=') + 1));
        }
      }
    } else {
      config.ragstackEndpoint = await prompt('RAGStack GraphQL endpoint', config.ragstackEndpoint || '');
      config.ragstackApiKey = await promptSecret('RAGStack API key', config.ragstackApiKey);
    }
  }

  console.log('\n📦 Optional: API Keys (press Enter to keep existing)\n');
  config.openaiApiKey = await promptSecret('OpenAI API key', config.openaiApiKey);

  return config;
}

/**
 * Check for --dry-run flag
 */
function isDryRun() {
  return process.argv.includes('--dry-run');
}

/**
 * Main deployment flow
 */
async function main() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║            WarmReach - SAM Deployment                     ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  try {
    // Load existing configuration (from samconfig.toml or .deploy-config.json)
    let config = loadConfig();

    // Always prompt for configuration, using existing values as defaults
    config = await collectConfiguration(config);

    // Validate prerequisites
    validateAwsCredentials();
    const accountId = getAwsAccountId();
    validateSamCli();

    // Save configuration (non-secrets only)
    saveConfig(config);

    // Generate SAM config
    generateSamConfig(config, accountId);

    if (isDryRun()) {
      console.log('\n🔍 Dry run mode - skipping actual deployment');
      console.log('✓ Configuration validated');
      console.log('✓ samconfig.toml generated');
      return;
    }

    // Build and deploy
    await runSamBuild();
    await runSamDeploy();

    // Capture outputs
    const outputs = getStackOutputs(config.stackName, config.region);
    updateEnvFile(outputs, config);

    console.log('\n╔════════════════════════════════════════════════════════════╗');
    console.log('║                  Deployment Complete!                       ║');
    console.log('╚════════════════════════════════════════════════════════════╝\n');

    console.log('Stack Name:', config.stackName);
    console.log('Region:', config.region);
    console.log('Environment:', config.environment);
    console.log('\nAPI URL:', outputs.ApiUrl);
    console.log('\nNext steps:');
    console.log('1. Start frontend: npm run dev');
    console.log('2. Start client backend: npm run dev:client');
  } catch (error) {
    console.error('\n❌ Deployment failed:', error.message);
    process.exit(1);
  }
}

// Run if executed directly
main();
