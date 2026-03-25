const fs = require("node:fs/promises");
const { DatabaseSync } = require("node:sqlite");

const {
  DATABASE_FILE,
  DATA_DIR,
  LEGACY_FILES_FILE,
  LEGACY_USERS_FILE,
  OBJECTS_DIR,
  STORAGE_CAP_BYTES,
  STORAGE_CAP_MB,
  STORAGE_DRIVER,
} = require("./config");
const { createStorageAdapter } = require("./storage");
const {
  buildStorageKey,
  createHttpError,
  fileExists,
  getFileCategory,
  getFileExtension,
  getTypeLabel,
  readJson,
} = require("./utils");

let database = null;
let storageAdapter = null;

function getDatabase() {
  if (!database) {
    throw createHttpError(500, "ClosetVault database has not been initialized.");
  }

  return database;
}

function getStorageAdapter() {
  if (!storageAdapter) {
    throw createHttpError(500, "ClosetVault storage has not been initialized.");
  }

  return storageAdapter;
}

function closeResources() {
  if (database) {
    database.close();
    database = null;
  }

  storageAdapter = null;
}

function dbGet(sql, ...params) {
  return getDatabase().prepare(sql).get(...params) || null;
}

function dbAll(sql, ...params) {
  return getDatabase().prepare(sql).all(...params);
}

function dbRun(sql, ...params) {
  return getDatabase().prepare(sql).run(...params);
}

async function migrateLegacyDataIfNeeded(hadDatabaseBefore) {
  if (hadDatabaseBefore) {
    return;
  }

  const usersDocument = await readJson(LEGACY_USERS_FILE, null);
  const filesDocument = await readJson(LEGACY_FILES_FILE, null);

  if (!usersDocument && !filesDocument) {
    return;
  }

  const db = getDatabase();
  db.exec("BEGIN");

  try {
    for (const user of usersDocument?.users || []) {
      dbRun(
        `
          INSERT OR IGNORE INTO users (
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
    }

    for (const file of filesDocument?.files || []) {
      dbRun(
        `
          INSERT OR IGNORE INTO files (
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
        file.id,
        file.userId,
        null,
        file.name,
        file.mimeType || "application/octet-stream",
        getFileExtension(file.name),
        getFileCategory(file.mimeType || "application/octet-stream", file.name),
        file.size || 0,
        buildStorageKey(file.userId, file.id),
        file.iv,
        file.authTag,
        file.createdAt,
        file.updatedAt,
        null,
        null,
      );
    }

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

async function ensureStorageLayout() {
  const hadDatabaseBefore = await fileExists(DATABASE_FILE);

  await fs.mkdir(DATA_DIR, { recursive: true });

  if (STORAGE_DRIVER === "fs") {
    await fs.mkdir(OBJECTS_DIR, { recursive: true });
  }

  if (!storageAdapter) {
    storageAdapter = createStorageAdapter();
  }

  if (!database) {
    database = new DatabaseSync(DATABASE_FILE);
    database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        auth_salt TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        encryption_salt TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS folders (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        parent_id TEXT,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS files (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        folder_id TEXT,
        name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        extension TEXT,
        category TEXT NOT NULL,
        size INTEGER NOT NULL,
        storage_key TEXT NOT NULL UNIQUE,
        iv TEXT NOT NULL,
        auth_tag TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT,
        trashed_parent_id TEXT
      );

      CREATE TABLE IF NOT EXISTS shares (
        id TEXT PRIMARY KEY,
        owner_user_id TEXT NOT NULL,
        file_id TEXT NOT NULL,
        token TEXT NOT NULL UNIQUE,
        permission TEXT NOT NULL,
        password_salt TEXT,
        password_hash TEXT,
        expires_at TEXT,
        created_at TEXT NOT NULL,
        revoked_at TEXT,
        last_accessed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS shared_inbox (
        user_id TEXT NOT NULL,
        share_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_accessed_at TEXT NOT NULL,
        PRIMARY KEY (user_id, share_id)
      );

      CREATE INDEX IF NOT EXISTS idx_folders_user_parent
        ON folders(user_id, parent_id);

      CREATE INDEX IF NOT EXISTS idx_files_user_folder_deleted
        ON files(user_id, folder_id, deleted_at);

      CREATE INDEX IF NOT EXISTS idx_files_user_deleted
        ON files(user_id, deleted_at);

      CREATE INDEX IF NOT EXISTS idx_shares_owner_file
        ON shares(owner_user_id, file_id);

      CREATE INDEX IF NOT EXISTS idx_shares_token
        ON shares(token);

      CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_folder_name
        ON folders(user_id, COALESCE(parent_id, ''), LOWER(name));

      CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_active_file_name
        ON files(user_id, COALESCE(folder_id, ''), LOWER(name))
        WHERE deleted_at IS NULL;
    `);
  }

  await migrateLegacyDataIfNeeded(hadDatabaseBefore);
}

function getUserByEmail(email) {
  return dbGet(
    `
      SELECT
        id,
        name,
        email,
        auth_salt AS authSalt,
        password_hash AS passwordHash,
        encryption_salt AS encryptionSalt,
        created_at AS createdAt
      FROM users
      WHERE email = ?
    `,
    email,
  );
}

function getUserById(userId) {
  return dbGet(
    `
      SELECT
        id,
        name,
        email,
        created_at AS createdAt
      FROM users
      WHERE id = ?
    `,
    userId,
  );
}

function getFolderRecord(userId, folderId) {
  if (!folderId) {
    return null;
  }

  return dbGet(
    `
      SELECT
        id,
        user_id AS userId,
        parent_id AS parentId,
        name,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM folders
      WHERE id = ? AND user_id = ?
    `,
    folderId,
    userId,
  );
}

function getFileRecord(userId, fileId) {
  return dbGet(
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
      WHERE id = ? AND user_id = ?
    `,
    fileId,
    userId,
  );
}

function getFileRecordById(fileId) {
  return dbGet(
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
      WHERE id = ?
    `,
    fileId,
  );
}

function listActiveFolders(userId) {
  return dbAll(
    `
      SELECT
        id,
        user_id AS userId,
        parent_id AS parentId,
        name,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM folders
      WHERE user_id = ?
      ORDER BY LOWER(name), created_at
    `,
    userId,
  );
}

function listSiblingFolderNames(userId, parentId, excludeFolderId = null) {
  return dbAll(
    `
      SELECT name
      FROM folders
      WHERE user_id = ?
        AND parent_id IS ?
        AND (? IS NULL OR id != ?)
    `,
    userId,
    parentId,
    excludeFolderId,
    excludeFolderId,
  ).map((row) => row.name);
}

function listSiblingFileNames(userId, folderId, excludeFileId = null) {
  return dbAll(
    `
      SELECT name
      FROM files
      WHERE user_id = ?
        AND deleted_at IS NULL
        AND folder_id IS ?
        AND (? IS NULL OR id != ?)
    `,
    userId,
    folderId,
    excludeFileId,
    excludeFileId,
  ).map((row) => row.name);
}

function getShareRecordById(ownerUserId, shareId) {
  return dbGet(
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
      WHERE id = ? AND owner_user_id = ?
    `,
    shareId,
    ownerUserId,
  );
}

function getShareRecordByToken(token) {
  return dbGet(
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
      WHERE token = ?
    `,
    token,
  );
}

function getActiveShareForFile(ownerUserId, fileId, now = new Date().toISOString()) {
  return dbGet(
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
        AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY created_at DESC
      LIMIT 1
    `,
    ownerUserId,
    fileId,
    now,
  );
}

function listActiveSharesForOwner(ownerUserId, now = new Date().toISOString()) {
  return dbAll(
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
        AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY created_at DESC
    `,
    ownerUserId,
    now,
  );
}

function upsertSharedInbox(userId, shareId, timestamp) {
  dbRun(
    `
      INSERT INTO shared_inbox (
        user_id,
        share_id,
        created_at,
        last_accessed_at
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, share_id)
      DO UPDATE SET last_accessed_at = excluded.last_accessed_at
    `,
    userId,
    shareId,
    timestamp,
    timestamp,
  );
}

function listSharedInbox(userId, now = new Date().toISOString()) {
  return dbAll(
    `
      SELECT
        inbox.share_id AS shareId,
        inbox.created_at AS createdAt,
        inbox.last_accessed_at AS lastAccessedAt,
        shares.token,
        shares.permission,
        shares.expires_at AS expiresAt,
        shares.created_at AS sharedAt,
        files.id AS fileId,
        files.name,
        files.mime_type AS mimeType,
        files.extension,
        files.category,
        files.size,
        files.created_at AS fileCreatedAt,
        files.updated_at AS fileUpdatedAt,
        users.name AS ownerName,
        users.email AS ownerEmail
      FROM shared_inbox inbox
      JOIN shares ON shares.id = inbox.share_id
      JOIN files ON files.id = shares.file_id
      JOIN users ON users.id = shares.owner_user_id
      WHERE inbox.user_id = ?
        AND shares.owner_user_id != ?
        AND shares.revoked_at IS NULL
        AND (shares.expires_at IS NULL OR shares.expires_at > ?)
        AND files.deleted_at IS NULL
      ORDER BY inbox.last_accessed_at DESC
      LIMIT 24
    `,
    userId,
    userId,
    now,
  );
}

function getUserStats(userId) {
  const active = dbGet(
    `
      SELECT COUNT(*) AS fileCount, COALESCE(SUM(size), 0) AS bytesUsed
      FROM files
      WHERE user_id = ? AND deleted_at IS NULL
    `,
    userId,
  );
  const trash = dbGet(
    `
      SELECT COUNT(*) AS trashCount, COALESCE(SUM(size), 0) AS trashBytes
      FROM files
      WHERE user_id = ? AND deleted_at IS NOT NULL
    `,
    userId,
  );
  const folders = dbGet(
    `
      SELECT COUNT(*) AS folderCount
      FROM folders
      WHERE user_id = ?
    `,
    userId,
  );
  const recentUploads = dbGet(
    `
      SELECT COUNT(*) AS recentUploads
      FROM files
      WHERE user_id = ?
        AND deleted_at IS NULL
        AND created_at >= ?
    `,
    userId,
    new Date(Date.now() - 1000 * 60 * 60 * 24 * 7).toISOString(),
  );

  return {
    bytesUsed: active?.bytesUsed || 0,
    fileCount: active?.fileCount || 0,
    folderCount: folders?.folderCount || 0,
    recentUploads: recentUploads?.recentUploads || 0,
    storageCapBytes: STORAGE_CAP_BYTES,
    storageCapLabel: `${STORAGE_CAP_MB} MB`,
    totalBytes: (active?.bytesUsed || 0) + (trash?.trashBytes || 0),
    trashBytes: trash?.trashBytes || 0,
    trashCount: trash?.trashCount || 0,
  };
}

function buildFolderChildCountMap(userId) {
  const counts = new Map();
  const folderRows = dbAll(
    `
      SELECT parent_id AS folderId, COUNT(*) AS itemCount
      FROM folders
      WHERE user_id = ?
      GROUP BY parent_id
    `,
    userId,
  );
  const fileRows = dbAll(
    `
      SELECT folder_id AS folderId, COUNT(*) AS itemCount
      FROM files
      WHERE user_id = ? AND deleted_at IS NULL
      GROUP BY folder_id
    `,
    userId,
  );

  for (const row of [...folderRows, ...fileRows]) {
    const key = row.folderId || "__root__";
    counts.set(key, (counts.get(key) || 0) + row.itemCount);
  }

  return counts;
}

function toPublicFolder(folder, childCountMap) {
  const item = {
    createdAt: folder.createdAt,
    id: folder.id,
    itemCount: childCountMap.get(folder.id) || 0,
    kind: "folder",
    name: folder.name,
    parentId: folder.parentId || null,
    updatedAt: folder.updatedAt,
  };

  item.typeLabel = getTypeLabel(item);
  return item;
}

function toPublicFile(file) {
  const item = {
    category: file.category,
    createdAt: file.createdAt,
    deletedAt: file.deletedAt || null,
    extension: file.extension || "",
    folderId: file.folderId || null,
    id: file.id,
    kind: "file",
    mimeType: file.mimeType,
    name: file.name,
    size: file.size,
    trashedParentId: file.trashedParentId || null,
    updatedAt: file.updatedAt,
  };

  item.typeLabel = getTypeLabel(item);
  return item;
}

function toPublicShare(share) {
  if (!share) {
    return null;
  }

  return {
    createdAt: share.createdAt,
    expiresAt: share.expiresAt || null,
    id: share.id,
    permission: share.permission,
    requiresPassword: Boolean(share.passwordHash),
    sharePath: `/s/${encodeURIComponent(share.token)}`,
  };
}

module.exports = {
  buildFolderChildCountMap,
  closeResources,
  dbAll,
  dbGet,
  dbRun,
  ensureStorageLayout,
  getDatabase,
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
};
