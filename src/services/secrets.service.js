// src/config/secrets.js
import {
    SecretsManagerClient,
    GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";

const region = process.env.AWS_REGION || "ap-southeast-2";
const prefix = (process.env.SECRETS_PREFIX || "").replace(/\/$/, "");
const sm = new SecretsManagerClient({ region });

const cache = new Map();

export async function getSecret(key) {
    if (!key) throw new Error("Secret key is required");

    const fullName = key.startsWith("/") ? key : `${prefix}/${key}`;
    if (cache.has(fullName)) return cache.get(fullName);

    const resp = await sm.send(new GetSecretValueCommand({ SecretId: fullName }));

    let val = resp.SecretString ?? null;

    if (!val) throw new Error(`Secret ${fullName} has no value`);

    try {
        const parsed = JSON.parse(val);
        if (parsed[key] !== undefined) {
            val = parsed[key];
        }
    } catch {
    }

    cache.set(fullName, val);
    return val;
}