#!/usr/bin/env node
/**
 * WarmReach SAM Deployment
 *
 * One-shot backend deploy:
 *   - Runs pre-flight checks (AWS creds, SAM CLI, Docker, Bedrock access, SES, concurrency)
 *   - Prompts for all template inputs; stores secrets as SSM SecureStrings and passes ARNs
 *   - Generates samconfig.toml
 *   - Runs `sam build --use-container` + `sam deploy`
 *   - Captures stack outputs into root .env, frontend/.env, admin/.env
 *   - Prints manual next-step instructions for frontend/admin deploys
 *
 * Region is pinned to us-east-1 (CloudFront/ACM, Bedrock cross-region inference,
 * and the RAGStack nested stack all require it).
 */

import { execSync, spawn } from 'child_process';
import { createInterface } from 'readline';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { resolve, join, dirname } from 'path';
import { fileURLToPath } from 'url';

// ----------------------------------------------------------------------------
// Constants
// ----------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = resolve(__dirname, '..', '..');
const BACKEND_DIR = join(PROJECT_ROOT, 'backend');

const REGION = 'us-east-1';
const CLAUDE_MODEL_ID = 'us.anthropic.claude-sonnet-4-5-20250929-v1:0';
const CONFIG_FILE = join(PROJECT_ROOT, '.deploy-config.json');
const SAMCONFIG_FILE = join(BACKEND_DIR, 'samconfig.toml');

const DRY_RUN = process.argv.includes('--dry-run');

// ----------------------------------------------------------------------------
// IO helpers
// ----------------------------------------------------------------------------

function exec(cmd, { quiet = false, ignoreError = false } = {}) {
  try {
    return execSync(cmd, { encoding: 'utf-8', stdio: quiet ? 'pipe' : 'inherit' });
  } catch (err) {
    if (ignoreError) return '';
    throw err;
  }
}

function execCapture(cmd) {
  return execSync(cmd, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function streamExec(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { cwd, stdio: 'inherit' });
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
    proc.on('error', reject);
  });
}

function prompt(question, defaultValue = '') {
  const display = defaultValue ? `${question} [${defaultValue}]: ` : `${question}: `;
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(display, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultValue);
    });
  });
}

function promptSecret(question, hasExisting = false) {
  const display = hasExisting ? `${question} [***, Enter to keep]: ` : `${question} (Enter to skip): `;
  process.stdout.write(display);
  return new Promise((resolve) => {
    let input = '';
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    const onData = (ch) => {
      if (ch === '\n' || ch === '\r') {
        if (process.stdin.isTTY) process.stdin.setRawMode(false);
        process.stdin.removeListener('data', onData);
        process.stdin.pause();
        process.stdout.write('\n');
        resolve(input);
      } else if (ch === '\x03') {
        process.exit(1);
      } else if (ch === '\x7f' || ch === '\b') {
        if (input.length > 0) {
          input = input.slice(0, -1);
          process.stdout.write('\b \b');
        }
      } else {
        input += ch;
        process.stdout.write('*');
      }
    };
    process.stdin.on('data', onData);
  });
}

function banner(title) {
  const line = '═'.repeat(60);
  console.log(`\n${line}\n${title}\n${line}`);
}

function ok(msg) {
  console.log(`  ✓ ${msg}`);
}

function warn(msg) {
  console.log(`  ⚠ ${msg}`);
}

function fail(msg) {
  console.error(`  ✗ ${msg}`);
  process.exit(1);
}

// ----------------------------------------------------------------------------
// Config load/save (non-secret defaults only)
// ----------------------------------------------------------------------------

function defaults() {
  return {
    stackName: 'warmreach',
    environment: 'prod',
    sesVerifiedEmail: '',
    alarmNotificationEmail: '',
    adminEmail: '',
    adminUserSub: '',
    deployRAGStack: 'true',
    ragstackEndpoint: '',
    productionOrigins: '',
    includeDevOrigins: 'true',
    enableDigests: 'false',
    // Desktop client download URLs (https:// or s3://bucket/key — leave blank
    // for "coming soon"; can be updated by re-running deploy without a
    // frontend rebuild)
    clientDownloadMacUrl: '',
    clientDownloadWinUrl: '',
    clientDownloadLinuxUrl: '',
    clientDownloadVersion: '',
    // Secret ARNs (populated from SSM PutParameter output; safe to persist)
    openaiApiKeyArn: '',
    stripeSecretKeyArn: '',
    stripeWebhookSecretArn: '',
  };
}

function loadConfig() {
  if (!existsSync(CONFIG_FILE)) return defaults();
  try {
    return { ...defaults(), ...JSON.parse(readFileSync(CONFIG_FILE, 'utf-8')) };
  } catch {
    warn('.deploy-config.json could not be parsed, using defaults');
    return defaults();
  }
}

function saveConfig(config) {
  // Persist everything except raw secret values. ARN-backed secrets are
  // safe (the value lives in SSM SecureString). The external-RAGStack
  // API key is the one plaintext secret in this flow — strip it from
  // the on-disk config so a $WORKDIR/.deploy-config.json leak doesn't
  // expose it. The user is prompted for it again on each deploy when
  // deployRAGStack=false.
  const { ragstackApiKey: _unused, ...safeConfig } = config;
  void _unused;
  writeFileSync(CONFIG_FILE, JSON.stringify(safeConfig, null, 2));
  ok(`Saved ${CONFIG_FILE}`);
}

// ----------------------------------------------------------------------------
// Pre-flight checks
// ----------------------------------------------------------------------------

function checkAwsCli() {
  try {
    const identity = JSON.parse(execCapture('aws sts get-caller-identity --output json'));
    ok(`AWS: ${identity.Arn}`);
    return identity.Account;
  } catch {
    fail('AWS CLI not configured. Run `aws configure` first.');
  }
}

function checkSamCli() {
  try {
    const v = execCapture('sam --version');
    ok(`SAM CLI: ${v}`);
  } catch {
    fail('SAM CLI not installed. See https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html');
  }
}

function checkDocker() {
  try {
    execCapture('docker info');
    ok('Docker running (required for sam build --use-container)');
  } catch {
    fail('Docker is not running. Start Docker Desktop or the docker daemon.');
  }
}

function checkBedrockAccess() {
  // us.* IDs are system-defined cross-region inference profiles; the
  // underlying foundation model (without the prefix) is what model-access
  // grants operate on. Query both so we fail soft on either path.
  const isInferenceProfile = CLAUDE_MODEL_ID.startsWith('us.');
  const underlying = CLAUDE_MODEL_ID.replace(/^us\./, '');
  try {
    if (isInferenceProfile) {
      const profiles = execCapture(
        `aws bedrock list-inference-profiles --region ${REGION} --type-equals SYSTEM_DEFINED ` +
          `--query "inferenceProfileSummaries[?inferenceProfileId=='${CLAUDE_MODEL_ID}'].inferenceProfileId" --output text`,
      );
      if (profiles) {
        ok(`Bedrock inference profile available: ${CLAUDE_MODEL_ID}`);
        return;
      }
    }
    const fm = execCapture(
      `aws bedrock list-foundation-models --region ${REGION} ` +
        `--query "modelSummaries[?modelId=='${underlying}'].modelId" --output text`,
    );
    if (fm) {
      ok(`Bedrock foundation model visible: ${underlying}`);
    } else {
      warn(`Bedrock model not visible in account: ${CLAUDE_MODEL_ID}`);
      warn('Request access at: https://us-east-1.console.aws.amazon.com/bedrock/home#/modelaccess');
      warn('Lambda will fail on first invoke until access is granted.');
    }
  } catch {
    warn('Could not query Bedrock. Skipping model-access check.');
  }
}

function checkLambdaConcurrency() {
  try {
    const out = execCapture(
      `aws service-quotas get-service-quota --service-code lambda --quota-code L-B99A9384 ` +
        `--region ${REGION} --query "Quota.Value" --output text`,
    );
    const limit = parseFloat(out);
    if (Number.isFinite(limit) && limit < 200) {
      warn(
        `Lambda unreserved concurrency limit is ${limit}. Template reserves ~150; request a limit increase if you hit throttling.`,
      );
    } else {
      ok(`Lambda concurrency headroom: ${limit}`);
    }
  } catch {
    warn('Could not check Lambda concurrency quota.');
  }
}

function checkSesIdentity(email) {
  if (!email) return;
  try {
    const out = execCapture(
      `aws ses get-identity-verification-attributes --region ${REGION} --identities ${email} --output json`,
    );
    const parsed = JSON.parse(out);
    const status = parsed?.VerificationAttributes?.[email]?.VerificationStatus;
    if (status === 'Success') {
      ok(`SES identity verified: ${email}`);
    } else {
      warn(`SES identity ${email} status: ${status || 'not found'}. Verify in SES console before enabling digests.`);
      warn('If SES is in sandbox mode, recipients must also be verified until a production-access request is approved.');
    }
  } catch {
    warn('Could not check SES identity.');
  }
}

function checkRagstackTemplateUrl(deployRAGStack) {
  if (deployRAGStack !== 'true') return;
  const url = 'https://ragstack-quicklaunch-public.s3.us-east-1.amazonaws.com/ragstack-template.yaml';
  try {
    const code = execCapture(`curl -sS -o /dev/null -w "%{http_code}" "${url}"`);
    if (code === '200') {
      ok(`RAGStack nested-stack template reachable: ${url}`);
    } else {
      warn(`RAGStack template URL returned HTTP ${code}: ${url}`);
      warn('Nested stack will fail. Override RagstackTemplateUrl or set DeployRAGStack=false.');
    }
  } catch {
    warn('Could not reach the RAGStack template URL. Nested stack may fail.');
  }
}

function checkDomainWarning() {
  warn(
    'No custom domain configured. Stack will issue *.execute-api, *.cloudfront.net, and whatever your Amplify apps use. Revisit once a domain is purchased.',
  );
}

async function ensureDeployBucket(account) {
  // S3 bucket names are globally unique; include the account ID so multiple
  // deployers in different accounts do not collide.
  const bucketName = `sam-deploy-warmreach-${account}-${REGION}`;
  try {
    execCapture(`aws s3 ls s3://${bucketName} --region ${REGION}`);
    ok(`Deploy bucket exists: ${bucketName}`);
  } catch {
    try {
      exec(`aws s3 mb s3://${bucketName} --region ${REGION}`, { quiet: true });
      ok(`Created deploy bucket: ${bucketName}`);
    } catch (err) {
      fail(`Could not create deploy bucket ${bucketName}: ${err.message}`);
    }
  }
  return bucketName;
}

// ----------------------------------------------------------------------------
// SSM SecureString flow
// ----------------------------------------------------------------------------

function ssmParamName(stackName, key) {
  return `/warmreach/${stackName}/${key}`;
}

async function ensureUnsubscribeSecret(environment) {
  // The template's UNSUBSCRIBE_SECRET env var resolves
  // /warmreach/${Environment}/unsubscribe-secret at deploy time. Note the
  // path uses ${Environment} (e.g. 'prod'), NOT the user-chosen stackName,
  // because CFN dynamic refs can't compose stack-name into the path.
  const paramPath = `/warmreach/${environment}/unsubscribe-secret`;
  try {
    execCapture(
      `aws ssm get-parameter --region ${REGION} --name ${paramPath} --with-decryption --query "Parameter.Name" --output text`,
    );
    ok(`Unsubscribe secret already present: ${paramPath}`);
    return;
  } catch {
    /* not found — create */
  }
  // 32 random bytes -> base64 (43 chars, > 256 bits of entropy)
  const { randomBytes } = await import('node:crypto');
  const value = randomBytes(32).toString('base64');
  putSsmSecureString(paramPath, value);
  ok(`Generated unsubscribe secret: ${paramPath}`);
}

function ssmParamArn(account, name) {
  // SSM ARN shape: arn:aws:ssm:<region>:<account>:parameter<name>
  // Name includes the leading slash, which must not be duplicated.
  return `arn:aws:ssm:${REGION}:${account}:parameter${name}`;
}

function putSsmSecureString(name, value) {
  // Use --cli-input-json to avoid shell-escape issues on arbitrary secret characters.
  const payload = JSON.stringify({
    Name: name,
    Value: value,
    Type: 'SecureString',
    Overwrite: true,
    Tier: 'Standard',
  });
  // Write payload to a temp file to avoid command-line size issues and argument logging.
  const tmp = `/tmp/warmreach-ssm-${Date.now()}.json`;
  writeFileSync(tmp, payload, { mode: 0o600 });
  try {
    exec(`aws ssm put-parameter --region ${REGION} --cli-input-json file://${tmp}`, { quiet: true });
  } finally {
    try {
      execCapture(`rm -f ${tmp}`);
    } catch {
      /* ignore */
    }
  }
}

async function ensureSecret({ label, key, existingArn, account, stackName }) {
  const hasExisting = !!existingArn;
  const value = await promptSecret(`${label}`, hasExisting);
  if (!value) {
    // User left blank: keep whatever ARN we had (possibly empty).
    return existingArn;
  }
  const name = ssmParamName(stackName, key);
  putSsmSecureString(name, value);
  const arn = ssmParamArn(account, name);
  ok(`Stored ${label} in SSM: ${name}`);
  return arn;
}

// ----------------------------------------------------------------------------
// Collect config
// ----------------------------------------------------------------------------

async function collectConfig(existing, account) {
  banner('Configuration');

  const config = { ...existing };

  config.stackName = await prompt('Stack name', existing.stackName);
  if (!/^[a-zA-Z0-9-]{1,128}$/.test(config.stackName)) {
    fail(`Invalid stack name: ${config.stackName} (alphanumeric + hyphen, 1-128 chars)`);
  }

  config.environment = await prompt('Environment (dev/prod)', existing.environment);

  banner('Secrets (stored as SSM SecureString, only ARN kept in samconfig)');

  config.openaiApiKeyArn = await ensureSecret({
    label: 'OpenAI API key',
    key: 'openai-api-key',
    existingArn: existing.openaiApiKeyArn,
    account,
    stackName: config.stackName,
  });

  config.stripeSecretKeyArn = await ensureSecret({
    label: 'Stripe secret key (blank to deploy without Stripe)',
    key: 'stripe-secret-key',
    existingArn: existing.stripeSecretKeyArn,
    account,
    stackName: config.stackName,
  });

  config.stripeWebhookSecretArn = await ensureSecret({
    label: 'Stripe webhook signing secret (blank on first deploy; register URL with Stripe then re-run)',
    key: 'stripe-webhook-secret',
    existingArn: existing.stripeWebhookSecretArn,
    account,
    stackName: config.stackName,
  });

  banner('Operational settings');

  config.sesVerifiedEmail = await prompt('SES verified sender email (blank to skip)', existing.sesVerifiedEmail);
  config.alarmNotificationEmail = await prompt(
    'CloudWatch alarm notification email (blank to skip)',
    existing.alarmNotificationEmail,
  );
  config.adminEmail = await prompt('Admin email (RAGStack + admin dashboard)', existing.adminEmail);
  config.adminUserSub = await prompt(
    'Admin user Cognito sub (fill in on second deploy after first sign-up)',
    existing.adminUserSub,
  );
  config.deployRAGStack = await prompt('Deploy RAGStack nested stack? (true/false)', existing.deployRAGStack);

  // External RAGStack path — only used when deployRAGStack=false. Prompted
  // every deploy (the API key is NOT persisted to .deploy-config.json; the
  // template still takes the key as a NoEcho plaintext parameter. Migrating
  // this to the SSM ARN pattern would require template + Lambda changes in
  // 3 functions — tracked separately).
  config.ragstackApiKey = '';
  if (config.deployRAGStack === 'false') {
    config.ragstackEndpoint = await prompt(
      'External RAGStack GraphQL endpoint',
      existing.ragstackEndpoint,
    );
    config.ragstackApiKey = await promptSecret('External RAGStack API key', false);
    if (!config.ragstackEndpoint || !config.ragstackApiKey) {
      warn('External RAGStack endpoint or API key missing — the stack will deploy with empty values and RAGStack-dependent features will fail at runtime.');
    }
  } else {
    config.ragstackEndpoint = '';
  }

  config.productionOrigins = await prompt(
    'Production CORS origins (comma-separated, blank if none)',
    existing.productionOrigins,
  );
  config.includeDevOrigins = await prompt('Include localhost origins in CORS? (true/false)', existing.includeDevOrigins);
  config.enableDigests = await prompt(
    'Enable weekly digest lambdas? (true/false; requires SES email)',
    existing.enableDigests,
  );

  banner('Desktop client downloads (blank = "coming soon")');
  console.log(
    '  URLs accept either https:// (e.g. GitHub Releases asset)\n' +
      '  or s3://bucket/key (Lambda mints a 5-min presigned URL on each request).\n',
  );
  config.clientDownloadMacUrl = await prompt('macOS download URL', existing.clientDownloadMacUrl);
  config.clientDownloadWinUrl = await prompt('Windows download URL', existing.clientDownloadWinUrl);
  config.clientDownloadLinuxUrl = await prompt(
    'Linux download URL',
    existing.clientDownloadLinuxUrl,
  );
  config.clientDownloadVersion = await prompt(
    'Version label (optional, shown next to download buttons)',
    existing.clientDownloadVersion,
  );

  return config;
}

// ----------------------------------------------------------------------------
// samconfig.toml generation
// ----------------------------------------------------------------------------

function buildParamOverrides(config) {
  const pairs = [];
  const push = (k, v) => {
    if (v !== undefined && v !== null && v !== '') pairs.push([k, String(v)]);
  };
  push('Environment', config.environment);
  push('IncludeDevOrigins', config.includeDevOrigins);
  push('ProductionOrigins', config.productionOrigins);
  push('DeployRAGStack', config.deployRAGStack);
  push('AdminEmail', config.adminEmail);
  push('SESVerifiedEmail', config.sesVerifiedEmail);
  push('AlarmNotificationEmail', config.alarmNotificationEmail);
  push('AdminUserSub', config.adminUserSub);
  push('EnableDigests', config.enableDigests);
  push('OpenAIApiKeyArn', config.openaiApiKeyArn);
  push('StripeSecretKeyArn', config.stripeSecretKeyArn);
  push('StripeWebhookSecretArn', config.stripeWebhookSecretArn);
  // External RAGStack — only when deployRAGStack=false. Plaintext NoEcho param
  // until we migrate to SSM ARN pattern.
  push('RagstackGraphqlEndpoint', config.ragstackEndpoint);
  push('RagstackApiKey', config.ragstackApiKey);
  // Desktop client download URLs.
  push('ClientDownloadMacUrl', config.clientDownloadMacUrl);
  push('ClientDownloadWinUrl', config.clientDownloadWinUrl);
  push('ClientDownloadLinuxUrl', config.clientDownloadLinuxUrl);
  push('ClientDownloadVersion', config.clientDownloadVersion);
  return pairs;
}

function generateSamConfig(config, deployBucket) {
  const overrides = buildParamOverrides(config)
    .map(
      ([k, v]) =>
        // Escape backslash first, then double quotes — TOML treats both
        // as escapable characters and we'd otherwise corrupt secrets
        // containing either (e.g., "foo\bar" or 'a"b').
        `    "${k}=${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`,
    )
    .join(',\n');

  const content = `# Generated by scripts/deploy/deploy-sam.js — do not edit by hand.
version = 0.1

[default.deploy.parameters]
stack_name = "${config.stackName}"
s3_bucket = "${deployBucket}"
s3_prefix = "${config.stackName}"
region = "${REGION}"
capabilities = "CAPABILITY_IAM CAPABILITY_NAMED_IAM CAPABILITY_AUTO_EXPAND"
confirm_changeset = false
fail_on_empty_changeset = false
parameter_overrides = [
${overrides}
]

[default.build.parameters]
cached = true
parallel = true
use_container = true
`;
  writeFileSync(SAMCONFIG_FILE, content);
  ok(`Generated ${SAMCONFIG_FILE}`);
}

// ----------------------------------------------------------------------------
// Build + deploy
// ----------------------------------------------------------------------------

async function runSamBuild() {
  banner('sam build --use-container');
  await streamExec('sam', ['build', '--use-container'], BACKEND_DIR);
}

async function runSamDeploy() {
  banner('sam deploy');
  // confirm_changeset=false is set in samconfig.toml, no CLI flag needed.
  await streamExec('sam', ['deploy'], BACKEND_DIR);
}

// ----------------------------------------------------------------------------
// Stack outputs → env files
// ----------------------------------------------------------------------------

function getStackOutputs(stackName) {
  const raw = execCapture(
    `aws cloudformation describe-stacks --region ${REGION} --stack-name ${stackName} --query "Stacks[0].Outputs" --output json`,
  );
  const arr = JSON.parse(raw);
  const map = {};
  for (const o of arr) map[o.OutputKey] = o.OutputValue;
  return map;
}

function readEnvFile(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq > 0) out[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return out;
}

function writeEnvFile(path, updates, { preserveExisting = true } = {}) {
  const existing = preserveExisting ? readEnvFile(path) : {};
  const merged = { ...existing };
  for (const [k, v] of Object.entries(updates)) {
    if (v !== undefined && v !== null && v !== '') merged[k] = v;
  }
  const body = Object.entries(merged)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  writeFileSync(path, body + '\n');
  ok(`Wrote ${path}`);
}

function writeThreeEnvFiles(outputs) {
  const apiUrl = outputs.ApiUrl || '';
  const userPoolId = outputs.UserPoolId || '';
  const clientId = outputs.UserPoolClientId || '';
  const wsUrl = outputs.WebSocketApiUrl || '';
  const ddbTable = outputs.DynamoDBTableName || '';
  const issuer = userPoolId ? `https://cognito-idp.${REGION}.amazonaws.com/${userPoolId}` : '';

  // Root .env — serves client/Express backend + legacy frontend lookup.
  writeEnvFile(join(PROJECT_ROOT, '.env'), {
    VITE_API_GATEWAY_URL: apiUrl,
    VITE_COGNITO_USER_POOL_ID: userPoolId,
    VITE_COGNITO_USER_POOL_WEB_CLIENT_ID: clientId,
    VITE_WEBSOCKET_URL: wsUrl,
    VITE_AWS_REGION: REGION,
    API_GATEWAY_BASE_URL: apiUrl,
    AWS_REGION: REGION,
    DYNAMODB_TABLE: ddbTable,
    COGNITO_ISSUER: issuer,
    COGNITO_CLIENT_ID: clientId,
  });

  // frontend/.env — web app (Vite picks up from workspace dir).
  writeEnvFile(join(PROJECT_ROOT, 'frontend', '.env'), {
    VITE_API_GATEWAY_URL: apiUrl,
    VITE_COGNITO_USER_POOL_ID: userPoolId,
    VITE_COGNITO_USER_POOL_WEB_CLIENT_ID: clientId,
    VITE_WEBSOCKET_URL: wsUrl,
    VITE_AWS_REGION: REGION,
  });

  // admin/.env — admin dashboard (matches admin/.env.example keys exactly).
  writeEnvFile(join(PROJECT_ROOT, 'admin', '.env'), {
    VITE_API_GATEWAY_URL: apiUrl,
    VITE_COGNITO_USER_POOL_ID: userPoolId,
    VITE_COGNITO_USER_POOL_WEB_CLIENT_ID: clientId,
  });
}

// ----------------------------------------------------------------------------
// Handoff
// ----------------------------------------------------------------------------

function printHandoff(outputs, config) {
  const apiUrl = outputs.ApiUrl || '(unknown)';
  const webhookUrl = `${apiUrl.replace(/\/$/, '')}/webhooks/stripe`;

  banner('Next steps (manual)');
  console.log(`
  Frontend:
    cd frontend && npm run build
    aws s3 cp --recursive dist/ s3://<your-frontend-s3-bucket>/
    (trigger Amplify deployment in console if not auto-polling)

  Admin dashboard:
    cd admin && npm run build
    aws s3 cp --recursive dist/ s3://<your-admin-s3-bucket>/
    (trigger Amplify deployment in console if not auto-polling)

  Stripe webhook URL (register in Stripe dashboard, then re-run this script to
  provide the signing secret):
    ${webhookUrl}

  Outputs written to:
    .env             (root — client/Electron backend)
    frontend/.env    (web app)
    admin/.env       (admin dashboard)
  `);

  if (!config.stripeWebhookSecretArn) {
    warn('Stripe webhook secret was empty. Stripe-dependent lambdas are conditional on StripeSecretKeyArn — re-deploy after registering the webhook URL.');
  }
  if (config.enableDigests === 'true' && !config.sesVerifiedEmail) {
    warn('EnableDigests=true but no SESVerifiedEmail — digest lambdas will not be created.');
  }
}

// ----------------------------------------------------------------------------
// main
// ----------------------------------------------------------------------------

async function main() {
  banner('WarmReach — SAM Deploy');
  console.log(`  Region: ${REGION} (pinned)`);
  console.log(`  Dry run: ${DRY_RUN ? 'yes' : 'no'}`);

  banner('Pre-flight checks');
  const account = checkAwsCli();
  checkSamCli();
  checkDocker();
  checkBedrockAccess();
  checkLambdaConcurrency();
  checkDomainWarning();

  const existing = loadConfig();
  const config = await collectConfig(existing, account);

  if (config.sesVerifiedEmail) {
    banner('SES identity');
    checkSesIdentity(config.sesVerifiedEmail);
  }

  banner('RAGStack template reachability');
  checkRagstackTemplateUrl(config.deployRAGStack);

  // The digest unsubscribe secret is referenced via dynamic SSM resolution
  // in the template (DigestPerUserFunction's UNSUBSCRIBE_SECRET env var).
  // CloudFormation resolves it at deploy time, so the parameter MUST exist
  // before `sam deploy` runs when EnableDigests=true. Generate one if
  // missing — the value is opaque to operators (used for HMAC-signing
  // unsubscribe links), so auto-creation is the right ergonomic.
  if (config.enableDigests === 'true') {
    await ensureUnsubscribeSecret(config.environment);
  }

  saveConfig(config);

  const deployBucket = await ensureDeployBucket(account);
  generateSamConfig(config, deployBucket);

  if (DRY_RUN) {
    banner('Dry run complete');
    console.log(`  samconfig.toml written. No AWS state changed beyond SSM secret writes.`);
    return;
  }

  await runSamBuild();
  await runSamDeploy();

  banner('Fetching stack outputs');
  const outputs = getStackOutputs(config.stackName);
  for (const [k, v] of Object.entries(outputs)) {
    const shown = v.length > 60 ? `${v.slice(0, 60)}…` : v;
    console.log(`  ${k} = ${shown}`);
  }

  banner('Writing env files');
  writeThreeEnvFiles(outputs);

  // The admin-metrics Lambda needs HTTP_API_ID for narrow CloudWatch
  // metrics, but referencing it via !Ref HttpApi in the template creates
  // a circular dependency in CFN. Populate it post-deploy here.
  //
  // update-function-configuration --environment REPLACES the env block, so
  // we read the current vars first and merge HTTP_API_ID in. Otherwise we
  // wipe ALLOWED_ORIGINS / DYNAMODB_TABLE_NAME / LOG_LEVEL injected via
  // SAM Globals.
  if (config.adminUserSub && outputs.ApiUrl) {
    const apiId = outputs.ApiUrl.match(/https:\/\/([^.]+)\./)?.[1];
    if (apiId) {
      try {
        const fnName = `warmreach-admin-metrics-${config.environment}`;
        const currentJson = execCapture(
          `aws lambda get-function-configuration --region ${REGION} --function-name ${fnName} --query "Environment.Variables" --output json`,
        );
        const current = JSON.parse(currentJson);
        const merged = { ...current, HTTP_API_ID: apiId };
        // Pass via JSON file to avoid shell-escaping issues with values that
        // contain commas (ALLOWED_ORIGINS) or other special chars.
        const tmp = `/tmp/warmreach-lambda-env-${Date.now()}.json`;
        writeFileSync(tmp, JSON.stringify({ Variables: merged }), { mode: 0o600 });
        execCapture(
          `aws lambda update-function-configuration --region ${REGION} --function-name ${fnName} --environment file://${tmp}`,
        );
        try { execCapture(`rm -f ${tmp}`); } catch { /* ignore */ }
        ok(`Populated HTTP_API_ID=${apiId} on ${fnName} (preserved ${Object.keys(current).length} other vars)`);
      } catch (e) {
        warn(`Could not populate HTTP_API_ID on admin-metrics Lambda: ${e.message}`);
      }
    }
  }

  printHandoff(outputs, config);
  banner('Deployment complete');
}

main().catch((err) => {
  console.error('\n✗ Deployment failed:', err.message);
  process.exit(1);
});
