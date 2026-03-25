const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const tempDataDirectory = path.join(
  os.tmpdir(),
  `closetvault-smoke-${Date.now()}-${Math.random().toString(16).slice(2)}`,
);

process.env.CLOSETVAULT_DATA_DIR = tempDataDirectory;
process.env.CLOSETVAULT_MAX_UPLOAD_MB = "2";
process.env.CLOSETVAULT_STORAGE_CAP_MB = "8";

const { DATABASE_FILE } = require("../backend/config");
const { closeResources, startServer } = require("../server");

let server;

function createClient(baseUrl) {
  let cookie = "";

  async function request(pathname, options = {}) {
    const headers = new Headers(options.headers || {});

    if (cookie) {
      headers.set("Cookie", cookie);
    }

    const response = await fetch(`${baseUrl}${pathname}`, {
      ...options,
      headers,
    });
    const setCookie = response.headers.get("set-cookie");

    if (setCookie) {
      cookie = setCookie.split(";")[0];
    }

    return response;
  }

  async function json(pathname, options = {}) {
    const response = await request(pathname, options);
    return {
      payload: await response.json(),
      response,
    };
  }

  return {
    json,
    request,
  };
}

async function uploadTestFile(client, folderId, { contents, contentType, name }) {
  const pathname = folderId
    ? `/api/files/upload?folderId=${encodeURIComponent(folderId)}`
    : "/api/files/upload";
  const response = await client.request(pathname, {
    body: contents,
    headers: {
      "Content-Type": contentType,
      "X-ClosetVault-Name": encodeURIComponent(name),
      "X-ClosetVault-Size": String(contents.length),
    },
    method: "POST",
  });
  const payload = await response.json();

  assert.equal(response.status, 201);
  return payload.file;
}

async function main() {
  server = await startServer({ host: "127.0.0.1", port: 0 });
  const address = server.address();
  const baseUrl = `http://${address.address}:${address.port}`;
  const owner = createClient(baseUrl);
  const viewer = createClient(baseUrl);
  const guest = createClient(baseUrl);

  const registerOwner = await owner.json("/api/auth/register", {
    body: JSON.stringify({
      email: "owner@example.com",
      name: "Vault Owner",
      password: "owner-pass-123",
    }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });

  assert.equal(registerOwner.response.status, 201);
  assert.equal(registerOwner.payload.user.email, "owner@example.com");

  const registerViewer = await viewer.json("/api/auth/register", {
    body: JSON.stringify({
      email: "viewer@example.com",
      name: "Vault Viewer",
      password: "viewer-pass-123",
    }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });

  assert.equal(registerViewer.response.status, 201);
  assert.equal(registerViewer.payload.user.email, "viewer@example.com");

  const ownerSupport = await owner.json("/api/support", {
    body: JSON.stringify({
      email: "owner@example.com",
      message: "Need help reviewing my shared files.",
    }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });

  assert.equal(ownerSupport.response.status, 201);
  assert.match(ownerSupport.payload.message, /support request sent/i);

  const guestSupport = await guest.json("/api/support", {
    body: JSON.stringify({
      email: "guest@example.com",
      message: "I need help opening a shared ClosetVault link.",
    }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });

  assert.equal(guestSupport.response.status, 201);

  const supportDatabase = new DatabaseSync(DATABASE_FILE);
  const supportRows = supportDatabase
    .prepare(
      `
        SELECT
          email,
          message,
          user_id AS userId
        FROM support_requests
        ORDER BY created_at ASC
      `,
    )
    .all();
  supportDatabase.close();

  assert.equal(supportRows.length, 2);
  assert.equal(supportRows[0].email, "owner@example.com");
  assert.equal(supportRows[0].message, "Need help reviewing my shared files.");
  assert.equal(supportRows[0].userId, registerOwner.payload.user.id);
  assert.equal(supportRows[1].email, "guest@example.com");
  assert.equal(supportRows[1].message, "I need help opening a shared ClosetVault link.");
  assert.equal(supportRows[1].userId, null);

  const createFolder = await owner.json("/api/folders", {
    body: JSON.stringify({
      name: "Physics",
      parentId: null,
    }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });

  assert.equal(createFolder.response.status, 201);
  const folderId = createFolder.payload.folder.id;

  const fileContents = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9VE3Gx8AAAAASUVORK5CYII=",
    "base64",
  );
  const pdfContents = Buffer.from("%PDF-1.4\n%ClosetVault\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF");
  const videoContents = Buffer.from("ClosetVault smart search video test");
  const sharedFile = await uploadTestFile(owner, folderId, {
    contents: fileContents,
    contentType: "image/png",
    name: "thumbnail.png",
  });
  const photoSearchFile = await uploadTestFile(owner, null, {
    contents: fileContents,
    contentType: "image/png",
    name: "orbit-photo.png",
  });
  const pdfSearchFile = await uploadTestFile(owner, null, {
    contents: pdfContents,
    contentType: "application/pdf",
    name: "physics-reference.pdf",
  });
  const videoSearchFile = await uploadTestFile(owner, null, {
    contents: videoContents,
    contentType: "video/mp4",
    name: "lab-video.mp4",
  });
  const fileId = sharedFile.id;

  const searchMutationDatabase = new DatabaseSync(DATABASE_FILE);
  const updateTimestamps = searchMutationDatabase.prepare(
    `
      UPDATE files
      SET created_at = ?, updated_at = ?
      WHERE id = ?
    `,
  );
  const yesterday = new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString();
  const sixDaysAgo = new Date(Date.now() - 1000 * 60 * 60 * 24 * 6).toISOString();

  updateTimestamps.run(yesterday, yesterday, photoSearchFile.id);
  updateTimestamps.run(sixDaysAgo, sixDaysAgo, videoSearchFile.id);
  searchMutationDatabase.close();

  const photosSearch = await owner.json(
    `/api/explorer?search=${encodeURIComponent("Show me the photos I uploaded yesterday")}`,
  );

  assert.equal(photosSearch.response.status, 200);
  assert.equal(photosSearch.payload.searchInfo.mode, "smart");
  assert.equal(photosSearch.payload.searchInfo.scope, "vault");
  assert.equal(photosSearch.payload.items.length, 1);
  assert.equal(photosSearch.payload.items[0].name, "orbit-photo.png");

  const pdfSearch = await owner.json(
    `/api/explorer?search=${encodeURIComponent("Find the PDF about physics")}`,
  );

  assert.equal(pdfSearch.response.status, 200);
  assert.equal(pdfSearch.payload.searchInfo.mode, "smart");
  assert.equal(pdfSearch.payload.items.length, 1);
  assert.equal(pdfSearch.payload.items[0].name, "physics-reference.pdf");

  const videoSearch = await owner.json(
    `/api/explorer?search=${encodeURIComponent("Videos from last week")}`,
  );

  assert.equal(videoSearch.response.status, 200);
  assert.equal(videoSearch.payload.searchInfo.mode, "smart");
  assert.equal(videoSearch.payload.items.length, 1);
  assert.equal(videoSearch.payload.items[0].name, "lab-video.mp4");

  const previewResponse = await owner.request(`/api/files/${fileId}/preview`);
  const previewBuffer = Buffer.from(await previewResponse.arrayBuffer());

  assert.equal(previewResponse.status, 200);
  assert.equal(previewResponse.headers.get("content-type"), "image/png");
  assert.deepEqual(previewBuffer, fileContents);

  const firstShare = await owner.json(`/api/files/${fileId}/shares`, {
    body: JSON.stringify({
      password: null,
      permission: "view",
    }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });

  assert.equal(firstShare.response.status, 201);
  assert.equal(firstShare.payload.share.permission, "view");
  const firstSharePath = firstShare.payload.share.sharePath;
  const firstShareToken = firstSharePath.split("/").pop();

  const expiresAt = new Date(Date.now() + 1000 * 60 * 60).toISOString();
  const secondShare = await owner.json(`/api/files/${fileId}/shares`, {
    body: JSON.stringify({
      expiresAt,
      password: "lock1234",
      permission: "edit",
    }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });

  assert.equal(secondShare.response.status, 201);
  assert.equal(secondShare.payload.share.permission, "edit");
  assert.equal(Boolean(secondShare.payload.share.requiresPassword), true);
  assert.notEqual(secondShare.payload.share.sharePath, firstSharePath);
  const shareId = secondShare.payload.share.id;
  const shareToken = secondShare.payload.share.sharePath.split("/").pop();

  const replacedShareStatus = await viewer.request(`/api/share-links/${firstShareToken}`);
  assert.equal(replacedShareStatus.status, 404);

  const shareStatus = await viewer.json(`/api/share-links/${shareToken}`);
  assert.equal(shareStatus.response.status, 200);
  assert.equal(shareStatus.payload.share.permission, "edit");
  assert.equal(shareStatus.payload.share.requiresPassword, true);
  assert.equal(shareStatus.payload.file, null);

  const wrongPasswordResponse = await viewer.request(
    `/api/share-links/${shareToken}/access`,
    {
      body: JSON.stringify({ password: "bad-pass" }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    },
  );
  const wrongPasswordPayload = await wrongPasswordResponse.json();

  assert.equal(wrongPasswordResponse.status, 401);
  assert.match(wrongPasswordPayload.error, /password/i);

  const unlockShare = await viewer.json(`/api/share-links/${shareToken}/access`, {
    body: JSON.stringify({ password: "lock1234" }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });

  assert.equal(unlockShare.response.status, 200);
  assert.equal(unlockShare.payload.file.name, "thumbnail.png");
  assert.equal(unlockShare.payload.share.permission, "edit");
  assert.ok(unlockShare.payload.grant);
  const shareGrant = unlockShare.payload.grant;

  const sharedContentResponse = await viewer.request(
    `/api/share-links/${shareToken}/content?grant=${encodeURIComponent(shareGrant)}`,
  );
  const sharedContentBuffer = Buffer.from(await sharedContentResponse.arrayBuffer());

  assert.equal(sharedContentResponse.status, 200);
  assert.equal(sharedContentResponse.headers.get("content-type"), "image/png");
  assert.deepEqual(sharedContentBuffer, fileContents);

  const renameSharedFile = await viewer.json(
    `/api/share-links/${shareToken}/file?grant=${encodeURIComponent(shareGrant)}`,
    {
      body: JSON.stringify({ name: "thumbnail-shared.png" }),
      headers: { "Content-Type": "application/json" },
      method: "PATCH",
    },
  );

  assert.equal(renameSharedFile.response.status, 200);
  assert.equal(renameSharedFile.payload.file.name, "thumbnail-shared.png");

  const ownerExplorer = await owner.json(
    `/api/explorer?folderId=${encodeURIComponent(folderId)}&sortBy=name&sortDirection=asc`,
  );

  assert.equal(ownerExplorer.response.status, 200);
  assert.equal(ownerExplorer.payload.items.length, 1);
  assert.equal(ownerExplorer.payload.items[0].name, "thumbnail-shared.png");
  assert.equal(ownerExplorer.payload.items[0].share.permission, "edit");

  const viewerExplorer = await viewer.json("/api/explorer");

  assert.equal(viewerExplorer.response.status, 200);
  assert.equal(viewerExplorer.payload.sharedWithMe.length, 1);
  assert.equal(viewerExplorer.payload.sharedWithMe[0].file.name, "thumbnail-shared.png");

  const revokeShare = await owner.json(`/api/shares/${shareId}`, {
    method: "DELETE",
  });

  assert.equal(revokeShare.response.status, 200);

  const revokedStatus = await viewer.request(`/api/share-links/${shareToken}`);
  assert.equal(revokedStatus.status, 404);

  const moveFile = await owner.json(`/api/files/${fileId}`, {
    body: JSON.stringify({ folderId: null }),
    headers: { "Content-Type": "application/json" },
    method: "PATCH",
  });

  assert.equal(moveFile.response.status, 200);

  const moveToTrash = await owner.json(`/api/files/${fileId}`, {
    method: "DELETE",
  });

  assert.equal(moveToTrash.response.status, 200);

  const trashView = await owner.json("/api/explorer?trash=1");

  assert.equal(trashView.response.status, 200);
  assert.equal(trashView.payload.items.length, 1);
  assert.equal(trashView.payload.items[0].name, "thumbnail-shared.png");

  const restoreFile = await owner.json(`/api/files/${fileId}/restore`, {
    method: "POST",
  });

  assert.equal(restoreFile.response.status, 200);

  const downloadResponse = await owner.request(`/api/files/${fileId}/download`);
  const downloadedBuffer = Buffer.from(await downloadResponse.arrayBuffer());

  assert.equal(downloadResponse.status, 200);
  assert.deepEqual(downloadedBuffer, fileContents);

  const deleteFolder = await owner.json(`/api/folders/${folderId}`, {
    method: "DELETE",
  });

  assert.equal(deleteFolder.response.status, 200);

  const ownerLogout = await owner.json("/api/auth/logout", {
    method: "POST",
  });
  const viewerLogout = await viewer.json("/api/auth/logout", {
    method: "POST",
  });

  assert.equal(ownerLogout.response.status, 200);
  assert.equal(viewerLogout.response.status, 200);
}

main()
  .then(() => {
    console.log("ClosetVault explorer and sharing smoke test passed.");
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (server) {
      await new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    }

    closeResources();

    await fs.rm(tempDataDirectory, { recursive: true, force: true });
  });
