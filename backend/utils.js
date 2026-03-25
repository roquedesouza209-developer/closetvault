const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const {
  ARCHIVE_EXTENSIONS,
  CONTENT_TYPES,
  DOCUMENT_EXTENSIONS,
} = require("./config");

function createHttpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

async function fileExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath, fallback) {
  try {
    const contents = await fs.readFile(filePath, "utf8");
    return JSON.parse(contents);
  } catch (error) {
    if (error.code === "ENOENT") {
      return fallback;
    }

    throw error;
  }
}

function normalizeFolderId(rawValue) {
  if (rawValue === undefined || rawValue === null) {
    return null;
  }

  const value = String(rawValue).trim();
  return value ? value : null;
}

function decodeHeaderValue(rawValue) {
  if (!rawValue) {
    return "";
  }

  try {
    return decodeURIComponent(String(rawValue));
  } catch {
    return String(rawValue);
  }
}

function normalizeEntityName(rawValue, label, maxLength) {
  const value = String(rawValue || "").trim();

  if (!value) {
    throw createHttpError(400, `${label} cannot be empty.`);
  }

  if (value === "." || value === "..") {
    throw createHttpError(400, `${label} is not valid.`);
  }

  if (/[<>:"/\\|?*\u0000-\u001f]/.test(value)) {
    throw createHttpError(
      400,
      `${label} contains characters Windows-style explorers reserve.`,
    );
  }

  return value.slice(0, maxLength);
}

function getFileExtension(fileName) {
  return path.extname(fileName).slice(1).toLowerCase();
}

function splitFileName(fileName) {
  const extension = path.extname(fileName);
  const stem = extension ? fileName.slice(0, -extension.length) : fileName;
  return {
    extension,
    stem: stem || fileName,
  };
}

function makeUniqueName(baseName, existingNames, preserveExtension) {
  const loweredNames = new Set(existingNames.map((value) => value.toLowerCase()));

  if (!loweredNames.has(baseName.toLowerCase())) {
    return baseName;
  }

  const { extension, stem } = splitFileName(baseName);
  let attempt = 2;

  while (attempt < 10_000) {
    const candidate = preserveExtension && extension
      ? `${stem} (${attempt})${extension}`
      : `${baseName} (${attempt})`;

    if (!loweredNames.has(candidate.toLowerCase())) {
      return candidate;
    }

    attempt += 1;
  }

  throw createHttpError(409, "ClosetVault could not find an available name.");
}

function getFileCategory(mimeType, fileName) {
  const extension = getFileExtension(fileName);

  if (mimeType.startsWith("image/")) {
    return "image";
  }

  if (mimeType.startsWith("video/")) {
    return "video";
  }

  if (mimeType.startsWith("audio/")) {
    return "audio";
  }

  if (DOCUMENT_EXTENSIONS.has(extension)) {
    return "document";
  }

  if (ARCHIVE_EXTENSIONS.has(extension)) {
    return "archive";
  }

  return "file";
}

function getTypeLabel(item) {
  if (item.kind === "folder") {
    return "File folder";
  }

  switch (item.category) {
    case "image":
      return "Image";
    case "video":
      return "Video";
    case "audio":
      return "Audio";
    case "document":
      return "Document";
    case "archive":
      return "Archive";
    default:
      return item.mimeType || "File";
  }
}

function derivePasswordHash(password, salt) {
  return crypto.scryptSync(password, `auth:${salt}`, 64).toString("hex");
}

function deriveEncryptionKey(password, salt) {
  return crypto.scryptSync(password, `vault:${salt}`, 32);
}

function sanitizeUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    createdAt: user.createdAt,
  };
}

function encryptBuffer(buffer, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encryptedBuffer = Buffer.concat([cipher.update(buffer), cipher.final()]);

  return {
    authTag: cipher.getAuthTag().toString("hex"),
    encryptedBuffer,
    iv: iv.toString("hex"),
  };
}

function decryptBuffer(buffer, key, iv, authTag) {
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "hex"));
  decipher.setAuthTag(Buffer.from(authTag, "hex"));
  return Buffer.concat([decipher.update(buffer), decipher.final()]);
}

function buildStorageKey(userId, fileId) {
  return `${userId}/${fileId}.bin`;
}

function buildContentDisposition(fileName) {
  const fallback = fileName.replace(/["\\]/g, "_") || "download.bin";
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(
    fileName,
  )}`;
}

function guessContentType(filePath) {
  return CONTENT_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

function commonHeaders(extraHeaders = {}) {
  return {
    "Cache-Control": "no-store",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Content-Type-Options": "nosniff",
    ...extraHeaders,
  };
}

function sendJson(res, statusCode, payload, extraHeaders = {}) {
  res.writeHead(
    statusCode,
    commonHeaders({
      "Content-Type": "application/json; charset=utf-8",
      ...extraHeaders,
    }),
  );
  res.end(JSON.stringify(payload));
}

function sendBinary(res, statusCode, payload, extraHeaders = {}) {
  res.writeHead(statusCode, commonHeaders(extraHeaders));
  res.end(payload);
}

module.exports = {
  buildContentDisposition,
  buildStorageKey,
  createHttpError,
  decodeHeaderValue,
  decryptBuffer,
  deriveEncryptionKey,
  derivePasswordHash,
  encryptBuffer,
  fileExists,
  getFileCategory,
  getFileExtension,
  getTypeLabel,
  guessContentType,
  makeUniqueName,
  normalizeEntityName,
  normalizeFolderId,
  readJson,
  sanitizeUser,
  sendBinary,
  sendJson,
};
