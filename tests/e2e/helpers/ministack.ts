import {
  DynamoDBClient,
  PutItemCommand,
  type AttributeValue,
} from '@aws-sdk/client-dynamodb';
import {
  CognitoIdentityProviderClient,
  AdminInitiateAuthCommand,
} from '@aws-sdk/client-cognito-identity-provider';

const MINISTACK_ENDPOINT = process.env.MINISTACK_ENDPOINT || 'http://localhost:4566';
const REGION = process.env.AWS_DEFAULT_REGION || 'us-east-1';
const TABLE_NAME = process.env.DYNAMODB_TABLE_NAME || 'warmreach-test';

const awsConfig = {
  endpoint: MINISTACK_ENDPOINT,
  region: REGION,
  credentials: {
    accessKeyId: 'test',
    secretAccessKey: 'test',
  },
};

const dynamodb = new DynamoDBClient(awsConfig);
const cognito = new CognitoIdentityProviderClient(awsConfig);

/**
 * Seed test data into MiniStack DynamoDB for E2E tests.
 */
export async function seedTestData(userId: string) {
  // Seed a test edge/connection
  const connections = [
    {
      id: 'dGVzdC1wcm9maWxl',
      first_name: 'Test',
      last_name: 'Connection',
      position: 'Engineer',
      company: 'TestCo',
      status: 'ally',
    },
    {
      id: 'c2Vjb25kLXByb2ZpbGU=',
      first_name: 'Second',
      last_name: 'Person',
      position: 'Manager',
      company: 'OtherCo',
      status: 'possible',
    },
  ];

  for (const conn of connections) {
    const item: Record<string, AttributeValue> = {
      PK: { S: `USER#${userId}` },
      SK: { S: `PROFILE#${conn.id}` },
      GSI1PK: { S: `USER#${userId}#STATUS#${conn.status}` },
      GSI1SK: { S: `PROFILE#${conn.id}` },
      first_name: { S: conn.first_name },
      last_name: { S: conn.last_name },
      position: { S: conn.position },
      company: { S: conn.company },
      status: { S: conn.status },
    };

    await dynamodb.send(
      new PutItemCommand({
        TableName: TABLE_NAME,
        Item: item,
      })
    );
  }
}

/**
 * Authenticate with MiniStack Cognito and return tokens.
 */
export async function authenticateWithCognito(
  userPoolId: string,
  clientId: string,
  username: string,
  password: string
) {
  const result = await cognito.send(
    new AdminInitiateAuthCommand({
      UserPoolId: userPoolId,
      ClientId: clientId,
      AuthFlow: 'ADMIN_USER_PASSWORD_AUTH',
      AuthParameters: {
        USERNAME: username,
        PASSWORD: password,
      },
    })
  );

  return result.AuthenticationResult;
}
