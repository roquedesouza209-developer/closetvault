const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const {
  OBJECTS_DIR,
  STORAGE_DRIVER,
  parseBooleanFlag,
} = require("./config");
const { createHttpError } = require("./utils");

function hashSha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function hmacSha256(key, value) {
  return crypto.createHmac("sha256", key).update(value).digest();
}

function formatAmzDate(timestamp) {
  const iso = timestamp.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return {
    amzDate: iso,
    dateStamp: iso.slice(0, 8),
  };
}

function encodeS3Key(key) {
  return key.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}

class FilesystemStorageAdapter {
  constructor(rootDir) {
    this.rootDir = rootDir;
    this.driver = "fs";
  }

  describe() {
    return {
      detail: "Local encrypted object storage with an S3-compatible adapter boundary.",
      driver: "fs",
      label: "Filesystem object storage",
      supportsS3CompatibleLayout: true,
    };
  }

  resolveKey(key) {
    const targetPath = path.join(this.rootDir, ...String(key).split("/"));
    const relativePath = path.relative(this.rootDir, targetPath);

    if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
      throw createHttpError(500, "ClosetVault generated an invalid storage key.");
    }

    return targetPath;
  }

  async putObject({ key, body }) {
    const targetPath = this.resolveKey(key);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, body);
  }

  async getObject({ key }) {
    return fs.readFile(this.resolveKey(key));
  }

  async deleteObject({ key }) {
    try {
      await fs.unlink(this.resolveKey(key));
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  }
}

class S3CompatibleStorageAdapter {
  constructor(config) {
    if (!config.endpoint || !config.bucket || !config.accessKey || !config.secretKey) {
      throw createHttpError(
        500,
        "S3 storage requires endpoint, bucket, access key, and secret key configuration.",
      );
    }

    this.driver = "s3";
    this.endpoint = new URL(config.endpoint);
    this.bucket = config.bucket;
    this.accessKey = config.accessKey;
    this.secretKey = config.secretKey;
    this.region = config.region || "us-east-1";
    this.forcePathStyle = config.forcePathStyle;
  }

  describe() {
    return {
      detail: `Bucket ${this.bucket} on ${this.endpoint.origin}.`,
      driver: "s3",
      label: "S3-compatible object storage",
      supportsS3CompatibleLayout: true,
    };
  }

  buildSignedRequest(method, key, body, contentType) {
    const payload = body || Buffer.alloc(0);
    const payloadHash = hashSha256(payload);
    const now = new Date();
    const { amzDate, dateStamp } = formatAmzDate(now);
    const url = new URL(this.endpoint.toString());
    const basePath = url.pathname.replace(/\/$/, "");
    const encodedKey = encodeS3Key(key);

    if (this.forcePathStyle) {
      url.pathname = `${basePath}/${encodeURIComponent(this.bucket)}/${encodedKey}`.replace(
        /\/{2,}/g,
        "/",
      );
    } else {
      url.hostname = `${this.bucket}.${url.hostname}`;
      url.pathname = `${basePath}/${encodedKey}`.replace(/\/{2,}/g, "/");
    }

    const headerMap = new Map([
      ["host", url.host],
      ["x-amz-content-sha256", payloadHash],
      ["x-amz-date", amzDate],
    ]);

    if (contentType) {
      headerMap.set("content-type", contentType);
    }

    const sortedHeaders = [...headerMap.entries()]
      .map(([name, value]) => [name.toLowerCase(), String(value).trim().replace(/\s+/g, " ")])
      .sort(([left], [right]) => left.localeCompare(right));
    const canonicalHeaders = `${sortedHeaders
      .map(([name, value]) => `${name}:${value}`)
      .join("\n")}\n`;
    const signedHeaders = sortedHeaders.map(([name]) => name).join(";");
    const canonicalRequest = [
      method,
      url.pathname || "/",
      "",
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join("\n");
    const credentialScope = `${dateStamp}/${this.region}/s3/aws4_request`;
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      credentialScope,
      hashSha256(canonicalRequest),
    ].join("\n");
    const signingKey = hmacSha256(
      hmacSha256(hmacSha256(hmacSha256(`AWS4${this.secretKey}`, dateStamp), this.region), "s3"),
      "aws4_request",
    );
    const signature = crypto
      .createHmac("sha256", signingKey)
      .update(stringToSign)
      .digest("hex");
    const headers = {
      Authorization: `AWS4-HMAC-SHA256 Credential=${this.accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
    };

    if (contentType) {
      headers["Content-Type"] = contentType;
    }

    return { headers, payload, url };
  }

  async putObject({ key, body, contentType }) {
    const request = this.buildSignedRequest("PUT", key, body, contentType);
    const response = await fetch(request.url, {
      body: request.payload,
      headers: request.headers,
      method: "PUT",
    });

    if (!response.ok) {
      throw createHttpError(502, "ClosetVault could not store the encrypted object in S3.");
    }
  }

  async getObject({ key }) {
    const request = this.buildSignedRequest("GET", key, null, null);
    const response = await fetch(request.url, {
      headers: request.headers,
      method: "GET",
    });

    if (!response.ok) {
      throw createHttpError(404, "ClosetVault could not find the requested object.");
    }

    return Buffer.from(await response.arrayBuffer());
  }

  async deleteObject({ key }) {
    const request = this.buildSignedRequest("DELETE", key, null, null);
    const response = await fetch(request.url, {
      headers: request.headers,
      method: "DELETE",
    });

    if (!response.ok && response.status !== 404) {
      throw createHttpError(502, "ClosetVault could not delete the requested object.");
    }
  }
}

function createStorageAdapter() {
  if (STORAGE_DRIVER === "s3") {
    return new S3CompatibleStorageAdapter({
      accessKey: process.env.CLOSETVAULT_S3_ACCESS_KEY,
      bucket: process.env.CLOSETVAULT_S3_BUCKET,
      endpoint: process.env.CLOSETVAULT_S3_ENDPOINT,
      forcePathStyle:
        process.env.CLOSETVAULT_S3_FORCE_PATH_STYLE === undefined
          ? true
          : parseBooleanFlag(process.env.CLOSETVAULT_S3_FORCE_PATH_STYLE),
      region: process.env.CLOSETVAULT_S3_REGION || "us-east-1",
      secretKey: process.env.CLOSETVAULT_S3_SECRET_KEY,
    });
  }

  return new FilesystemStorageAdapter(OBJECTS_DIR);
}

module.exports = {
  createStorageAdapter,
};
