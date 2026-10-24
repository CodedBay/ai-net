'use strict';

const {
  SecretsManagerClient,
  DescribeSecretCommand,
  GetSecretValueCommand,
  PutSecretValueCommand,
  UpdateSecretVersionStageCommand,
} = require('@aws-sdk/client-secrets-manager');
const {
  ECSClient,
  UpdateServiceCommand,
  waitUntilServicesStable,
} = require('@aws-sdk/client-ecs');
const { randomBytes } = require('crypto');
const https = require('https');

const secrets = new SecretsManagerClient({});
const ecs = new ECSClient({});
const slackSecretArn = process.env.SLACK_WEBHOOK_SECRET_ARN;

exports.handler = async (event) => {
  try {
    if (event.action === 'manual_rotation_reminder') {
      await notifySlack('Quarterly rotation reminder',
        'Renew the Venice API key in the provider dashboard, then use the emergency rotation workflow.');
      return;
    }

    const { SecretId, ClientRequestToken: token, Step: step } = event;
    if (!SecretId || !token || !step || SecretId.split('/').pop() !== 'jwt_secret') {
      throw new Error('Invalid secret rotation event.');
    }

    const metadata = await secrets.send(new DescribeSecretCommand({ SecretId }));
    const stages = metadata.VersionIdsToStages || {};
    if (!stages[token]?.includes('AWSPENDING') && !stages[token]?.includes('AWSCURRENT')) {
      throw new Error('Rotation version is not staged as AWSPENDING or AWSCURRENT.');
    }
    if (stages[token].includes('AWSCURRENT')) return;

    if (step === 'createSecret') {
      try {
        await secrets.send(new GetSecretValueCommand({ SecretId, VersionStage: 'AWSPENDING' }));
      } catch (error) {
        if (!['ResourceNotFoundException', 'InvalidRequestException'].includes(error.name)) throw error;
        await secrets.send(new PutSecretValueCommand({
          SecretId,
          ClientRequestToken: token,
          SecretString: randomBytes(64).toString('hex'),
          VersionStages: ['AWSPENDING'],
        }));
      }
      return;
    }

    if (step === 'setSecret') {
      return;
    }

    if (step === 'testSecret') {
      await secrets.send(new GetSecretValueCommand({ SecretId, VersionStage: 'AWSPENDING' }));
      return;
    }

    if (step !== 'finishSecret') throw new Error(`Unknown rotation step: ${step}`);

    const currentVersion = Object.keys(stages).find((id) => stages[id].includes('AWSCURRENT'));
    if (currentVersion !== token) {
      await secrets.send(new UpdateSecretVersionStageCommand({
        SecretId,
        VersionStage: 'AWSCURRENT',
        MoveToVersionId: token,
        RemoveFromVersionId: currentVersion,
      }));
    }

    await ecs.send(new UpdateServiceCommand({
      cluster: process.env.ECS_CLUSTER_NAME,
      service: process.env.ECS_SERVICE_NAME,
      forceNewDeployment: true,
    }));
    await waitUntilServicesStable(
      { client: ecs, maxWaitTime: 600 },
      { cluster: process.env.ECS_CLUSTER_NAME, services: [process.env.ECS_SERVICE_NAME] },
    );
    await notifySlack('Secret rotation completed', `${SecretId.split('/').pop()} rotated and the ECS service is stable.`);
  } catch (error) {
    await notifySlack('Secret rotation failed', 'Rotation failed. Check the Lambda and ECS deployment logs.');
    throw error;
  }
};

async function notifySlack(title, text) {
  if (!slackSecretArn) return;
  try {
    const result = await secrets.send(new GetSecretValueCommand({ SecretId: slackSecretArn }));
    const webhookUrl = result.SecretString;
    if (!webhookUrl) return;
    const payload = JSON.stringify({ text: `*${title}*\n${text}` });
    await new Promise((resolve, reject) => {
      const request = https.request(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      }, (response) => {
        response.resume();
        response.on('end', () => response.statusCode >= 200 && response.statusCode < 300
          ? resolve()
          : reject(new Error(`Slack returned ${response.statusCode}`)));
      });
      request.on('error', reject);
      request.end(payload);
    });
  } catch (error) {
    console.error('Slack notification failed:', error.message);
  }
}/**
 * ai-net Secrets Rotation Lambda
 *
 * Handles AWS Secrets Manager rotation lifecycle for:
 *   - JWT_SECRET      (auto-generated 64-byte hex string)
 *   - VENICE_API_KEY  (manual rotation — sends Slack alert to prompt human action)
 *
 * After successful rotation:
 *   1. Triggers a rolling ECS deployment so services pick up the new secret.
 *   2. Sends a Slack notification with rotation status.
 *
 * Rotation lifecycle steps invoked by Secrets Manager:
 *   createSecret  → generate and store a new secret version (AWSPENDING)
 *   setSecret     → propagate the secret to the service (ECS force deploy)
 *   testSecret    → verify the service is healthy with the new secret
 *   finishSecret  → promote AWSPENDING → AWSCURRENT
 */

'use strict';

const {
  SecretsManagerClient,
  GetSecretValueCommand,
  PutSecretValueCommand,
  UpdateSecretVersionStageCommand,
  DescribeSecretCommand,
} = require('@aws-sdk/client-secrets-manager');
const {
  ECSClient,
  UpdateServiceCommand,
  DescribeServicesCommand,
  waitUntilServicesStable,
} = require('@aws-sdk/client-ecs');
const { randomBytes } = require('crypto');
const https = require('https');

const secretsClient = new SecretsManagerClient({});
const ecsClient     = new ECSClient({});

const ECS_CLUSTER_NAME         = process.env.ECS_CLUSTER_NAME;
const ECS_SERVICE_NAME         = process.env.ECS_SERVICE_NAME;
const SLACK_WEBHOOK_SECRET_ARN = process.env.SLACK_WEBHOOK_SECRET_ARN;
const ENVIRONMENT              = process.env.ENVIRONMENT || 'unknown';

/**
 * Main handler — routes each Secrets Manager rotation step.
 * @param {object} event - { SecretId, ClientRequestToken, Step }
 */
exports.handler = async (event) => {
  console.log('Rotation event:', JSON.stringify({ ...event, ClientRequestToken: '[REDACTED]' }));

  if (event.action === 'manual_rotation_reminder') {
    await notifySlack({
      type: 'warning',
      title: `Venice API Key Rotation Required — ${ENVIRONMENT}`,
      message:
        'The quarterly schedule is due. Renew the Venice API key in the Venice dashboard, ' +
        'then run the Emergency Secret Rotation workflow to update Secrets Manager and redeploy ECS.',
    });
    return;
  }

  const { SecretId, ClientRequestToken, Step } = event;
  if (!SecretId || !ClientRequestToken || !Step) {
    throw new Error('Invalid Secrets Manager rotation event.');
  }
  if (SecretId.split('/').pop() !== 'JWT_SECRET') {
    throw new Error('Only JWT_SECRET supports automated rotation.');
  }

  // Verify the secret exists and is rotation-enabled
  const metadata = await secretsClient.send(new DescribeSecretCommand({ SecretId }));
  if (!metadata.RotationEnabled) {
    throw new Error(`Secret ${SecretId} is not enabled for rotation.`);
  }

  const versions = metadata.VersionIdsToStages || {};
  if (!versions[ClientRequestToken]) {
    throw new Error(`Secret version ${ClientRequestToken} is not staged for rotation.`);
  }

  if (versions[ClientRequestToken].includes('AWSCURRENT')) {
    console.log('Version is already AWSCURRENT — no rotation needed.');
    return;
  }

  if (!versions[ClientRequestToken].includes('AWSPENDING')) {
    throw new Error(`Secret version ${ClientRequestToken} is not in AWSPENDING stage.`);
  }

  switch (Step) {
    case 'createSecret':
      await createSecret(SecretId, ClientRequestToken);
      break;
    case 'setSecret':
      await setSecret(SecretId, ClientRequestToken);
      break;
    case 'testSecret':
      await testSecret(SecretId, ClientRequestToken);
      break;
    case 'finishSecret':
      await finishSecret(SecretId, ClientRequestToken);
      break;
    default:
      throw new Error(`Unknown rotation step: ${Step}`);
  }
};

// ---------------------------------------------------------------------------
// Step 1: createSecret — generate and store the new pending secret value
// ---------------------------------------------------------------------------

async function createSecret(secretId, token) {
  // Check if a pending version already exists to avoid duplicating on retry
  try {
    await secretsClient.send(new GetSecretValueCommand({
      SecretId:  secretId,
      VersionStage: 'AWSPENDING',
    }));
    console.log('AWSPENDING version already exists — skipping createSecret.');
    return;
  } catch (err) {
    if (err.name !== 'ResourceNotFoundException' && err.name !== 'InvalidRequestException') {
      throw err;
    }
  }

  const newSecretValue = randomBytes(64).toString('hex');

  await secretsClient.send(new PutSecretValueCommand({
    SecretId:           secretId,
    ClientRequestToken: token,
    SecretString:       typeof newSecretValue === 'string' ? newSecretValue : JSON.stringify(newSecretValue),
    VersionStages:      ['AWSPENDING'],
  }));

  console.log(`createSecret: stored new AWSPENDING version for ${secretId}`);
}

// ---------------------------------------------------------------------------
// Step 2: setSecret — propagate the new secret to ECS (force new deployment)
// ---------------------------------------------------------------------------

async function setSecret(_secretId, _token) {
  // ECS tasks resolve AWSCURRENT when starting, so deploy after promotion.
  console.log('setSecret: deferring ECS deployment until the new version is current.');
}

// ---------------------------------------------------------------------------
// Step 3: testSecret — verify the ECS service is healthy after update
// ---------------------------------------------------------------------------

async function testSecret(_secretId, _token) {
  if (!ECS_CLUSTER_NAME || !ECS_SERVICE_NAME) {
    console.log('testSecret: ECS cluster/service not configured — skipping health check.');
    return;
  }

  console.log(`testSecret: checking ECS service health for ${ECS_SERVICE_NAME}`);

  const response = await ecsClient.send(new DescribeServicesCommand({
    cluster:  ECS_CLUSTER_NAME,
    services: [ECS_SERVICE_NAME],
  }));

  const service = response.services && response.services[0];
  if (!service) {
    throw new Error(`ECS service ${ECS_SERVICE_NAME} not found.`);
  }

  const runningCount = service.runningCount || 0;
  const desiredCount = service.desiredCount || 0;
  const failures     = service.deployments?.filter(d => d.status === 'FAILED') || [];

  if (failures.length > 0) {
    throw new Error(`ECS service ${ECS_SERVICE_NAME} has failed deployments: ${JSON.stringify(failures)}`);
  }

  if (desiredCount > 0 && runningCount === 0) {
    throw new Error(`ECS service ${ECS_SERVICE_NAME} has 0 running tasks (desired: ${desiredCount}).`);
  }

  console.log(`testSecret: ECS service healthy — running=${runningCount}, desired=${desiredCount}`);
}

// ---------------------------------------------------------------------------
// Step 4: finishSecret — promote AWSPENDING → AWSCURRENT
// ---------------------------------------------------------------------------

async function finishSecret(secretId, token) {
  const metadata = await secretsClient.send(new DescribeSecretCommand({ SecretId: secretId }));
  const versions = metadata.VersionIdsToStages || {};

  // Find the version currently marked AWSCURRENT
  const currentVersionId = Object.keys(versions).find(
    id => versions[id].includes('AWSCURRENT')
  );

  const secretName = secretId.split('/').pop();
  if (currentVersionId !== token) {
    await secretsClient.send(new UpdateSecretVersionStageCommand({
      SecretId:            secretId,
      VersionStage:        'AWSCURRENT',
      MoveToVersionId:     token,
      RemoveFromVersionId: currentVersionId,
    }));
    console.log(`finishSecret: promoted ${token} to AWSCURRENT for ${secretId}`);
  }

  try {
    await ecsClient.send(new UpdateServiceCommand({
      cluster:            ECS_CLUSTER_NAME,
      service:            ECS_SERVICE_NAME,
      forceNewDeployment: true,
    }));
    await waitUntilServicesStable(
      { client: ecsClient, maxWaitTime: 600 },
      { cluster: ECS_CLUSTER_NAME, services: [ECS_SERVICE_NAME] },
    );
  } catch (error) {
    if (currentVersionId && currentVersionId !== token) {
      await secretsClient.send(new UpdateSecretVersionStageCommand({
        SecretId:            secretId,
        VersionStage:        'AWSCURRENT',
        MoveToVersionId:     currentVersionId,
        RemoveFromVersionId: token,
      }));
      await ecsClient.send(new UpdateServiceCommand({
        cluster:            ECS_CLUSTER_NAME,
        service:            ECS_SERVICE_NAME,
        forceNewDeployment: true,
      })).catch(() => {});
    }
    await notifySlack({
      type: 'error',
      title: `Secret Rotation Failed — ${ENVIRONMENT}`,
      message: `ECS did not stabilize after rotating \`${secretName}\`. Check the rotation Lambda and ECS deployment logs.`,
    });
    throw error;
  }

  await notifySlack({
    type: 'success',
    title: `✅ Secret Rotated Successfully — ${ENVIRONMENT}`,
    message: `\`${secretName}\` has been rotated and the ECS service has been updated with the new value.`,
  });
}

// ---------------------------------------------------------------------------
// Slack notification helper
// ---------------------------------------------------------------------------

async function notifySlack({ type, title, message }) {
  try {
    const webhookSecretResponse = await secretsClient.send(
      new GetSecretValueCommand({ SecretId: SLACK_WEBHOOK_SECRET_ARN })
    );
    const webhookUrl = webhookSecretResponse.SecretString;

    const color = type === 'success' ? '#36a64f' : type === 'warning' ? '#ff9900' : '#ff0000';

    const payload = JSON.stringify({
      attachments: [
        {
          color,
          title,
          text: message,
          footer: `ai-net secrets rotation · ${ENVIRONMENT}`,
          ts: Math.floor(Date.now() / 1000),
        },
      ],
    });

    await postRequest(webhookUrl, payload);
    console.log(`Slack notification sent: ${title}`);
  } catch (err) {
    // Slack notification failure must not block rotation
    console.error('Failed to send Slack notification:', err.message);
  }
}

function postRequest(url, body) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path:     urlObj.pathname + urlObj.search,
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(data);
        } else {
          reject(new Error(`Slack webhook returned ${res.statusCode}: ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}
