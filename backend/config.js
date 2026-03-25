const path = require("node:path");

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number.parseInt(process.env.PORT || "3000", 10);
const DATA_DIR = process.env.CLOSETVAULT_DATA_DIR || path.join(__dirname, "..", "data");
const DATABASE_FILE = path.join(DATA_DIR, "closetvault.sqlite");
const LEGACY_USERS_FILE = path.join(DATA_DIR, "users.json");
const LEGACY_FILES_FILE = path.join(DATA_DIR, "files.json");
const OBJECTS_DIR = path.join(DATA_DIR, "objects");
const PUBLIC_DIR = path.join(__dirname, "..", "public");
const SESSION_COOKIE = "closetvault_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7;
const MAX_UPLOAD_MB = Math.max(
  1,
  Number.parseInt(process.env.CLOSETVAULT_MAX_UPLOAD_MB || "50", 10) || 50,
);
const STORAGE_CAP_MB = Math.max(
  MAX_UPLOAD_MB,
  Number.parseInt(process.env.CLOSETVAULT_STORAGE_CAP_MB || "5120", 10) || 5120,
);
const MAX_FILE_BYTES = MAX_UPLOAD_MB * 1024 * 1024;
const STORAGE_CAP_BYTES = STORAGE_CAP_MB * 1024 * 1024;
const RAW_BODY_LIMIT = MAX_FILE_BYTES + 16 * 1024;
const JSON_BODY_LIMIT = 256 * 1024;
const STORAGE_DRIVER = (process.env.CLOSETVAULT_STORAGE_DRIVER || "fs").toLowerCase();
const CONTENT_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
};
const DOCUMENT_EXTENSIONS = new Set([
  "csv",
  "doc",
  "docx",
  "md",
  "odp",
  "ods",
  "odt",
  "pdf",
  "ppt",
  "pptx",
  "rtf",
  "txt",
  "xls",
  "xlsx",
]);
const ARCHIVE_EXTENSIONS = new Set(["7z", "gz", "rar", "tar", "zip"]);

function parseBooleanFlag(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").toLowerCase());
}

module.exports = {
  ARCHIVE_EXTENSIONS,
  CONTENT_TYPES,
  DATA_DIR,
  DATABASE_FILE,
  DOCUMENT_EXTENSIONS,
  HOST,
  JSON_BODY_LIMIT,
  LEGACY_FILES_FILE,
  LEGACY_USERS_FILE,
  MAX_FILE_BYTES,
  MAX_UPLOAD_MB,
  OBJECTS_DIR,
  PORT,
  PUBLIC_DIR,
  RAW_BODY_LIMIT,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  STORAGE_CAP_BYTES,
  STORAGE_CAP_MB,
  STORAGE_DRIVER,
  parseBooleanFlag,
};
