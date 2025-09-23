// src/models/dynamo.js
import {
  DynamoDBClient,
  CreateTableCommand,
  DescribeTableCommand,
  ResourceInUseException,
  waitUntilTableExists,
} from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { getParams } from "../services/parameters.service.js";

const region = process.env.AWS_REGION || "ap-southeast-2";
const baseClient = new DynamoDBClient({ region });

// Helpful marshalling options (prevents common issues)
export const ddbDoc = DynamoDBDocumentClient.from(baseClient, {
  marshallOptions: {
    convertEmptyValues: true,           // "" -> {"NULL": true} compatible
    removeUndefinedValues: true,        // drops undefined fields
    convertClassInstanceToMap: true,    // class instances => Map attributes
  },
});

let TABLE; // lazy-loaded so this module can be imported without immediate I/O

export async function getTableName() {
  if (!TABLE) {
    const { DDB_TABLE } = await getParams(["DDB_TABLE"]);
    if (!DDB_TABLE) throw new Error("DDB_TABLE parameter is required");
    TABLE = DDB_TABLE;
  }
  return TABLE;
}

export async function logAwsIdentity(logger) {
  try {
    const sts = new STSClient({ region });
    const me = await sts.send(new GetCallerIdentityCommand({}));
    (logger?.info ?? console.log)({
      arn: me.Arn,
      account: me.Account,
      userId: me.UserId,
    }, "AWS identity");
  } catch (e) {
    (logger?.error ?? console.error)({ err: e }, "AWS identity failed");
  }
}

export async function ensureTableAndGSI() {
  const tableName = await getTableName();

  // Fast-path: already exists?
  try {
    await baseClient.send(new DescribeTableCommand({ TableName: tableName }));
    return;
  } catch (e) {
    // if not found, proceed to create
  }

  const create = new CreateTableCommand({
    TableName: tableName,
    AttributeDefinitions: [
      { AttributeName: "qut-username", AttributeType: "S" },
      { AttributeName: "rk", AttributeType: "S" },
      { AttributeName: "createdAt", AttributeType: "S" },
    ],
    KeySchema: [
      { AttributeName: "qut-username", KeyType: "HASH" },
      { AttributeName: "rk", KeyType: "RANGE" },
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: "GSI1",
        KeySchema: [
          { AttributeName: "qut-username", KeyType: "HASH" },
          { AttributeName: "createdAt", KeyType: "RANGE" },
        ],
        Projection: { ProjectionType: "ALL" },
      },
    ],
    BillingMode: "PAY_PER_REQUEST",
  });

  try {
    await baseClient.send(create);
  } catch (e) {
    // If another instance created it in the meantime, ignore
    if (!(e instanceof ResourceInUseException)) throw e;
  }

  // Wait until ACTIVE to avoid immediate write/read failures on cold start
  await waitUntilTableExists(
    { client: baseClient, maxWaitTime: 60 }, // seconds
    { TableName: tableName }
  );
}