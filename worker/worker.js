import {
    SQSClient,
    ReceiveMessageCommand,
    DeleteMessageCommand,
} from "@aws-sdk/client-sqs";
import { downloadToFile, uploadFromFile, headObject, presignGetObject } from "./s3.service.js";
import { transcodeMp4ToMkvH264Aac } from "./ffmpeg.service.js";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import axios from 'axios';

const sqs = new SQSClient({ region: process.env.AWS_REGION });
const QUEUE_URL = process.env.JOBS_QUEUE_URL;

async function notifyApiStatus({ qutUsername, videoId, variantId, status, url = '', size = 0 }) {
    await axios.post(
        process.env.API_INTERNAL_URL,
        { qutUsername, videoId, variantId, status, url, size },
        { headers: { 'x-job-token': process.env.API_JOB_STATUS_TOKEN } }
    );
}

async function processMessage(msg) {
    const body = JSON.parse(msg.Body);
    const { videoId, variantId, qutUsername, originalKey, variantKey } = body;

    try {
        const tmpDir = os.tmpdir();
        const inputPath = path.join(tmpDir, `${videoId}-input.mp4`);
        const outputPath = path.join(tmpDir, `${videoId}-${variantId}.mkv`);

        await downloadToFile({ key: originalKey, destPath: inputPath });
        await transcodeMp4ToMkvH264Aac(inputPath, outputPath);
        await uploadFromFile({ key: variantKey, filePath: outputPath, contentType: 'video/x-matroska' });

        const head = await headObject({ key: variantKey });
        const size = head?.ContentLength ?? 0;
        const url = await presignGetObject({ key: variantKey });

        await notifyApiStatus({ qutUsername, videoId, variantId, status: 'completed', url, size });

        await fs.unlink(inputPath).catch(() => { });
        await fs.unlink(outputPath).catch(() => { });

        await sqs.send(new DeleteMessageCommand({
            QueueUrl: QUEUE_URL,
            ReceiptHandle: msg.ReceiptHandle,
        }));

    } catch (err) {
        console.error('Failed:', err);
        try {
            await notifyApiStatus({ qutUsername, videoId, variantId, status: 'failed' });
        } catch (_) {
        }
    }
}

async function pollQueue() {
    while (true) {
        const resp = await sqs.send(
            new ReceiveMessageCommand({
                QueueUrl: QUEUE_URL,
                MaxNumberOfMessages: 1,
                WaitTimeSeconds: 20,
                VisibilityTimeout: 120,
            })
        );

        if (!resp.Messages || resp.Messages.length === 0) continue;

        for (const msg of resp.Messages) {
            await processMessage(msg);
        }
    }
}

pollQueue().catch(console.error);