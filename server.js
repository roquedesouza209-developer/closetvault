const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs/promises");
const crypto = require("node:crypto");

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number.parseInt(process.env.PORT || "3000", 10);
const DATA_DIR =
  process.env.CLOSETVAULT_DATA_DIR || path.join(__dirname, "data");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const FILES_FILE = path.join(DATA_DIR, "files.json");
const STORAGE_DIR = path.join(DATA_DIR, "storage");
const PUBLIC_DIR = path.join(__dirname, "public");
const SESSION_COOKIE = "closetvault_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7;
const MAX_UPLOAD_MB = Math.max(
  1,
  Number.parseInt(process.env.CLOSETVAULT_MAX_UPLOAD_MB || "10", 10) || 10,
);
const MAX_FILE_BYTES = MAX_UPLOAD_MB * 1024 * 1024;
const MAX_BODY_BYTES = Math.ceil(MAX_FILE_BYTES * 1.5) + 64 * 1024;
const CONTENT_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
};

const sessions = new Map();

async function fileExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function ensureStorageLayout() {
  await fs.mkdir(STORAGE_DIR, { recursive: true });

  if (!(await fileExists(USERS_FILE))) {
    await writeJson(USERS_FILE, { users: [] });
  }

  if (!(await fileExists(FILES_FILE))) {
    await writeJson(FILES_FILE, { files: [] });
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

async function writeJson(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function createHttpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
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

function parseCookies(cookieHeader = "") {
  return cookieHeader
    .split(";")
    .map((value) => value.trim())
    .filter(Boolean)
    .reduce((cookies, pair) => {
      const separatorIndex = pair.indexOf("=");

      if (separatorIndex === -1) {
        return cookies;
      }

      const key = pair.slice(0, separatorIndex).trim();
      const value = pair.slice(separatorIndex + 1).trim();
      cookies[key] = decodeURIComponent(value);
      return cookies;
    }, {});
}

function cleanSessions() {
  const now = Date.now();

  for (const [token, session] of sessions.entries()) {
    if (session.expiresAt <= now) {
      sessions.delete(token);
    }
  }
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

function sanitizeUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    createdAt: user.createdAt,
  };
}

function derivePasswordHash(password, salt) {
  return crypto.scryptSync(password, `auth:${salt}`, 64).toString("hex");
}

function deriveEncryptionKey(password, salt) {
  return crypto.scryptSync(password, `vault:${salt}`, 32);
}

function createSession(user, encryptionKey) {
  const token = crypto.randomBytes(32).toString("hex");
  const session = {
    token,
    userId: user.id,
    user: sanitizeUser(user),
    encryptionKey,
    expiresAt: Date.now() + SESSION_TTL_MS,
  };

  sessions.set(token, session);
  return session;
}

function getSessionFromRequest(req) {
  cleanSessions();

  const cookies = parseCookies(req.headers.cookie || "");
  const token = cookies[SESSION_COOKIE];

  if (!token) {
    return null;
  }

  const session = sessions.get(token);

  if (!session) {
    return null;
  }

  if (session.expiresAt <= Date.now()) {
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

function getFilePath(userId, fileId) {
  return path.join(STORAGE_DIR, userId, `${fileId}.bin`);
}

function toPublicFile(file) {
  return {
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    size: file.size,
    createdAt: file.createdAt,
    updatedAt: file.updatedAt,
  };
}

function buildStats(files) {
  const bytesUsed = files.reduce((total, file) => total + file.size, 0);
  const recentUploads = files.filter((file) => {
    const createdAt = Date.parse(file.createdAt);
    return Number.isFinite(createdAt) && Date.now() - createdAt < 1000 * 60 * 60 * 24 * 7;
  }).length;

  return {
    fileCount: files.length,
    bytesUsed,
    recentUploads,
    uploadLimitBytes: MAX_FILE_BYTES,
  };
}

function guessContentType(filePath) {
  return CONTENT_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

function buildContentDisposition(fileName) {
  const fallback = fileName.replace(/["\\]/g, "_") || "download.bin";
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(
    fileName,
  )}`;
}

function readRequestBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let receivedBytes = 0;
    let completed = false;

    req.on("data", (chunk) => {
      if (completed) {
        return;
      }

      receivedBytes += chunk.length;

      if (receivedBytes > limit) {
        completed = true;
        reject(
          createHttpError(
            413,
            `Upload is too large for this MVP. Files must stay under ${MAX_UPLOAD_MB} MB.`,
          ),
        );
        req.destroy();
        return;
      }

      chunks.push(chunk);
    });

    req.on("end", () => {
      if (completed) {
        return;
      }

      completed = true;
      resolve(Buffer.concat(chunks));
    });

    req.on("error", (error) => {
      if (completed) {
        return;
      }

      completed = true;
      reject(error);
    });
  });
}

async function readJsonBody(req, limit) {
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

async function loadUsersDocument() {
  return readJson(USERS_FILE, { users: [] });
}

async function loadFilesDocument() {
  return readJson(FILES_FILE, { files: [] });
}

async function handleRegister(req, res) {
  const body = await readJsonBody(req, 64 * 1024);
  const name = String(body.name || "").trim();
  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");

  if (name.length < 2) {
    throw createHttpError(400, "Tell ClosetVault who you are with a name of at least 2 characters.");
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw createHttpError(400, "Use a valid email address to create your vault.");
  }

  if (password.length < 8) {
    throw createHttpError(400, "Choose a password with at least 8 characters.");
  }

  const usersDocument = await loadUsersDocument();
  const existingUser = usersDocument.users.find((user) => user.email === email);

  if (existingUser) {
    throw createHttpError(409, "This email already has a ClosetVault account.");
  }

  const authSalt = crypto.randomBytes(16).toString("hex");
  const encryptionSalt = crypto.randomBytes(16).toString("hex");
  const user = {
    id: crypto.randomUUID(),
    name: name.slice(0, 64),
    email,
    authSalt,
    passwordHash: derivePasswordHash(password, authSalt),
    encryptionSalt,
    createdAt: new Date().toISOString(),
  };

  usersDocument.users.push(user);
  await writeJson(USERS_FILE, usersDocument);

  const session = createSession(user, deriveEncryptionKey(password, encryptionSalt));
  sendJson(
    res,
    201,
    {
      message: "Vault created. Your files will be encrypted at rest.",
      user: sanitizeUser(user),
    },
    { "Set-Cookie": buildSessionCookie(session.token) },
  );
}

async function handleLogin(req, res) {
  const body = await readJsonBody(req, 64 * 1024);
  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");

  const usersDocument = await loadUsersDocument();
  const user = usersDocument.users.find((entry) => entry.email === email);

  if (!user) {
    throw createHttpError(401, "We could not find a ClosetVault account with those credentials.");
  }

  const candidateHash = derivePasswordHash(password, user.authSalt);

  if (candidateHash !== user.passwordHash) {
    throw createHttpError(401, "We could not find a ClosetVault account with those credentials.");
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

async function handleSession(req, res) {
  const session = getSessionFromRequest(req);

  if (!session) {
    sendJson(res, 200, { authenticated: false });
    return;
  }

  const filesDocument = await loadFilesDocument();
  const userFiles = filesDocument.files.filter((file) => file.userId === session.userId);

  sendJson(res, 200, {
    authenticated: true,
    user: session.user,
    stats: buildStats(userFiles),
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

async function handleListFiles(req, res) {
  const session = requireSession(req);
  const filesDocument = await loadFilesDocument();
  const files = filesDocument.files
    .filter((file) => file.userId === session.userId)
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));

  sendJson(res, 200, {
    files: files.map(toPublicFile),
    stats: buildStats(files),
  });
}

async function handleUpload(req, res) {
  const session = requireSession(req);
  const body = await readJsonBody(req, MAX_BODY_BYTES);
  const name = String(body.name || "").trim();
  const mimeType =
    String(body.type || "application/octet-stream").trim() || "application/octet-stream";
  const declaredSize = Number.parseInt(String(body.size || "0"), 10);
  const base64Data = typeof body.data === "string" ? body.data : "";

  if (!name) {
    throw createHttpError(400, "Choose a file before uploading.");
  }

  if (!base64Data) {
    throw createHttpError(400, "The selected file could not be read.");
  }

  const fileBuffer = Buffer.from(base64Data, "base64");

  if (!fileBuffer.length && declaredSize > 0) {
    throw createHttpError(400, "The selected file could not be read.");
  }

  if (fileBuffer.length > MAX_FILE_BYTES) {
    throw createHttpError(
      413,
      `ClosetVault currently supports files up to ${MAX_UPLOAD_MB} MB in this MVP.`,
    );
  }

  if (Number.isFinite(declaredSize) && declaredSize !== fileBuffer.length) {
    throw createHttpError(400, "The upload payload was incomplete. Please try again.");
  }

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", session.encryptionKey, iv);
  const encryptedBuffer = Buffer.concat([cipher.update(fileBuffer), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const fileId = crypto.randomUUID();
  const userDirectory = path.join(STORAGE_DIR, session.userId);
  const timestamp = new Date().toISOString();
  const fileRecord = {
    id: fileId,
    userId: session.userId,
    name: name.slice(0, 180),
    mimeType: mimeType.slice(0, 128),
    size: fileBuffer.length,
    iv: iv.toString("hex"),
    authTag: authTag.toString("hex"),
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  await fs.mkdir(userDirectory, { recursive: true });
  await fs.writeFile(getFilePath(session.userId, fileId), encryptedBuffer);

  const filesDocument = await loadFilesDocument();
  filesDocument.files.push(fileRecord);
  await writeJson(FILES_FILE, filesDocument);

  const userFiles = filesDocument.files.filter((file) => file.userId === session.userId);
  sendJson(res, 201, {
    message: `${fileRecord.name} stored in your vault.`,
    file: toPublicFile(fileRecord),
    stats: buildStats(userFiles),
  });
}

async function handleDownload(req, res, fileId) {
  const session = requireSession(req);
  const filesDocument = await loadFilesDocument();
  const file = filesDocument.files.find(
    (entry) => entry.id === fileId && entry.userId === session.userId,
  );

  if (!file) {
    throw createHttpError(404, "This file is not in your vault.");
  }

  const encryptedBuffer = await fs.readFile(getFilePath(session.userId, file.id));

  try {
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      session.encryptionKey,
      Buffer.from(file.iv, "hex"),
    );
    decipher.setAuthTag(Buffer.from(file.authTag, "hex"));
    const decryptedBuffer = Buffer.concat([decipher.update(encryptedBuffer), decipher.final()]);

    sendBinary(res, 200, decryptedBuffer, {
      "Content-Disposition": buildContentDisposition(file.name),
      "Content-Length": String(decryptedBuffer.length),
      "Content-Type": file.mimeType || "application/octet-stream",
    });
  } catch {
    throw createHttpError(403, "This session can no longer unlock the requested file.");
  }
}

async function handleDelete(req, res, fileId) {
  const session = requireSession(req);
  const filesDocument = await loadFilesDocument();
  const fileIndex = filesDocument.files.findIndex(
    (entry) => entry.id === fileId && entry.userId === session.userId,
  );

  if (fileIndex === -1) {
    throw createHttpError(404, "This file is not in your vault.");
  }

  const [removedFile] = filesDocument.files.splice(fileIndex, 1);
  await writeJson(FILES_FILE, filesDocument);

  try {
    await fs.unlink(getFilePath(session.userId, removedFile.id));
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  const userFiles = filesDocument.files.filter((file) => file.userId === session.userId);
  sendJson(res, 200, {
    message: `${removedFile.name} removed from your vault.`,
    stats: buildStats(userFiles),
  });
}

async function serveStaticAsset(res, pathname) {
  const requestedPath = pathname === "/" ? "/index.html" : pathname;
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

    if (req.method === "GET" && pathname === "/api/files") {
      await handleListFiles(req, res);
      return;
    }

    if (req.method === "POST" && pathname === "/api/files/upload") {
      await handleUpload(req, res);
      return;
    }

    const downloadMatch = pathname.match(/^\/api\/files\/([^/]+)\/download$/);

    if (req.method === "GET" && downloadMatch) {
      await handleDownload(req, res, downloadMatch[1]);
      return;
    }

    const deleteMatch = pathname.match(/^\/api\/files\/([^/]+)$/);

    if (req.method === "DELETE" && deleteMatch) {
      await handleDelete(req, res, deleteMatch[1]);
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

if (require.main === module) {
  startServer()
    .then((server) => {
      const address = server.address();
      console.log(
        `ClosetVault is running on http://${address.address}:${address.port} with ${MAX_UPLOAD_MB} MB uploads.`,
      );
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}

module.exports = {
  createServer,
  ensureStorageLayout,
  startServer,
};
