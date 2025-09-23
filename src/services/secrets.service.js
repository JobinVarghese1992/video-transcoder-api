// src/config/secrets.js
import {
    SecretsManagerClient,
    GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";

const region = process.env.AWS_REGION || "ap-southeast-2";
const prefix = (process.env.SECRETS_PREFIX || "").replace(/\/$/, ""); // strip trailing slash
const sm = new SecretsManagerClient({ region });

const cache = new Map();

function parseMaybeJSON(str) {
    if (typeof str !== "string") return str;
    try {
        return JSON.parse(str);
    } catch {
        return str;
    }
}

/**
 * Fetch a secret by key (automatically prefixed with SECRETS_PREFIX).
 * Example: await getSecret("JWT_SECRET")
 */
export async function getSecret(key) {
    if (!key) throw new Error("Secret key is required");

    const fullName = key.startsWith("/") ? key : `${prefix}/${key}`;
    if (cache.has(fullName)) return cache.get(fullName);

    const resp = await sm.send(new GetSecretValueCommand({ SecretId: fullName }));

    let val = resp.SecretString ?? null;

    const parsed = parseMaybeJSON(val);
    cache.set(fullName, parsed);
    return parsed;
}