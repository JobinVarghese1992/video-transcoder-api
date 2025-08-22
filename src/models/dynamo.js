// src/models/dynamo.js
import { DynamoDBClient, CreateTableCommand, DescribeTableCommand } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';

const region = process.env.AWS_REGION || 'ap-southeast-2';
export const TABLE = process.env.DDB_TABLE;

const baseClient = new DynamoDBClient({ region });
export const ddbDoc = DynamoDBDocumentClient.from(baseClient);

export async function logAwsIdentity(logger) {
  try {
    const sts = new STSClient({ region });
    const me = await sts.send(new GetCallerIdentityCommand({}));
    logger?.info
      ? logger.info({ arn: me.Arn, account: me.Account, userId: me.UserId }, 'AWS identity')
      : console.log('AWS identity:', me);
  } catch (e) {
    logger?.error ? logger.error({ err: e }, 'AWS identity failed') : console.error(e);
  }
}

export async function ensureTableAndGSI() {
  if (!TABLE) throw new Error('DDB_TABLE env var is required');

  try {
    await baseClient.send(new DescribeTableCommand({ TableName: TABLE }));
    return;
  } catch {
    // proceed to create
  }

  const cmd = new CreateTableCommand({
    TableName: TABLE,
    AttributeDefinitions: [
      { AttributeName: 'qut-username', AttributeType: 'S' },
      { AttributeName: 'rk', AttributeType: 'S' },
      { AttributeName: 'createdAt', AttributeType: 'S' },
    ],
    KeySchema: [
      { AttributeName: 'qut-username', KeyType: 'HASH' },
      { AttributeName: 'rk', KeyType: 'RANGE' },
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: 'GSI1',
        KeySchema: [
          { AttributeName: 'qut-username', KeyType: 'HASH' },
          { AttributeName: 'createdAt', KeyType: 'RANGE' },
        ],
        Projection: { ProjectionType: 'ALL' },
      },
    ],
    BillingMode: 'PAY_PER_REQUEST',
  });

  await baseClient.send(cmd);
}
