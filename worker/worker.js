// worker.js
import {
    SQSClient,
    ReceiveMessageCommand,
    DeleteMessageCommand,
} from "@aws-sdk/client-sqs";
import { downloadToFile, uploadFromFile, headObject, presignGetObject } from "../src/services/s3.service.js";
import { transcodeMp4ToMkvH264Aac } from "../src/services/ffmpeg.service.js";
import { updateVariant } from "../src/models/videos.repo.js";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";

const sqs = new SQSClient({ region: process.env.AWS_REGION });
const QUEUE_URL = process.env.JOBS_QUEUE_URL;

async function processMessage(msg) {
    const body = JSON.parse(msg.Body);
    const { videoId, variantId, qutUsername, originalKey, variantKey } = body;

    console.log("Processing job:", videoId);

    try {
        const tmpDir = os.tmpdir();
        const inputPath = path.join(tmpDir, `${videoId}-input.mp4`);
        const outputPath = path.join(tmpDir, `${videoId}-${variantId}.mkv`);

        await downloadToFile({ key: originalKey, destPath: inputPath });

        await transcodeMp4ToMkvH264Aac(inputPath, outputPath);

        await uploadFromFile({ key: variantKey, filePath: outputPath, contentType: "video/x-matroska" });

        const head = await headObject({ key: variantKey });
        const size = head?.ContentLength ?? 0;
        const url = await presignGetObject({ key: variantKey });

        await updateVariant({
            qutUsername,
            videoId,
            variantId,
            patch: { transcode_status: "completed", url, size },
        });

        await fs.unlink(inputPath).catch(() => { });
        await fs.unlink(outputPath).catch(() => { });

        await sqs.send(
            new DeleteMessageCommand({
                QueueUrl: QUEUE_URL,
                ReceiptHandle: msg.ReceiptHandle,
            })
        );

        console.log("Completed:", videoId);
    } catch (err) {
        console.error("Failed:", err);
        await updateVariant({
            qutUsername,
            videoId,
            variantId,
            patch: { transcode_status: "failed" },
        });
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