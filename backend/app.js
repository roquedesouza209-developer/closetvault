const http = require("node:http");
const fs = require("node:fs/promises");
const crypto = require("node:crypto");
const path = require("node:path");

const {
  HOST,
  JSON_BODY_LIMIT,
  MAX_FILE_BYTES,
  MAX_UPLOAD_MB,
  PORT,
  PUBLIC_DIR,
  RAW_BODY_LIMIT,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  STORAGE_CAP_BYTES,
  STORAGE_CAP_MB,
  MAX_FILE_BYTES: UPLOAD_LIMIT_BYTES,
  parseBooleanFlag,
} = require("./config");
const {
  buildFolderChildCountMap,
  closeResources,
  dbAll,
  dbRun,
  ensureStorageLayout,
  getActiveShareForFile,
  getFileRecord,
  getFileRecordById,
  getFolderRecord,
  getShareRecordById,
  getShareRecordByToken,
  getStorageAdapter,
  getUserById,
  getUserByEmail,
  getUserStats,
  listActiveFolders,
  listActiveSharesForOwner,
  listSiblingFileNames,
  listSiblingFolderNames,
  listSharedInbox,
  toPublicFile,
  toPublicFolder,
  toPublicShare,
  upsertSharedInbox,
} = require("./database");
const {
  buildContentDisposition,
  buildStorageKey,
  createHttpError,
  decodeHeaderValue,
  decryptBuffer,
  deriveEncryptionKey,
  derivePasswordHash,
  encryptBuffer,
  getFileCategory,
  getFileExtension,
  guessContentType,
  makeUniqueName,
  normalizeEntityName,
  normalizeFolderId,
  sanitizeUser,
  sendBinary,
  sendJson,
} = require("./utils");

const sessions = new Map();
const shareGrants = new Map();
const SHARE_GRANT_TTL_MS = 1000 * 60 * 20;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SUPPORT_MESSAGE_MIN_LENGTH = 10;
const SUPPORT_MESSAGE_MAX_LENGTH = 2000;
const SHARE_SNAPSHOT_KEY = crypto
  .createHash("sha256")
  .update(process.env.CLOSETVAULT_SHARE_SECRET || "closetvault-share-snapshot")
  .digest();

function decorateStats(stats) {
  return {
    ...stats,
    uploadLimitBytes: UPLOAD_LIMIT_BYTES,
  };
}

function parseCookies(cookieHeader = "") {
  return cookieHeader
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .reduce((cookies, part) => {
      const separatorIndex = part.indexOf("=");
      if (separatorIndex !== -1) {
        cookies[part.slice(0, separatorIndex)] = decodeURIComponent(
          part.slice(separatorIndex + 1),
        );
      }

      return cookies;
    }, {});
}

function buildSessionCookie(token) {
  const secureFlag = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${Math.floor(
    SESSION_TTL_MS / 1000,
  )}${secureFlag}`;
}

function buildClearedSessionCookie() {
  return `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`;
}

function cleanSessions() {
  const now = Date.now();
  for (const [token, session] of sessions.entries()) {
    if (session.expiresAt <= now) {
      sessions.delete(token);
    }
  }
}

function cleanShareGrants() {
  const now = Date.now();
  for (const [token, grant] of shareGrants.entries()) {
    if (grant.expiresAt <= now) {
      shareGrants.delete(token);
    }
  }
}

function invalidateShareGrants(shareId) {
  for (const [token, grant] of shareGrants.entries()) {
    if (grant.shareId === shareId) {
      shareGrants.delete(token);
    }
  }
}

function createSession(user, encryptionKey) {
  const token = crypto.randomBytes(32).toString("hex");
  const session = {
    encryptionKey,
    expiresAt: Date.now() + SESSION_TTL_MS,
    token,
    user: sanitizeUser(user),
    userId: user.id,
  };

  sessions.set(token, session);
  return session;
}

function getSessionFromRequest(req) {
  cleanSessions();
  const token = parseCookies(req.headers.cookie || "")[SESSION_COOKIE];

  if (!token) {
    return null;
  }

  const session = sessions.get(token);

  if (!session || session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }

  session.expiresAt = Date.now() + SESSION_TTL_MS;
  return session;
}

function requireSession(req) {
  const session = getSessionFromRequest(req);

  if (!session) {
    throw createHttpError(401, "Unlock your vault to continue.");
  }

  return session;
}

function readRequestBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    let completed = false;

    req.on("data", (chunk) => {
      if (completed) {
        return;
      }

      totalBytes += chunk.length;

      if (totalBytes > limit) {
        completed = true;
        reject(
          createHttpError(
            413,
            `ClosetVault limits uploads to ${MAX_UPLOAD_MB} MB per file in this build.`,
          ),
        );
        req.destroy();
        return;
      }

      chunks.push(chunk);
    });

    req.on("end", () => {
      if (!completed) {
        completed = true;
        resolve(Buffer.concat(chunks));
      }
    });

    req.on("error", (error) => {
      if (!completed) {
        completed = true;
        reject(error);
      }
    });
  });
}

async function readJsonBody(req, limit = JSON_BODY_LIMIT) {
  const body = await readRequestBody(req, limit);

  if (!body.length) {
    return {};
  }

  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw createHttpError(400, "Requests must include valid JSON.");
  }
}

function ensureFolderExists(userId, folderId) {
  if (!folderId) {
    return null;
  }

  const folder = getFolderRecord(userId, folderId);

  if (!folder) {
    throw createHttpError(404, "That folder is not available.");
  }

  return folder;
}

function ensureStorageCapacity(userId, nextFileSize) {
  if (getUserStats(userId).totalBytes + nextFileSize > STORAGE_CAP_BYTES) {
    throw createHttpError(
      413,
      `ClosetVault storage is full. This vault is capped at ${STORAGE_CAP_MB} MB right now.`,
    );
  }
}

function ensureUniqueName(existingNames, nextName, errorMessage) {
  if (existingNames.some((name) => name.toLowerCase() === nextName.toLowerCase())) {
    throw createHttpError(409, errorMessage);
  }
}

function sortExplorerItems(items, sortBy, sortDirection) {
  const direction = sortDirection === "asc" ? 1 : -1;
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

  return [...items].sort((left, right) => {
    if (left.kind !== right.kind) {
      return left.kind === "folder" ? -1 : 1;
    }

    let comparison;

    if (sortBy === "name") {
      comparison = collator.compare(left.name, right.name);
    } else if (sortBy === "size") {
      comparison = (left.size || 0) - (right.size || 0);
      if (comparison === 0) {
        comparison = collator.compare(left.name, right.name);
      }
    } else {
      comparison = Date.parse(left.updatedAt) - Date.parse(right.updatedAt);
      if (comparison === 0) {
        comparison = collator.compare(left.name, right.name);
      }
    }

    return comparison * direction;
  });
}

function buildBreadcrumb(folderMap, folderId, includeTrash = false) {
  const trail = [{ id: null, name: "Vault" }];

  if (includeTrash) {
    trail.push({ id: "trash", name: "Trash" });
    return trail;
  }

  const stack = [];
  let currentFolder = folderId ? folderMap.get(folderId) : null;

  while (currentFolder) {
    stack.push({ id: currentFolder.id, name: currentFolder.name });
    currentFolder = currentFolder.parentId ? folderMap.get(currentFolder.parentId) : null;
  }

  return trail.concat(stack.reverse());
}

function getUploadMetadata(req, requestUrl, rawBody) {
  const contentType = String(req.headers["content-type"] || "").toLowerCase();

  if (contentType.includes("application/json")) {
    const body = rawBody.length ? JSON.parse(rawBody.toString("utf8")) : {};
    return {
      buffer: Buffer.from(String(body.data || ""), "base64"),
      declaredSize: Number.parseInt(String(body.size || "0"), 10),
      folderId: normalizeFolderId(body.folderId ?? requestUrl.searchParams.get("folderId")),
      mimeType:
        String(body.type || "application/octet-stream").trim() || "application/octet-stream",
      name: normalizeEntityName(body.name, "File name", 180),
    };
  }

  return {
    buffer: rawBody,
    declaredSize: Number.parseInt(String(req.headers["x-closetvault-size"] || "0"), 10),
    folderId: normalizeFolderId(requestUrl.searchParams.get("folderId")),
    mimeType: String(req.headers["content-type"] || "application/octet-stream").trim(),
    name: normalizeEntityName(
      decodeHeaderValue(req.headers["x-closetvault-name"]),
      "File name",
      180,
    ),
  };
}

function validateUploadMetadata(metadata) {
  if (!metadata.buffer.length && metadata.declaredSize > 0) {
    throw createHttpError(400, "ClosetVault could not read the selected file.");
  }

  if (metadata.buffer.length > MAX_FILE_BYTES) {
    throw createHttpError(
      413,
      `ClosetVault currently supports files up to ${MAX_UPLOAD_MB} MB each.`,
    );
  }

  if (Number.isFinite(metadata.declaredSize) && metadata.declaredSize > 0) {
    if (metadata.declaredSize !== metadata.buffer.length) {
      throw createHttpError(400, "The upload payload was incomplete. Please try again.");
    }
  }
}

function buildInlineContentDisposition(fileName) {
  const fallback = fileName.replace(/["\\]/g, "_") || "preview.bin";
  return `inline; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

function parseRangeHeader(rangeHeader, size) {
  if (!rangeHeader || !String(rangeHeader).startsWith("bytes=") || size <= 0) {
    return null;
  }

  const rangeValue = String(rangeHeader).slice("bytes=".length).split(",")[0].trim();
  const [rawStart, rawEnd] = rangeValue.split("-");

  let start;
  let end;

  if (rawStart === "") {
    const suffixLength = Number.parseInt(rawEnd, 10);

    if (!Number.isFinite(suffixLength) || suffixLength <= 0) {
      return null;
    }

    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number.parseInt(rawStart, 10);
    end = rawEnd ? Number.parseInt(rawEnd, 10) : size - 1;

    if (!Number.isFinite(start) || start < 0) {
      return null;
    }

    if (!Number.isFinite(end) || end < start) {
      end = size - 1;
    }
  }

  if (start >= size) {
    return { invalid: true };
  }

  return {
    end: Math.min(end, size - 1),
    start,
  };
}

function isPreviewableFile(file) {
  const mimeType = String(file.mimeType || "").toLowerCase();
  const extension = String(file.extension || "").toLowerCase();

  return (
    mimeType === "application/pdf" ||
    mimeType === "audio/mpeg" ||
    mimeType === "video/mp4" ||
    mimeType === "image/jpeg" ||
    mimeType === "image/png" ||
    mimeType === "image/webp" ||
    extension === "pdf" ||
    extension === "mp3" ||
    extension === "mp4" ||
    extension === "jpg" ||
    extension === "jpeg" ||
    extension === "png" ||
    extension === "webp"
  );
}

async function readDecryptedFile(session, file) {
  try {
    const encryptedBuffer = await getStorageAdapter().getObject({ key: file.storageKey });
    return decryptBuffer(encryptedBuffer, session.encryptionKey, file.iv, file.authTag);
  } catch (error) {
    if (error.statusCode) {
      throw error;
    }

    throw createHttpError(403, "This session can no longer unlock the requested file.");
  }
}

function buildShareObjectKey(shareId) {
  return `shares/${shareId}.bin`;
}

function encryptShareSnapshot(buffer) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", SHARE_SNAPSHOT_KEY, iv);
  const encryptedBuffer = Buffer.concat([cipher.update(buffer), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encryptedBuffer]);
}

function decryptShareSnapshot(buffer) {
  if (!buffer || buffer.length < 28) {
    throw createHttpError(500, "ClosetVault could not unlock the shared file snapshot.");
  }

  const iv = buffer.subarray(0, 12);
  const authTag = buffer.subarray(12, 28);
  const encryptedBuffer = buffer.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", SHARE_SNAPSHOT_KEY, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encryptedBuffer), decipher.final()]);
}

function normalizeSharePermission(rawValue) {
  const permission = String(rawValue || "").trim().toLowerCase();

  if (permission === "view" || permission === "edit") {
    return permission;
  }

  throw createHttpError(400, "Share permission must be view or edit.");
}

function parseOptionalExpiration(rawValue) {
  if (rawValue === undefined || rawValue === null || String(rawValue).trim() === "") {
    return null;
  }

  const parsed = new Date(String(rawValue));

  if (Number.isNaN(parsed.getTime())) {
    throw createHttpError(400, "Use a valid expiration date and time.");
  }

  if (parsed.getTime() <= Date.now()) {
    throw createHttpError(400, "Choose an expiration time in the future.");
  }

  return parsed.toISOString();
}

function isShareExpired(share) {
  return Boolean(share?.expiresAt) && Date.parse(share.expiresAt) <= Date.now();
}

function ensureShareAccessible(share) {
  if (!share || share.revokedAt || isShareExpired(share)) {
    throw createHttpError(404, "This share link is no longer available.");
  }
}

function ensureSharedFileAvailable(file) {
  if (!file || file.deletedAt) {
    throw createHttpError(404, "This shared file is no longer available.");
  }
}

function buildShareDetails(share, file, owner) {
  return {
    file: {
      ...toPublicFile(file),
      previewable: isPreviewableFile(file),
    },
    share: {
      createdAt: share.createdAt,
      expiresAt: share.expiresAt || null,
      permission: share.permission,
      requiresPassword: Boolean(share.passwordHash),
      sharePath: `/s/${encodeURIComponent(share.token)}`,
      sharedBy: owner?.name || "ClosetVault user",
    },
  };
}

function buildSharedInboxEntry(entry) {
  return {
    createdAt: entry.createdAt,
    expiresAt: entry.expiresAt || null,
    file: {
      category: entry.category,
      createdAt: entry.fileCreatedAt,
      extension: entry.extension || "",
      id: entry.fileId,
      kind: "file",
      mimeType: entry.mimeType,
      name: entry.name,
      previewable: isPreviewableFile(entry),
      size: entry.size,
      typeLabel: toPublicFile({
        category: entry.category,
        createdAt: entry.fileCreatedAt,
        deletedAt: null,
        extension: entry.extension,
        folderId: null,
        id: entry.fileId,
        mimeType: entry.mimeType,
        name: entry.name,
        size: entry.size,
        trashedParentId: null,
        updatedAt: entry.fileUpdatedAt,
      }).typeLabel,
      updatedAt: entry.fileUpdatedAt,
    },
    lastAccessedAt: entry.lastAccessedAt,
    ownerEmail: entry.ownerEmail,
    ownerName: entry.ownerName,
    permission: entry.permission,
    shareId: entry.shareId,
    sharePath: `/s/${encodeURIComponent(entry.token)}`,
  };
}

function createShareGrant(share) {
  cleanShareGrants();
  const token = crypto.randomBytes(24).toString("base64url");
  shareGrants.set(token, {
    expiresAt: Date.now() + SHARE_GRANT_TTL_MS,
    fileId: share.fileId,
    permission: share.permission,
    shareId: share.id,
  });
  return token;
}

function getShareGrant(grantToken) {
  cleanShareGrants();

  if (!grantToken) {
    return null;
  }

  const grant = shareGrants.get(String(grantToken));

  if (!grant || grant.expiresAt <= Date.now()) {
    shareGrants.delete(String(grantToken));
    return null;
  }

  return grant;
}

async function revokeShareRecord(share, revokedAt = new Date().toISOString()) {
  if (!share || share.revokedAt) {
    return;
  }

  dbRun(
    `
      UPDATE shares
      SET revoked_at = ?
      WHERE id = ?
    `,
    revokedAt,
    share.id,
  );
  invalidateShareGrants(share.id);

  try {
    await getStorageAdapter().deleteObject({ key: buildShareObjectKey(share.id) });
  } catch (error) {
    if (error.statusCode && error.statusCode !== 404) {
      throw error;
    }
  }
}

async function revokeOpenSharesForFile(ownerUserId, fileId, revokedAt = new Date().toISOString()) {
  const openShares = dbAll(
    `
      SELECT
        id,
        owner_user_id AS ownerUserId,
        file_id AS fileId,
        token,
        permission,
        password_salt AS passwordSalt,
        password_hash AS passwordHash,
        expires_at AS expiresAt,
        created_at AS createdAt,
        revoked_at AS revokedAt,
        last_accessed_at AS lastAccessedAt
      FROM shares
      WHERE owner_user_id = ?
        AND file_id = ?
        AND revoked_at IS NULL
    `,
    ownerUserId,
    fileId,
  );

  for (const share of openShares) {
    await revokeShareRecord(share, revokedAt);
  }
}

async function readShareSnapshot(share) {
  try {
    const encryptedBuffer = await getStorageAdapter().getObject({
      key: buildShareObjectKey(share.id),
    });
    return decryptShareSnapshot(encryptedBuffer);
  } catch (error) {
    if (error.statusCode) {
      throw createHttpError(404, "This shared file is no longer available.");
    }

    throw createHttpError(500, "ClosetVault could not load the shared file.");
  }
}

function sendFileBuffer(req, res, file, buffer, disposition) {
  const range = parseRangeHeader(req.headers.range, buffer.length);

  if (range?.invalid) {
    res.writeHead(416, {
      "Accept-Ranges": "bytes",
      "Content-Range": `bytes */${buffer.length}`,
      "Content-Type": "application/json; charset=utf-8",
    });
    res.end(JSON.stringify({ error: "Requested range is not satisfiable." }));
    return;
  }

  const contentDisposition =
    disposition === "inline"
      ? buildInlineContentDisposition(file.name)
      : buildContentDisposition(file.name);

  if (range) {
    const payload = buffer.subarray(range.start, range.end + 1);
    sendBinary(res, 206, payload, {
      "Accept-Ranges": "bytes",
      "Content-Disposition": contentDisposition,
      "Content-Length": String(payload.length),
      "Content-Range": `bytes ${range.start}-${range.end}/${buffer.length}`,
      "Content-Type": file.mimeType || "application/octet-stream",
    });
    return;
  }

  sendBinary(res, 200, buffer, {
    "Accept-Ranges": "bytes",
    "Content-Disposition": contentDisposition,
    "Content-Length": String(buffer.length),
    "Content-Type": file.mimeType || "application/octet-stream",
  });
}

async function handleRegister(req, res) {
  const body = await readJsonBody(req);
  const name = normalizeEntityName(body.name, "Name", 64);
  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");

  if (!EMAIL_PATTERN.test(email)) {
    throw createHttpError(400, "Use a valid email address to create your vault.");
  }

  if (password.length < 8) {
    throw createHttpError(400, "Choose a password with at least 8 characters.");
  }

  if (getUserByEmail(email)) {
    throw createHttpError(409, "This email already has a ClosetVault account.");
  }

  const authSalt = crypto.randomBytes(16).toString("hex");
  const encryptionSalt = crypto.randomBytes(16).toString("hex");
  const user = {
    authSalt,
    createdAt: new Date().toISOString(),
    email,
    encryptionSalt,
    id: crypto.randomUUID(),
    name,
    passwordHash: derivePasswordHash(password, authSalt),
  };

  dbRun(
    `
      INSERT INTO users (
        id,
        name,
        email,
        auth_salt,
        password_hash,
        encryption_salt,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    user.id,
    user.name,
    user.email,
    user.authSalt,
    user.passwordHash,
    user.encryptionSalt,
    user.createdAt,
  );

  const session = createSession(user, deriveEncryptionKey(password, user.encryptionSalt));
  sendJson(
    res,
    201,
    {
      message: "Vault created. Your files and metadata are ready for explorer mode.",
      user: sanitizeUser(user),
    },
    { "Set-Cookie": buildSessionCookie(session.token) },
  );
}

async function handleLogin(req, res) {
  const body = await readJsonBody(req);
  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");
  const user = getUserByEmail(email);

  if (!user || derivePasswordHash(password, user.authSalt) !== user.passwordHash) {
    throw createHttpError(401, "We could not unlock a ClosetVault account with those credentials.");
  }

  const session = createSession(user, deriveEncryptionKey(password, user.encryptionSalt));
  sendJson(
    res,
    200,
    {
      message: "Vault unlocked.",
      user: sanitizeUser(user),
    },
    { "Set-Cookie": buildSessionCookie(session.token) },
  );
}

async function handleSupportRequest(req, res) {
  const session = getSessionFromRequest(req);
  const body = await readJsonBody(req);
  const email = String(body.email || "").trim().toLowerCase();
  const message = String(body.message || "").trim();

  if (!EMAIL_PATTERN.test(email)) {
    throw createHttpError(400, "Enter a valid support email address.");
  }

  if (message.length < SUPPORT_MESSAGE_MIN_LENGTH) {
    throw createHttpError(400, "Add a support message with at least 10 characters.");
  }

  if (message.length > SUPPORT_MESSAGE_MAX_LENGTH) {
    throw createHttpError(400, "Support messages must stay under 2000 characters.");
  }

  dbRun(
    `
      INSERT INTO support_requests (
        id,
        user_id,
        email,
        message,
        created_at
      ) VALUES (?, ?, ?, ?, ?)
    `,
    crypto.randomUUID(),
    session?.userId || null,
    email,
    message,
    new Date().toISOString(),
  );

  sendJson(res, 201, {
    message: "Support request sent. ClosetVault will follow up by email.",
  });
}

async function handleSession(req, res) {
  const session = getSessionFromRequest(req);

  if (!session) {
    sendJson(res, 200, { authenticated: false });
    return;
  }

  sendJson(res, 200, {
    authenticated: true,
    storage: getStorageAdapter().describe(),
    stats: decorateStats(getUserStats(session.userId)),
    user: session.user,
  });
}

function handleLogout(req, res) {
  const session = getSessionFromRequest(req);

  if (session) {
    sessions.delete(session.token);
  }

  sendJson(
    res,
    200,
    { message: "Vault locked." },
    { "Set-Cookie": buildClearedSessionCookie() },
  );
}

async function handleExplorer(req, res, requestUrl) {
  const session = requireSession(req);
  const showTrash = parseBooleanFlag(requestUrl.searchParams.get("trash"));
  const search = String(requestUrl.searchParams.get("search") || "").trim().toLowerCase();
  const sortBy = ["date", "name", "size"].includes(requestUrl.searchParams.get("sortBy"))
    ? requestUrl.searchParams.get("sortBy")
    : "date";
  const sortDirection = requestUrl.searchParams.get("sortDirection") === "asc" ? "asc" : "desc";
  const requestedFolderId = normalizeFolderId(requestUrl.searchParams.get("folderId"));
  const folders = listActiveFolders(session.userId);
  const folderMap = new Map(folders.map((folder) => [folder.id, folder]));
  const childCountMap = buildFolderChildCountMap(session.userId);
  const shareMap = new Map(
    listActiveSharesForOwner(session.userId).map((share) => [share.fileId, toPublicShare(share)]),
  );

  if (!showTrash && requestedFolderId && !folderMap.has(requestedFolderId)) {
    throw createHttpError(404, "That folder is not available.");
  }

  let currentFolder = {
    breadcrumb: buildBreadcrumb(folderMap, requestedFolderId),
    id: requestedFolderId,
    name: requestedFolderId ? folderMap.get(requestedFolderId).name : "Vault",
    parentId: requestedFolderId ? folderMap.get(requestedFolderId).parentId : null,
  };
  let items = [];

  if (showTrash) {
    items = dbAll(
      `
        SELECT
          id,
          user_id AS userId,
          folder_id AS folderId,
          name,
          mime_type AS mimeType,
          extension,
          category,
          size,
          storage_key AS storageKey,
          iv,
          auth_tag AS authTag,
          created_at AS createdAt,
          updated_at AS updatedAt,
          deleted_at AS deletedAt,
          trashed_parent_id AS trashedParentId
        FROM files
        WHERE user_id = ? AND deleted_at IS NOT NULL
        ORDER BY deleted_at DESC
      `,
      session.userId,
    )
      .map(toPublicFile)
      .filter((item) => !search || item.name.toLowerCase().includes(search));

    currentFolder = {
      breadcrumb: buildBreadcrumb(folderMap, null, true),
      id: "trash",
      name: "Trash",
      parentId: null,
    };
  } else {
    const folderItems = folders
      .filter((folder) => (folder.parentId || null) === requestedFolderId)
      .map((folder) => toPublicFolder(folder, childCountMap));
    const fileItems = dbAll(
      `
        SELECT
          id,
          user_id AS userId,
          folder_id AS folderId,
          name,
          mime_type AS mimeType,
          extension,
          category,
          size,
          storage_key AS storageKey,
          iv,
          auth_tag AS authTag,
          created_at AS createdAt,
          updated_at AS updatedAt,
          deleted_at AS deletedAt,
          trashed_parent_id AS trashedParentId
        FROM files
        WHERE user_id = ?
          AND deleted_at IS NULL
          AND folder_id IS ?
      `,
      session.userId,
      requestedFolderId,
    ).map((file) => ({
      ...toPublicFile(file),
      share: shareMap.get(file.id) || null,
    }));

    items = [...folderItems, ...fileItems].filter(
      (item) => !search || item.name.toLowerCase().includes(search),
    );
  }

  sendJson(res, 200, {
    currentFolder,
    folderTree: folders.map((folder) => toPublicFolder(folder, childCountMap)),
    items: sortExplorerItems(items, sortBy, sortDirection),
    search,
    showTrash,
    sharedWithMe: listSharedInbox(session.userId).map(buildSharedInboxEntry),
    sortBy,
    sortDirection,
    stats: decorateStats(getUserStats(session.userId)),
    storage: getStorageAdapter().describe(),
  });
}

async function handleCreateFolder(req, res) {
  const session = requireSession(req);
  const body = await readJsonBody(req);
  const parentId = normalizeFolderId(body.parentId);
  const name = normalizeEntityName(body.name || "New folder", "Folder name", 120);

  ensureFolderExists(session.userId, parentId);

  const folder = {
    createdAt: new Date().toISOString(),
    id: crypto.randomUUID(),
    name: makeUniqueName(name, listSiblingFolderNames(session.userId, parentId), false),
    parentId,
    updatedAt: new Date().toISOString(),
  };

  dbRun(
    `
      INSERT INTO folders (
        id,
        user_id,
        parent_id,
        name,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `,
    folder.id,
    session.userId,
    folder.parentId,
    folder.name,
    folder.createdAt,
    folder.updatedAt,
  );

  sendJson(res, 201, {
    folder: toPublicFolder(folder, new Map()),
    message: `${folder.name} created.`,
  });
}

async function handleRenameFolder(req, res, folderId) {
  const session = requireSession(req);
  const body = await readJsonBody(req);
  const folder = ensureFolderExists(session.userId, folderId);
  const nextName = normalizeEntityName(body.name, "Folder name", 120);

  ensureUniqueName(
    listSiblingFolderNames(session.userId, folder.parentId, folder.id),
    nextName,
    "A folder with that name already exists here.",
  );

  dbRun(
    `
      UPDATE folders
      SET name = ?, updated_at = ?
      WHERE id = ? AND user_id = ?
    `,
    nextName,
    new Date().toISOString(),
    folder.id,
    session.userId,
  );

  sendJson(res, 200, {
    message: `Folder renamed to ${nextName}.`,
  });
}

async function handleDeleteFolder(req, res, folderId) {
  const session = requireSession(req);
  const folder = ensureFolderExists(session.userId, folderId);
  const childFolder = dbAll(
    `
      SELECT id
      FROM folders
      WHERE user_id = ? AND parent_id = ?
      LIMIT 1
    `,
    session.userId,
    folder.id,
  )[0];
  const childFile = dbAll(
    `
      SELECT id
      FROM files
      WHERE user_id = ?
        AND deleted_at IS NULL
        AND folder_id = ?
      LIMIT 1
    `,
    session.userId,
    folder.id,
  )[0];

  if (childFolder || childFile) {
    throw createHttpError(
      409,
      "Move or remove the folder contents before deleting this folder.",
    );
  }

  dbRun(
    `
      DELETE FROM folders
      WHERE id = ? AND user_id = ?
    `,
    folder.id,
    session.userId,
  );

  sendJson(res, 200, {
    message: `${folder.name} deleted.`,
  });
}

async function handleUpload(req, res, requestUrl) {
  const session = requireSession(req);
  const rawBody = await readRequestBody(req, RAW_BODY_LIMIT);
  const metadata = getUploadMetadata(req, requestUrl, rawBody);

  validateUploadMetadata(metadata);
  ensureFolderExists(session.userId, metadata.folderId);
  ensureStorageCapacity(session.userId, metadata.buffer.length);

  const record = {
    authTag: "",
    category: getFileCategory(metadata.mimeType || "application/octet-stream", metadata.name),
    createdAt: new Date().toISOString(),
    deletedAt: null,
    extension: getFileExtension(metadata.name),
    folderId: metadata.folderId,
    id: crypto.randomUUID(),
    iv: "",
    mimeType: metadata.mimeType || "application/octet-stream",
    name: makeUniqueName(
      metadata.name,
      listSiblingFileNames(session.userId, metadata.folderId),
      true,
    ),
    size: metadata.buffer.length,
    storageKey: buildStorageKey(session.userId, crypto.randomUUID()),
    trashedParentId: null,
    updatedAt: new Date().toISOString(),
  };
  const encrypted = encryptBuffer(metadata.buffer, session.encryptionKey);

  record.storageKey = buildStorageKey(session.userId, record.id);
  record.extension = getFileExtension(record.name);
  record.category = getFileCategory(record.mimeType, record.name);
  record.iv = encrypted.iv;
  record.authTag = encrypted.authTag;

  await getStorageAdapter().putObject({
    body: encrypted.encryptedBuffer,
    contentType: "application/octet-stream",
    key: record.storageKey,
  });

  try {
    dbRun(
      `
        INSERT INTO files (
          id,
          user_id,
          folder_id,
          name,
          mime_type,
          extension,
          category,
          size,
          storage_key,
          iv,
          auth_tag,
          created_at,
          updated_at,
          deleted_at,
          trashed_parent_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      record.id,
      session.userId,
      record.folderId,
      record.name,
      record.mimeType,
      record.extension,
      record.category,
      record.size,
      record.storageKey,
      record.iv,
      record.authTag,
      record.createdAt,
      record.updatedAt,
      null,
      null,
    );
  } catch (error) {
    await getStorageAdapter().deleteObject({ key: record.storageKey });
    throw error;
  }

  sendJson(res, 201, {
    file: toPublicFile(record),
    message: `${record.name} uploaded to ClosetVault.`,
    stats: decorateStats(getUserStats(session.userId)),
  });
}

async function handleUpdateFile(req, res, fileId) {
  const session = requireSession(req);
  const file = getFileRecord(session.userId, fileId);

  if (!file) {
    throw createHttpError(404, "That file is not available.");
  }

  if (file.deletedAt) {
    throw createHttpError(409, "Restore the file from Trash before editing it.");
  }

  const body = await readJsonBody(req);
  const nextFolderId = Object.prototype.hasOwnProperty.call(body, "folderId")
    ? normalizeFolderId(body.folderId)
    : file.folderId;
  const nextName = Object.prototype.hasOwnProperty.call(body, "name")
    ? normalizeEntityName(body.name, "File name", 180)
    : file.name;

  ensureFolderExists(session.userId, nextFolderId);
  ensureUniqueName(
    listSiblingFileNames(session.userId, nextFolderId, file.id),
    nextName,
    "A file with that name already exists in this folder.",
  );

  dbRun(
    `
      UPDATE files
      SET name = ?, folder_id = ?, updated_at = ?
      WHERE id = ? AND user_id = ?
    `,
    nextName,
    nextFolderId,
    new Date().toISOString(),
    file.id,
    session.userId,
  );

  sendJson(res, 200, {
    message:
      nextFolderId !== file.folderId
        ? `${nextName} moved successfully.`
        : `${nextName} saved successfully.`,
  });
}

async function handleDeleteFile(req, res, fileId, permanentDelete) {
  const session = requireSession(req);
  const file = getFileRecord(session.userId, fileId);

  if (!file) {
    throw createHttpError(404, "That file is not available.");
  }

  await revokeOpenSharesForFile(session.userId, file.id);

  if (permanentDelete) {
    dbRun(
      `
        DELETE FROM files
        WHERE id = ? AND user_id = ?
      `,
      file.id,
      session.userId,
    );
    await getStorageAdapter().deleteObject({ key: file.storageKey });

    sendJson(res, 200, {
      message: `${file.name} permanently deleted.`,
      stats: decorateStats(getUserStats(session.userId)),
    });
    return;
  }

  if (file.deletedAt) {
    throw createHttpError(409, "This file is already in Trash.");
  }

  const deletedAt = new Date().toISOString();
  dbRun(
    `
      UPDATE files
      SET deleted_at = ?, trashed_parent_id = folder_id, updated_at = ?
      WHERE id = ? AND user_id = ?
    `,
    deletedAt,
    deletedAt,
    file.id,
    session.userId,
  );

  sendJson(res, 200, {
    message: `${file.name} moved to Trash.`,
    stats: decorateStats(getUserStats(session.userId)),
  });
}

async function handleRestoreFile(req, res, fileId) {
  const session = requireSession(req);
  const file = getFileRecord(session.userId, fileId);

  if (!file) {
    throw createHttpError(404, "That file is not available.");
  }

  if (!file.deletedAt) {
    throw createHttpError(409, "This file is already in your vault.");
  }

  const restoreFolderId =
    file.trashedParentId && getFolderRecord(session.userId, file.trashedParentId)
      ? file.trashedParentId
      : null;
  const restoreName = makeUniqueName(
    file.name,
    listSiblingFileNames(session.userId, restoreFolderId),
    true,
  );

  dbRun(
    `
      UPDATE files
      SET
        name = ?,
        folder_id = ?,
        deleted_at = NULL,
        trashed_parent_id = NULL,
        updated_at = ?
      WHERE id = ? AND user_id = ?
    `,
    restoreName,
    restoreFolderId,
    new Date().toISOString(),
    file.id,
    session.userId,
  );

  sendJson(res, 200, {
    message: `${restoreName} restored from Trash.`,
    stats: decorateStats(getUserStats(session.userId)),
  });
}

async function handleCreateShare(req, res, fileId) {
  const session = requireSession(req);
  const file = getFileRecord(session.userId, fileId);

  if (!file) {
    throw createHttpError(404, "That file is not available.");
  }

  if (file.deletedAt) {
    throw createHttpError(409, "Restore the file from Trash before sharing it.");
  }

  const body = await readJsonBody(req);
  const permission = normalizeSharePermission(body.permission);
  const expiresAt = parseOptionalExpiration(body.expiresAt);
  const password = String(body.password || "").trim();

  if (password && password.length < 4) {
    throw createHttpError(400, "Use at least 4 characters for a share password.");
  }

  const createdAt = new Date().toISOString();
  const passwordSalt = password ? crypto.randomBytes(16).toString("hex") : null;
  const share = {
    createdAt,
    expiresAt,
    fileId: file.id,
    id: crypto.randomUUID(),
    lastAccessedAt: null,
    ownerUserId: session.userId,
    passwordHash: password ? derivePasswordHash(password, passwordSalt) : null,
    passwordSalt,
    permission,
    revokedAt: null,
    token: crypto.randomBytes(24).toString("base64url"),
  };

  await revokeOpenSharesForFile(session.userId, file.id, createdAt);

  const decryptedBuffer = await readDecryptedFile(session, file);
  const snapshot = encryptShareSnapshot(decryptedBuffer);

  await getStorageAdapter().putObject({
    body: snapshot,
    contentType: "application/octet-stream",
    key: buildShareObjectKey(share.id),
  });

  try {
    dbRun(
      `
        INSERT INTO shares (
          id,
          owner_user_id,
          file_id,
          token,
          permission,
          password_salt,
          password_hash,
          expires_at,
          created_at,
          revoked_at,
          last_accessed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      share.id,
      share.ownerUserId,
      share.fileId,
      share.token,
      share.permission,
      share.passwordSalt,
      share.passwordHash,
      share.expiresAt,
      share.createdAt,
      null,
      null,
    );
  } catch (error) {
    await getStorageAdapter().deleteObject({ key: buildShareObjectKey(share.id) });
    throw error;
  }

  sendJson(res, 201, {
    message: `${file.name} is now shared by link.`,
    share: toPublicShare(share),
  });
}

async function handleRevokeShare(req, res, shareId) {
  const session = requireSession(req);
  const share = getShareRecordById(session.userId, shareId);

  if (!share) {
    throw createHttpError(404, "That share link is not available.");
  }

  await revokeShareRecord(share);

  sendJson(res, 200, {
    message: "Share link revoked.",
  });
}

async function handleShareStatus(req, res, shareToken) {
  const share = getShareRecordByToken(shareToken);

  ensureShareAccessible(share);

  const file = getFileRecordById(share.fileId);
  ensureSharedFileAvailable(file);

  const owner = getUserById(share.ownerUserId);
  const details = buildShareDetails(share, file, owner);

  sendJson(res, 200, {
    file: share.passwordHash ? null : details.file,
    share: details.share,
  });
}

async function handleShareAccess(req, res, shareToken) {
  const share = getShareRecordByToken(shareToken);

  ensureShareAccessible(share);

  const file = getFileRecordById(share.fileId);
  ensureSharedFileAvailable(file);

  const body = await readJsonBody(req);
  const providedPassword = String(body.password || "");

  if (share.passwordHash) {
    if (!providedPassword) {
      throw createHttpError(401, "Enter the share password to continue.");
    }

    if (derivePasswordHash(providedPassword, share.passwordSalt) !== share.passwordHash) {
      throw createHttpError(401, "That share password is incorrect.");
    }
  }

  const accessedAt = new Date().toISOString();
  dbRun(
    `
      UPDATE shares
      SET last_accessed_at = ?
      WHERE id = ?
    `,
    accessedAt,
    share.id,
  );

  const viewerSession = getSessionFromRequest(req);
  if (viewerSession && viewerSession.userId !== share.ownerUserId) {
    upsertSharedInbox(viewerSession.userId, share.id, accessedAt);
  }

  const owner = getUserById(share.ownerUserId);

  sendJson(res, 200, {
    ...buildShareDetails(share, file, owner),
    grant: createShareGrant(share),
  });
}

function resolveGrantedShare(requestUrl, shareToken, requireEdit = false) {
  const share = getShareRecordByToken(shareToken);

  ensureShareAccessible(share);

  const grantToken = String(requestUrl.searchParams.get("grant") || "");
  const grant = getShareGrant(grantToken);

  if (!grant || grant.shareId !== share.id || grant.fileId !== share.fileId) {
    throw createHttpError(401, "This shared session is no longer active.");
  }

  if (requireEdit && grant.permission !== "edit") {
    throw createHttpError(403, "This share link does not include edit access.");
  }

  const file = getFileRecordById(share.fileId);
  ensureSharedFileAvailable(file);

  return { file, grant, share };
}

async function handleSharedContent(req, res, requestUrl, shareToken) {
  const { file, share } = resolveGrantedShare(requestUrl, shareToken);
  const snapshot = await readShareSnapshot(share);
  const disposition = parseBooleanFlag(requestUrl.searchParams.get("download"))
    ? "attachment"
    : isPreviewableFile(file)
      ? "inline"
      : "attachment";

  sendFileBuffer(req, res, file, snapshot, disposition);
}

async function handleSharedEdit(req, res, requestUrl, shareToken) {
  const { file } = resolveGrantedShare(requestUrl, shareToken, true);
  const body = await readJsonBody(req);
  const nextName = normalizeEntityName(body.name, "File name", 180);

  ensureUniqueName(
    listSiblingFileNames(file.userId, file.folderId, file.id),
    nextName,
    "A file with that name already exists in this folder.",
  );

  const updatedAt = new Date().toISOString();
  dbRun(
    `
      UPDATE files
      SET name = ?, updated_at = ?
      WHERE id = ? AND user_id = ?
    `,
    nextName,
    updatedAt,
    file.id,
    file.userId,
  );

  sendJson(res, 200, {
    file: {
      ...toPublicFile({
        ...file,
        name: nextName,
        updatedAt,
      }),
      previewable: isPreviewableFile({
        ...file,
        name: nextName,
      }),
    },
    message: `Shared file renamed to ${nextName}.`,
  });
}

async function handlePreview(req, res, fileId) {
  const session = requireSession(req);
  const file = getFileRecord(session.userId, fileId);

  if (!file) {
    throw createHttpError(404, "That file is not available.");
  }

  if (file.deletedAt) {
    throw createHttpError(409, "Restore the file from Trash before previewing it.");
  }

  if (!isPreviewableFile(file)) {
    throw createHttpError(415, "ClosetVault cannot preview this file type yet.");
  }

  const decryptedBuffer = await readDecryptedFile(session, file);
  sendFileBuffer(req, res, file, decryptedBuffer, "inline");
}

async function handleDownload(req, res, fileId) {
  const session = requireSession(req);
  const file = getFileRecord(session.userId, fileId);

  if (!file) {
    throw createHttpError(404, "That file is not available.");
  }

  if (file.deletedAt) {
    throw createHttpError(409, "Restore the file from Trash before downloading it.");
  }

  const decryptedBuffer = await readDecryptedFile(session, file);
  sendFileBuffer(req, res, file, decryptedBuffer, "attachment");
}

async function serveStaticAsset(res, pathname) {
  const requestedPath =
    pathname === "/"
      ? "/index.html"
      : pathname.startsWith("/s/")
        ? "/share.html"
        : pathname;
  const normalizedPath = path.normalize(requestedPath).replace(/^(\.\.[/\\])+/, "");
  const assetPath = path.join(PUBLIC_DIR, normalizedPath);
  const relativePath = path.relative(PUBLIC_DIR, assetPath);

  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw createHttpError(403, "That asset is not available.");
  }

  try {
    const stats = await fs.stat(assetPath);
    if (stats.isDirectory()) {
      throw createHttpError(404, "Not found.");
    }
  } catch (error) {
    if (error.statusCode) {
      throw error;
    }

    if (error.code === "ENOENT") {
      throw createHttpError(404, "Not found.");
    }

    throw error;
  }

  const contents = await fs.readFile(assetPath);
  sendBinary(res, 200, contents, {
    "Cache-Control": assetPath.endsWith(".html") ? "no-store" : "public, max-age=300",
    "Content-Type": guessContentType(assetPath),
  });
}

async function handleRequest(req, res) {
  const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = requestUrl.pathname;

  try {
    if (req.method === "POST" && pathname === "/api/auth/register") {
      await handleRegister(req, res);
      return;
    }

    if (req.method === "POST" && pathname === "/api/auth/login") {
      await handleLogin(req, res);
      return;
    }

    if (req.method === "GET" && pathname === "/api/auth/session") {
      await handleSession(req, res);
      return;
    }

    if (req.method === "POST" && pathname === "/api/auth/logout") {
      handleLogout(req, res);
      return;
    }

    if (req.method === "POST" && pathname === "/api/support") {
      await handleSupportRequest(req, res);
      return;
    }

    if (req.method === "GET" && pathname === "/api/explorer") {
      await handleExplorer(req, res, requestUrl);
      return;
    }

    if (req.method === "POST" && pathname === "/api/folders") {
      await handleCreateFolder(req, res);
      return;
    }

    const folderMatch = pathname.match(/^\/api\/folders\/([^/]+)$/);

    if (folderMatch && req.method === "PATCH") {
      await handleRenameFolder(req, res, folderMatch[1]);
      return;
    }

    if (folderMatch && req.method === "DELETE") {
      await handleDeleteFolder(req, res, folderMatch[1]);
      return;
    }

    if (req.method === "POST" && pathname === "/api/files/upload") {
      await handleUpload(req, res, requestUrl);
      return;
    }

    const fileShareMatch = pathname.match(/^\/api\/files\/([^/]+)\/shares$/);

    if (fileShareMatch && req.method === "POST") {
      await handleCreateShare(req, res, fileShareMatch[1]);
      return;
    }

    const previewMatch = pathname.match(/^\/api\/files\/([^/]+)\/preview$/);

    if (previewMatch && req.method === "GET") {
      await handlePreview(req, res, previewMatch[1]);
      return;
    }

    const downloadMatch = pathname.match(/^\/api\/files\/([^/]+)\/download$/);

    if (downloadMatch && req.method === "GET") {
      await handleDownload(req, res, downloadMatch[1]);
      return;
    }

    const restoreMatch = pathname.match(/^\/api\/files\/([^/]+)\/restore$/);

    if (restoreMatch && req.method === "POST") {
      await handleRestoreFile(req, res, restoreMatch[1]);
      return;
    }

    const shareMatch = pathname.match(/^\/api\/shares\/([^/]+)$/);

    if (shareMatch && req.method === "DELETE") {
      await handleRevokeShare(req, res, shareMatch[1]);
      return;
    }

    const publicShareAccessMatch = pathname.match(/^\/api\/share-links\/([^/]+)\/access$/);

    if (publicShareAccessMatch && req.method === "POST") {
      await handleShareAccess(req, res, publicShareAccessMatch[1]);
      return;
    }

    const publicShareContentMatch = pathname.match(/^\/api\/share-links\/([^/]+)\/content$/);

    if (publicShareContentMatch && req.method === "GET") {
      await handleSharedContent(req, res, requestUrl, publicShareContentMatch[1]);
      return;
    }

    const publicShareFileMatch = pathname.match(/^\/api\/share-links\/([^/]+)\/file$/);

    if (publicShareFileMatch && req.method === "PATCH") {
      await handleSharedEdit(req, res, requestUrl, publicShareFileMatch[1]);
      return;
    }

    const publicShareMatch = pathname.match(/^\/api\/share-links\/([^/]+)$/);

    if (publicShareMatch && req.method === "GET") {
      await handleShareStatus(req, res, publicShareMatch[1]);
      return;
    }

    const fileMatch = pathname.match(/^\/api\/files\/([^/]+)$/);

    if (fileMatch && req.method === "PATCH") {
      await handleUpdateFile(req, res, fileMatch[1]);
      return;
    }

    if (fileMatch && req.method === "DELETE") {
      await handleDeleteFile(
        req,
        res,
        fileMatch[1],
        parseBooleanFlag(requestUrl.searchParams.get("permanent")),
      );
      return;
    }

    if (pathname.startsWith("/api/")) {
      throw createHttpError(404, "Endpoint not found.");
    }

    await serveStaticAsset(res, pathname);
  } catch (error) {
    const statusCode = error.statusCode || 500;

    if (statusCode >= 500) {
      console.error(error);
    }

    sendJson(res, statusCode, {
      error:
        statusCode >= 500
          ? "ClosetVault hit an unexpected problem."
          : error.message || "Request failed.",
    });
  }
}

function createServer() {
  return http.createServer((req, res) => {
    handleRequest(req, res);
  });
}

async function startServer({ host = HOST, port = PORT } = {}) {
  await ensureStorageLayout();

  return new Promise((resolve) => {
    const server = createServer();
    server.listen(port, host, () => resolve(server));
  });
}

setInterval(cleanSessions, 1000 * 60 * 60).unref();
setInterval(cleanShareGrants, 1000 * 60 * 10).unref();

module.exports = {
  closeResources,
  createServer,
  startServer,
};
