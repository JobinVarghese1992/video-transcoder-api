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
    if (cache.has(fullName)) {
        console.log(`Cache hit for secret "${fullName}"`);
        return cache.get(fullName);
    }

    const resp = await sm.send(new GetSecretValueCommand({ SecretId: fullName }));
    let val = resp.SecretString ?? null;

    try {
        const parsed = JSON.parse(val);
        if (parsed && typeof parsed === "object" && key in parsed) {
            val = parsed[key];
        }
    } catch {

    }
    console.log(`Fetched secret "${val}" from Secrets Manager`);
    cache.set(fullName, val);
    return val;
}