const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const tempDataDirectory = path.join(
  os.tmpdir(),
  `closetvault-smoke-${Date.now()}-${Math.random().toString(16).slice(2)}`,
);

process.env.CLOSETVAULT_DATA_DIR = tempDataDirectory;
process.env.CLOSETVAULT_MAX_UPLOAD_MB = "2";

const { startServer } = require("../server");

let server;

async function main() {
  server = await startServer({ host: "127.0.0.1", port: 0 });
  const address = server.address();
  const baseUrl = `http://${address.address}:${address.port}`;
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

  const registerResponse = await request("/api/auth/register", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: "Vault Tester",
      email: "tester@example.com",
      password: "strong-pass-123",
    }),
  });
  const registerPayload = await registerResponse.json();

  assert.equal(registerResponse.status, 201);
  assert.equal(registerPayload.user.email, "tester@example.com");
  assert.ok(cookie.includes("closetvault_session="));

  const fileContents = Buffer.from("ClosetVault smoke test payload", "utf8");
  const uploadResponse = await request("/api/files/upload", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: "smoke.txt",
      type: "text/plain",
      size: fileContents.length,
      data: fileContents.toString("base64"),
    }),
  });
  const uploadPayload = await uploadResponse.json();

  assert.equal(uploadResponse.status, 201);
  assert.equal(uploadPayload.file.name, "smoke.txt");

  const listResponse = await request("/api/files");
  const listPayload = await listResponse.json();

  assert.equal(listResponse.status, 200);
  assert.equal(listPayload.files.length, 1);

  const downloadResponse = await request(
    `/api/files/${listPayload.files[0].id}/download`,
  );
  const downloadedBuffer = Buffer.from(await downloadResponse.arrayBuffer());

  assert.equal(downloadResponse.status, 200);
  assert.deepEqual(downloadedBuffer, fileContents);

  const deleteResponse = await request(`/api/files/${listPayload.files[0].id}`, {
    method: "DELETE",
  });
  const deletePayload = await deleteResponse.json();

  assert.equal(deleteResponse.status, 200);
  assert.match(deletePayload.message, /removed from your vault/i);

  const logoutResponse = await request("/api/auth/logout", {
    method: "POST",
  });
  const logoutPayload = await logoutResponse.json();

  assert.equal(logoutResponse.status, 200);
  assert.match(logoutPayload.message, /vault locked/i);
}

main()
  .then(async () => {
    console.log("ClosetVault smoke test passed.");
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

    await fs.rm(tempDataDirectory, { recursive: true, force: true });
  });
