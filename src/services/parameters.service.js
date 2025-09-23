// src/config/ssm.js
import { SSMClient, GetParametersCommand } from "@aws-sdk/client-ssm";

const region = process.env.AWS_REGION || "ap-southeast-2";
const parameterStoreName =
    process.env.PARAMETER_STORE_NAME || "/video-transcoder/dev";

const ssm = new SSMClient({ region });

// In-process cache: full SSM name -> value
const cache = new Map();

/** Build full SSM name: "<prefix>/<KEY>" while cleaning stray slashes */
function fullName(key) {
    const prefix = parameterStoreName.replace(/\/$/, "");
    const k = String(key).replace(/^\//, "");
    return `${prefix}/${k}`;
}

/** Last path segment -> "KEY" */
function shortKey(name) {
    const parts = name.split("/");
    return parts[parts.length - 1] || name;
}

/**
 * Get multiple parameters from SSM, with prefix + caching.
 * @param {string[]} keys - e.g. ["VIDEO_BUCKET","JWT_SECRET"]
 * @param {boolean} decrypt - decrypt SecureString (default: true)
 * @returns {Promise<object>} - { KEY: value, ... }
 */
export async function getParams(keys, decrypt = true) {
    if (!Array.isArray(keys) || keys.length === 0) {
        throw new Error("At least one parameter key is required");
    }

    // Map to full names
    const names = keys.map(fullName);

    // Check cache first
    const result = {};
    const missing = [];
    for (const name of names) {
        if (cache.has(name)) {
            result[shortKey(name)] = cache.get(name);
        } else {
            missing.push(name);
        }
    }

    // Fetch only the missing ones
    if (missing.length) {
        const resp = await ssm.send(
            new GetParametersCommand({
                Names: missing,
                WithDecryption: decrypt,
            })
        );

        for (const p of resp.Parameters ?? []) {
            const key = shortKey(p.Name);
            cache.set(p.Name, p.Value);
            result[key] = p.Value;
        }

        if (resp.InvalidParameters?.length) {
            // Convert invalid full names back to short keys for a friendlier log
            const invalidShort = resp.InvalidParameters.map(shortKey);
            console.warn("Missing parameters:", invalidShort);
        }
    }

    return result;
}

// const mySecret = await getSecret("JWT_SECRET");
