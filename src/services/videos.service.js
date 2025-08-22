// src/services/videos.service.js
import {
    PutCommand,
    QueryCommand,
    BatchWriteCommand,
    UpdateCommand,
    DeleteCommand
  } from '@aws-sdk/lib-dynamodb';
  import { ddbDoc, TABLE } from '../models/dynamo.js';
  
  export function nowIso() {
    return new Date().toISOString();
  }
  
  export function newVideoId() {
    return 'vid_' + randomUUID();;
  }
  
  export function newVariantId(videoId, seq) {
    return `${videoId}_${seq}`;
  }
  
  export async function createMeta({ videoId, fileName, createdBy, title = '', description = '' }) {
    const item = {
      PK: `VIDEO#${videoId}`,
      SK: 'META',
      videoId,
      fileName,
      title,
      description,
      createdAt: nowIso(),
      createdBy
    };
    await ddbDoc.send(new PutCommand({ TableName: TABLE, Item: item }));
    return item;
  }
  
  export async function createVariant({
    videoId,
    variantId,
    format,
    resolution = 'source',
    size = 0,
    transcode_status = 'processing',
    url = '',
    error_message
  }) {
    const item = {
      PK: `VIDEO#${videoId}`,
      SK: `VARIANT#${variantId}`,
      variantId,
      format,
      resolution,
      size,
      transcode_status,
      url
    };
    if (error_message) item.error_message = error_message;
    await ddbDoc.send(new PutCommand({ TableName: TABLE, Item: item }));
    return item;
  }
  
  export async function updateVariant({ videoId, variantId, values }) {
    const keys = Object.keys(values);
    const expr = `SET ${keys.map((k, i) => `#${i} = :${i}`).join(', ')}`;
    const ExpressionAttributeNames = Object.fromEntries(keys.map((k, i) => [`#${i}`, k]));
    const ExpressionAttributeValues = Object.fromEntries(keys.map((k, i) => [`:${i}`, values[k]]));
    await ddbDoc.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { PK: `VIDEO#${videoId}`, SK: `VARIANT#${variantId}` },
        UpdateExpression: expr,
        ExpressionAttributeNames,
        ExpressionAttributeValues
      })
    );
  }
  
  export async function getMeta(videoId) {
    const resp = await ddbDoc.send(
      new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: 'PK = :pk AND SK = :sk',
        ExpressionAttributeValues: { ':pk': `VIDEO#${videoId}`, ':sk': 'META' },
        Limit: 1
      })
    );
    return resp.Items?.[0];
  }
  
  export async function getAllByVideo(videoId) {
    const resp = await ddbDoc.send(
      new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: { ':pk': `VIDEO#${videoId}` }
      })
    );
    return resp.Items || [];
  }
  
  export async function getVariants(videoId) {
    const resp = await ddbDoc.send(
      new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
        ExpressionAttributeValues: { ':pk': `VIDEO#${videoId}`, ':sk': 'VARIANT#' }
      })
    );
    return resp.Items || [];
  }
  
  export async function getNextVariantSeq(videoId) {
    const items = await getVariants(videoId);
    const seqs = items
      .map((v) => v.variantId)
      .map((id) => Number(id.split('_').pop()))
      .filter((n) => Number.isFinite(n));
    const max = seqs.length ? Math.max(...seqs) : 0;
    return max + 1;
  }
  
  export async function findExistingVariant(videoId, { format = 'mkv', resolution = 'source' } = {}) {
    const variants = await getVariants(videoId);
    return variants.find(
      (v) => v.format === format && v.resolution === resolution && v.transcode_status === 'completed'
    );
  }
  
  export async function deleteVideoRecords(videoId) {
    const items = await getAllByVideo(videoId);
    if (!items.length) return 0;
    const chunks = [];
    while (items.length) chunks.push(items.splice(0, 25));
    let count = 0;
    for (const batch of chunks) {
      await ddbDoc.send(
        new BatchWriteCommand({
          TableName: TABLE,
          RequestItems: {
            [TABLE]: batch.map((Item) => ({ DeleteRequest: { Key: { PK: Item.PK, SK: Item.SK } } }))
          }
        })
      );
      count += batch.length;
    }
    return count;
  }
  
  export async function updateMeta(videoId, values) {
    const keys = Object.keys(values);
    if (!keys.length) return;
    const expr = `SET ${keys.map((k, i) => `#${i} = :${i}`).join(', ')}`;
    const ExpressionAttributeNames = Object.fromEntries(keys.map((k, i) => [`#${i}`, k]));
    const ExpressionAttributeValues = Object.fromEntries(keys.map((k, i) => [`:${i}`, values[k]]));
    await ddbDoc.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { PK: `VIDEO#${videoId}`, SK: 'META' },
        UpdateExpression: expr,
        ExpressionAttributeNames,
        ExpressionAttributeValues
      })
    );
  }
  
  export async function listMetasByCreator({
    creator,
    limit,
    exclusiveStartKey,
    sort = 'desc'
  }) {
    const resp = await ddbDoc.send(
      new QueryCommand({
        TableName: TABLE,
        IndexName: 'GSI1',
        KeyConditionExpression: 'createdBy = :cb',
        ExpressionAttributeValues: { ':cb': creator },
        ScanIndexForward: sort !== 'desc',
        Limit: limit,
        ExclusiveStartKey: exclusiveStartKey
      })
    );
    const items = (resp.Items || []).filter((i) => i.SK === 'META');
    return { items, lastEvaluatedKey: resp.LastEvaluatedKey || null, count: resp.Count || 0 };
  }
  
  export async function listAllMetas({ limit, exclusiveStartKey, sort = 'desc' }) {
    // Query by PK prefix is not supported without known PKs; for demo we do a table scan substitute:
    // Prefer using GSI1 with createdBy for user filtered lists.
    const resp = await ddbDoc.send(
      new QueryCommand({
        TableName: TABLE,
        IndexName: 'GSI1',
        // Use createdBy as sparse index; to emulate "all", clients should call twice for each known user.
        // For brevity we fallback to createdBy = 'admin@example.com' in demo if not specified.
        KeyConditionExpression: 'createdBy = :cb',
        ExpressionAttributeValues: { ':cb': 'admin@example.com' },
        ScanIndexForward: sort !== 'desc',
        Limit: limit,
        ExclusiveStartKey: exclusiveStartKey
      })
    );
    const items = (resp.Items || []).filter((i) => i.SK === 'META');
    return { items, lastEvaluatedKey: resp.LastEvaluatedKey || null, count: resp.Count || 0 };
  }
  