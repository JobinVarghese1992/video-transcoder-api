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

export const ddbDoc = DynamoDBDocumentClient.from(baseClient, {
  marshallOptions: {
    convertEmptyValues: true,
    removeUndefinedValues: true,
    convertClassInstanceToMap: true,
  },
});

let TABLE;

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

    if (logger && typeof logger.info === "function") {
      logger.info(
        { arn: me.Arn, account: me.Account, userId: me.UserId },
        "AWS identity"
      );
    } else {
      console.log("AWS identity", {
        arn: me.Arn, account: me.Account, userId: me.UserId,
      });
    }
  } catch (e) {
    if (logger && typeof logger.error === "function") {
      logger.error({ err: e }, "AWS identity failed");
    } else {
      console.error("AWS identity failed", e);
    }
  }
}

export async function ensureTableAndGSI() {
  const tableName = await getTableName();

  try {
    await baseClient.send(new DescribeTableCommand({ TableName: tableName }));
    return;
  } catch (e) {

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
    if (!(e instanceof ResourceInUseException)) throw e;
  }

  await waitUntilTableExists(
    { client: baseClient, maxWaitTime: 60 },
    { TableName: tableName }
  );
}