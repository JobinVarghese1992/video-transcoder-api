// src/config/ssm.js
import { SSMClient, GetParametersCommand } from "@aws-sdk/client-ssm";

const region = process.env.AWS_REGION || "ap-southeast-2";
const parameterStoreName = process.env.PARAMETER_STORE_NAME;

const ssm = new SSMClient({ region });

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
 * Get multiple parameters from SSM (no cache).
 * @param {string[]} keys - e.g. ["VIDEO_BUCKET","JWT_SECRET"]
 * @param {boolean} decrypt - decrypt SecureString (default: true)
 * @returns {Promise<object>} - { KEY: value, ... }
 */
export async function getParams(keys, decrypt = true) {
    if (!Array.isArray(keys) || keys.length === 0) {
        throw new Error("At least one parameter key is required");
    }

    const names = keys.map(fullName);

    const resp = await ssm.send(
        new GetParametersCommand({
            Names: names,
            WithDecryption: decrypt,
        })
    );

    const result = {};
    for (const p of resp.Parameters ?? []) {
        result[shortKey(p.Name)] = p.Value;
    }

    if (resp.InvalidParameters?.length) {
        const invalidShort = resp.InvalidParameters.map(shortKey);
        console.warn("Missing parameters:", invalidShort);
    }

    return result;
}