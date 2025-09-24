// src/models/videos.repo.js
import { ddbDoc, getTableName } from "./dynamo.js";
import { PutCommand, QueryCommand, DeleteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const rkMeta = (videoId) => `VIDEO#${videoId}#META`;
const rkVariant = (videoId, variantId) => `VIDEO#${videoId}#VARIANT#${variantId}`;
const TABLE = await getTableName();

export async function putMeta({ qutUsername, video }) {
  return ddbDoc.send(new PutCommand({
    TableName: TABLE,
    Item: {
      'qut-username': qutUsername,
      rk: rkMeta(video.videoId),
      ...video, // includes createdAt for GSI1
    },
    ConditionExpression: 'attribute_not_exists(#rk)',
    ExpressionAttributeNames: { '#rk': 'rk' },
  }));
}

export async function putVariant({ qutUsername, videoId, variant }) {
  return ddbDoc.send(new PutCommand({
    TableName: TABLE,
    Item: {
      'qut-username': qutUsername,
      rk: rkVariant(videoId, variant.variantId),
      videoId,
      ...variant,
    },
  }));
}

export async function getVideoWithVariants({ qutUsername, videoId }) {
  const res = await ddbDoc.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: '#u = :u AND begins_with(#rk, :prefix)',
    ExpressionAttributeNames: { '#u': 'qut-username', '#rk': 'rk' },
    ExpressionAttributeValues: { ':u': qutUsername, ':prefix': `VIDEO#${videoId}#` },
  }));
  const items = res.Items || [];
  const meta = items.find((i) => i.rk.endsWith('#META'));
  const variants = items.filter((i) => i.rk.includes('#VARIANT#'));
  return { meta, variants };
}

export async function listVideosByUser({ qutUsername, limit = 10, cursor, descending = true }) {
  const params = {
    TableName: TABLE,
    IndexName: 'GSI1',
    KeyConditionExpression: '#u = :u',
    ExpressionAttributeNames: { '#u': 'qut-username' },
    ExpressionAttributeValues: { ':u': qutUsername },
    ScanIndexForward: !descending,
    Limit: limit,
  };
  if (cursor) params.ExclusiveStartKey = cursor;
  const res = await ddbDoc.send(new QueryCommand(params));
  const metas = (res.Items || []).filter((i) => i.rk.endsWith('#META'));
  return { items: metas, cursor: res.LastEvaluatedKey || null };
}

export async function listAllRksForVideo({ qutUsername, videoId }) {
  const res = await ddbDoc.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: '#u = :u AND begins_with(#rk, :prefix)',
    ExpressionAttributeNames: { '#u': 'qut-username', '#rk': 'rk' },
    ExpressionAttributeValues: { ':u': qutUsername, ':prefix': `VIDEO#${videoId}#` },
  }));
  return (res.Items || []).map((i) => i.rk);
}

export async function deleteByRk({ qutUsername, rk }) {
  return ddbDoc.send(new DeleteCommand({
    TableName: TABLE,
    Key: { 'qut-username': qutUsername, rk },
  }));
}

export async function updateVariant({ qutUsername, videoId, variantId, patch }) {
  if (!patch || Object.keys(patch).length === 0) {
    throw new Error('updateVariant: patch must have at least one field');
  }

  const rk = `VIDEO#${videoId}#VARIANT#${variantId}`;

  const expNames = {};
  const expVals = {};
  const setClauses = [];

  for (const [k, v] of Object.entries(patch)) {
    const nk = `#${k}`;
    const vk = `:${k}`;
    expNames[nk] = k;
    expVals[vk] = v;
    setClauses.push(`${nk} = ${vk}`);
  }

  const UpdateExpression = `SET ${setClauses.join(', ')}`;

  return ddbDoc.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { 'qut-username': qutUsername, rk },
      UpdateExpression,
      ExpressionAttributeNames: expNames,
      ExpressionAttributeValues: expVals,
      // Optional: ensure we only update an existing item
      ConditionExpression: 'attribute_exists(rk)',
    }),
  );
}
