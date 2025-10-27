import {
    SQSClient,
    ReceiveMessageCommand,
    DeleteMessageCommand,
    ChangeMessageVisibilityCommand,
} from "@aws-sdk/client-sqs";
import { downloadToFile, uploadFromFile, headObject, presignGetObject } from "./services/s3.service.js";
import { transcodeMp4ToMkvH264Aac } from "./services/ffmpeg.service.js";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import axios from "axios";

const FORCE_DLQ = (process.env.FORCE_DLQ ?? "true").toLowerCase() === "true";
const DLQ_SIMULATED_WORK_MS = Number(process.env.DLQ_SIMULATED_WORK_MS ?? "5000");
const HEARTBEAT_VIS_TIMEOUT_SECS = Number(process.env.HEARTBEAT_VIS_TIMEOUT_SECS ?? "300");
const HEARTBEAT_PERIOD_SECS = Number(process.env.HEARTBEAT_PERIOD_SECS ?? "120");

const sqs = new SQSClient({ region: process.env.AWS_REGION });
const QUEUE_URL = process.env.JOBS_QUEUE_URL;

async function notifyApiStatus({ qutUsername, videoId, variantId, status, url = "", size = 0 }) {
    if (FORCE_DLQ) {
        return;
    }
    await axios.post(
        process.env.API_INTERNAL_URL,
        { qutUsername, videoId, variantId, status, url, size },
        { headers: { "x-job-token": process.env.API_JOB_STATUS_TOKEN } }
    );
}

async function processMessage(msg) {
    const receiveCount = Number(msg.Attributes?.ApproximateReceiveCount || "1");

    const body = JSON.parse(msg.Body);
    const { videoId, variantId, qutUsername, originalKey, variantKey } = body;

    let heartbeat;
    const startHeartbeat = () => {
        if (FORCE_DLQ) return;
        const bump = async () => {
            try {
                await sqs.send(
                    new ChangeMessageVisibilityCommand({
                        QueueUrl: QUEUE_URL,
                        ReceiptHandle: msg.ReceiptHandle,
                        VisibilityTimeout: HEARTBEAT_VIS_TIMEOUT_SECS,
                    })
                );
            } catch (e) {
                console.error("ChangeMessageVisibility failed:", e?.message || e);
            }
        };
        heartbeat = setInterval(bump, HEARTBEAT_PERIOD_SECS * 1000);
        bump();
    };
    const stopHeartbeat = () => heartbeat && clearInterval(heartbeat);

    try {
        console.log(
            `[${FORCE_DLQ ? "DLQ-TEST" : "NORMAL"}] Processing ${videoId} (receive #${receiveCount})`
        );

        if (FORCE_DLQ) {
            if (DLQ_SIMULATED_WORK_MS > 0) {
                await new Promise((r) => setTimeout(r, DLQ_SIMULATED_WORK_MS));
            }
            throw new Error("Intentional failure for DLQ test (message will not be deleted)");
        }

        startHeartbeat();

        const tmpDir = os.tmpdir();
        const inputPath = path.join(tmpDir, `${videoId}-input.mp4`);
        const outputPath = path.join(tmpDir, `${videoId}-${variantId}.mkv`);

        await downloadToFile({ key: originalKey, destPath: inputPath });
        await transcodeMp4ToMkvH264Aac(inputPath, outputPath);
        await uploadFromFile({ key: variantKey, filePath: outputPath, contentType: "video/x-matroska" });

        const head = await headObject({ key: variantKey });
        const size = head?.ContentLength ?? 0;
        const url = await presignGetObject({ key: variantKey });

        await notifyApiStatus({ qutUsername, videoId, variantId, status: "completed", url, size });

        await sqs.send(
            new DeleteMessageCommand({
                QueueUrl: QUEUE_URL,
                ReceiptHandle: msg.ReceiptHandle,
            })
        );
        console.log(`Completed ${videoId} — message deleted from queue`);
    } catch (err) {
        console.error("Processing error:", err?.message || err);
        try {
            await notifyApiStatus({ qutUsername, videoId, variantId, status: "failed" });
        } catch (_) { }
    } finally {
        stopHeartbeat();
        try { await fs.unlink(path.join(os.tmpdir(), `${videoId}-input.mp4`)); } catch { }
        try { await fs.unlink(path.join(os.tmpdir(), `${videoId}-${variantId}.mkv`)); } catch { }
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
                AttributeNames: ["ApproximateReceiveCount"],
            })
        );

        if (!resp.Messages || resp.Messages.length === 0) continue;

        for (const msg of resp.Messages) {
            await processMessage(msg);
        }
    }
}

pollQueue().catch(console.error);