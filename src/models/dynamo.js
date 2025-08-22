// src/models/dynamo.js
import {
    DynamoDBClient,
    CreateTableCommand,
    UpdateTableCommand,
    DescribeTableCommand
  } from '@aws-sdk/client-dynamodb';
  import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
  
  const region = process.env.AWS_REGION || 'ap-southeast-2';
  export const TABLE = process.env.DDB_TABLE || 'VideoTable';
  
  const ddb = new DynamoDBClient({ region });
  export const ddbDoc = DynamoDBDocumentClient.from(ddb, {
    marshallOptions: { removeUndefinedValues: true }
  });
  
  export async function ensureTableAndGSI() {
    // Ensure table exists
    let exists = true;
    try {
      await ddb.send(new DescribeTableCommand({ TableName: TABLE }));
    } catch {
      exists = false;
    }
    if (!exists) {
      await ddb.send(
        new CreateTableCommand({
          TableName: TABLE,
          AttributeDefinitions: [
            { AttributeName: 'PK', AttributeType: 'S' },
            { AttributeName: 'SK', AttributeType: 'S' },
            { AttributeName: 'createdBy', AttributeType: 'S' },
            { AttributeName: 'createdAt', AttributeType: 'S' }
          ],
          KeySchema: [
            { AttributeName: 'PK', KeyType: 'HASH' },
            { AttributeName: 'SK', KeyType: 'RANGE' }
          ],
          BillingMode: 'PAY_PER_REQUEST',
          GlobalSecondaryIndexes: [
            {
              IndexName: 'GSI1',
              KeySchema: [
                { AttributeName: 'createdBy', KeyType: 'HASH' },
                { AttributeName: 'createdAt', KeyType: 'RANGE' }
              ],
              Projection: { ProjectionType: 'ALL' }
            }
          ]
        })
      );
      return;
    }
    // Ensure GSI1 exists
    const desc = await ddb.send(new DescribeTableCommand({ TableName: TABLE }));
    const hasGSI =
      desc.Table?.GlobalSecondaryIndexes?.some((g) => g.IndexName === 'GSI1') ?? false;
    if (!hasGSI) {
      await ddb.send(
        new UpdateTableCommand({
          TableName: TABLE,
          AttributeDefinitions: [
            { AttributeName: 'createdBy', AttributeType: 'S' },
            { AttributeName: 'createdAt', AttributeType: 'S' }
          ],
          GlobalSecondaryIndexUpdates: [
            {
              Create: {
                IndexName: 'GSI1',
                KeySchema: [
                  { AttributeName: 'createdBy', KeyType: 'HASH' },
                  { AttributeName: 'createdAt', KeyType: 'RANGE' }
                ],
                Projection: { ProjectionType: 'ALL' }
              }
            }
          ]
        })
      );
    }
  }
  