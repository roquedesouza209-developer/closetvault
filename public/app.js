const state = {
  files: [],
  stats: {
    fileCount: 0,
    bytesUsed: 0,
    recentUploads: 0,
    uploadLimitBytes: 10 * 1024 * 1024,
  },
  user: null,
};

const elements = {
  authView: document.getElementById("auth-view"),
  createVaultCta: document.getElementById("create-vault-cta"),
  dashboardSubtitle: document.getElementById("dashboard-subtitle"),
  dashboardTitle: document.getElementById("dashboard-title"),
  dashboardView: document.getElementById("dashboard-view"),
  dropzone: document.getElementById("dropzone"),
  fileEmpty: document.getElementById("file-empty"),
  fileInput: document.getElementById("file-input"),
  fileList: document.getElementById("file-list"),
  filesCount: document.getElementById("files-count"),
  jumpToVault: document.getElementById("jump-to-vault"),
  limitHint: document.getElementById("limit-hint"),
  loginForm: document.getElementById("login-form"),
  logoutButton: document.getElementById("logout-button"),
  messageBanner: document.getElementById("message-banner"),
  recentUploads: document.getElementById("recent-uploads"),
  refreshButton: document.getElementById("refresh-button"),
  registerForm: document.getElementById("register-form"),
  storageUsed: document.getElementById("storage-used"),
  tabButtons: Array.from(document.querySelectorAll(".tab-button")),
  uploadStatus: document.getElementById("upload-status"),
  vaultPanel: document.getElementById("vault-panel"),
};

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => {
    const entities = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };

    return entities[character] || character;
  });
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  return `${value.toFixed(value >= 10 || exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

function formatDate(isoString) {
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(isoString));
  } catch {
    return "Unknown date";
  }
}

function scrollToVault() {
  elements.vaultPanel.scrollIntoView({ behavior: "smooth", block: "start" });
}

function setMessage(message, tone = "info") {
  if (!message) {
    elements.messageBanner.textContent = "";
    elements.messageBanner.dataset.tone = "";
    elements.messageBanner.classList.add("hidden");
    return;
  }

  elements.messageBanner.textContent = message;
  elements.messageBanner.dataset.tone = tone;
  elements.messageBanner.classList.remove("hidden");
}

function setAuthTab(tab) {
  const showingRegister = tab === "register";
  elements.registerForm.classList.toggle("hidden", !showingRegister);
  elements.loginForm.classList.toggle("hidden", showingRegister);

  elements.tabButtons.forEach((button) => {
    button.classList.toggle("is-active", button.dataset.tab === tab);
  });
}

function setDashboardVisibility(isAuthenticated) {
  elements.authView.classList.toggle("hidden", isAuthenticated);
  elements.dashboardView.classList.toggle("hidden", !isAuthenticated);
}

function renderStats() {
  elements.filesCount.textContent = String(state.stats.fileCount || 0);
  elements.storageUsed.textContent = formatBytes(state.stats.bytesUsed || 0);
  elements.recentUploads.textContent = String(state.stats.recentUploads || 0);
  elements.limitHint.textContent = `MVP limit: ${formatBytes(
    state.stats.uploadLimitBytes || 0,
  )} per file.`;
}

function renderFiles() {
  if (!state.files.length) {
    elements.fileEmpty.classList.remove("hidden");
    elements.fileList.innerHTML = "";
    return;
  }

  elements.fileEmpty.classList.add("hidden");
  elements.fileList.innerHTML = state.files
    .map(
      (file) => `
        <article class="file-row">
          <div class="file-meta">
            <strong title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</strong>
            <span>${formatBytes(file.size)} · ${escapeHtml(
              file.mimeType || "application/octet-stream",
            )} · Added ${escapeHtml(formatDate(file.createdAt))}</span>
          </div>
          <div class="file-actions">
            <button class="file-action" type="button" data-action="download" data-id="${escapeHtml(
              file.id,
            )}">
              Download
            </button>
            <button
              class="file-action"
              type="button"
              data-action="share"
              data-id="${escapeHtml(file.id)}"
              data-variant="muted"
            >
              Share Soon
            </button>
            <button
              class="file-action"
              type="button"
              data-action="delete"
              data-id="${escapeHtml(file.id)}"
              data-variant="danger"
            >
              Delete
            </button>
          </div>
        </article>
      `,
    )
    .join("");
}

function renderDashboard() {
  renderStats();
  renderFiles();

  if (!state.user) {
    return;
  }

  elements.dashboardTitle.textContent = `${state.user.name}'s ClosetVault`;
  elements.dashboardSubtitle.textContent = `Signed in as ${state.user.email}. Your secure file workspace is ready.`;
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});

  if (options.body && !(options.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(path, {
    ...options,
    headers,
    credentials: "same-origin",
  });
  const isJson = response.headers.get("content-type")?.includes("application/json");
  const data = isJson ? await response.json() : null;

  if (!response.ok) {
    throw new Error(data?.error || "Request failed.");
  }

  return data;
}

async function refreshFiles() {
  const data = await api("/api/files");
  state.files = data.files || [];
  state.stats = data.stats || state.stats;
  renderDashboard();
}

async function restoreSession() {
  try {
    const data = await api("/api/auth/session");

    if (!data.authenticated) {
      state.user = null;
      state.files = [];
      renderDashboard();
      setDashboardVisibility(false);
      return;
    }

    state.user = data.user;
    state.stats = data.stats || state.stats;
    setDashboardVisibility(true);
    await refreshFiles();
  } catch (error) {
    setMessage(error.message, "error");
  }
}

function setFormBusy(form, isBusy, label) {
  const submitButton = form.querySelector('button[type="submit"]');

  if (!submitButton) {
    return;
  }

  if (!submitButton.dataset.label) {
    submitButton.dataset.label = submitButton.textContent;
  }

  submitButton.disabled = isBusy;
  submitButton.textContent = isBusy ? label : submitButton.dataset.label;
}

async function submitRegister(event) {
  event.preventDefault();
  const formData = new FormData(elements.registerForm);

  setFormBusy(elements.registerForm, true, "Creating...");
  setMessage("");

  try {
    const data = await api("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({
        name: formData.get("name"),
        email: formData.get("email"),
        password: formData.get("password"),
      }),
    });

    state.user = data.user;
    state.files = [];
    setDashboardVisibility(true);
    await refreshFiles();
    elements.registerForm.reset();
    setMessage(data.message, "success");
  } catch (error) {
    setMessage(error.message, "error");
  } finally {
    setFormBusy(elements.registerForm, false, "Creating...");
  }
}

async function submitLogin(event) {
  event.preventDefault();
  const formData = new FormData(elements.loginForm);

  setFormBusy(elements.loginForm, true, "Unlocking...");
  setMessage("");

  try {
    const data = await api("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({
        email: formData.get("email"),
        password: formData.get("password"),
      }),
    });

    state.user = data.user;
    setDashboardVisibility(true);
    await refreshFiles();
    elements.loginForm.reset();
    setMessage(data.message, "success");
  } catch (error) {
    setMessage(error.message, "error");
  } finally {
    setFormBusy(elements.loginForm, false, "Unlocking...");
  }
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => {
      const result = String(reader.result || "");
      const separatorIndex = result.indexOf(",");
      resolve(separatorIndex >= 0 ? result.slice(separatorIndex + 1) : result);
    };

    reader.onerror = () => {
      reject(new Error(`Could not read ${file.name}.`));
    };

    reader.readAsDataURL(file);
  });
}

async function uploadFiles(fileList) {
  const files = Array.from(fileList || []);

  if (!files.length) {
    return;
  }

  if (!state.user) {
    setMessage("Create or unlock your vault before uploading.", "error");
    setDashboardVisibility(false);
    return;
  }

  try {
    for (const file of files) {
      elements.uploadStatus.textContent = `Uploading ${file.name}...`;

      const base64Data = await readFileAsBase64(file);
      await api("/api/files/upload", {
        method: "POST",
        body: JSON.stringify({
          name: file.name,
          type: file.type || "application/octet-stream",
          size: file.size,
          data: base64Data,
        }),
      });
    }

    await refreshFiles();
    elements.fileInput.value = "";
    elements.uploadStatus.textContent = "Upload complete.";
    setMessage(`${files.length} file${files.length === 1 ? "" : "s"} stored in your vault.`, "success");
  } catch (error) {
    elements.uploadStatus.textContent = "Upload failed.";
    setMessage(error.message, "error");
  }
}

async function handleLogout() {
  try {
    await api("/api/auth/logout", { method: "POST" });
    state.user = null;
    state.files = [];
    state.stats = {
      fileCount: 0,
      bytesUsed: 0,
      recentUploads: 0,
      uploadLimitBytes: state.stats.uploadLimitBytes,
    };
    renderDashboard();
    setDashboardVisibility(false);
    setMessage("Vault locked.", "info");
    scrollToVault();
  } catch (error) {
    setMessage(error.message, "error");
  }
}

async function handleFileAction(event) {
  const trigger = event.target.closest("[data-action]");

  if (!trigger) {
    return;
  }

  const { action, id } = trigger.dataset;

  if (!id) {
    return;
  }

  if (action === "download") {
    window.location.assign(`/api/files/${encodeURIComponent(id)}/download`);
    return;
  }

  if (action === "share") {
    setMessage("Secure sharing is queued as the next ClosetVault milestone.", "info");
    return;
  }

  if (action === "delete") {
    const shouldDelete = window.confirm("Delete this file from ClosetVault?");

    if (!shouldDelete) {
      return;
    }

    try {
      const data = await api(`/api/files/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });

      await refreshFiles();
      setMessage(data.message, "success");
    } catch (error) {
      setMessage(error.message, "error");
    }
  }
}

function bindDropzone() {
  ["dragenter", "dragover"].forEach((eventName) => {
    elements.dropzone.addEventListener(eventName, (event) => {
      event.preventDefault();
      elements.dropzone.classList.add("is-active");
    });
  });

  ["dragleave", "dragend", "drop"].forEach((eventName) => {
    elements.dropzone.addEventListener(eventName, (event) => {
      event.preventDefault();
      elements.dropzone.classList.remove("is-active");
    });
  });

  elements.dropzone.addEventListener("drop", (event) => {
    const files = event.dataTransfer?.files;
    uploadFiles(files);
  });
}

function bindEvents() {
  elements.createVaultCta.addEventListener("click", () => {
    setAuthTab("register");
    scrollToVault();
  });

  elements.jumpToVault.addEventListener("click", scrollToVault);

  elements.tabButtons.forEach((button) => {
    button.addEventListener("click", () => {
      setAuthTab(button.dataset.tab || "register");
    });
  });

  elements.registerForm.addEventListener("submit", submitRegister);
  elements.loginForm.addEventListener("submit", submitLogin);
  elements.logoutButton.addEventListener("click", handleLogout);
  elements.refreshButton.addEventListener("click", async () => {
    try {
      await refreshFiles();
      setMessage("Vault refreshed.", "info");
    } catch (error) {
      setMessage(error.message, "error");
    }
  });
  elements.fileInput.addEventListener("change", (event) => {
    uploadFiles(event.target.files);
  });
  elements.fileList.addEventListener("click", handleFileAction);
  bindDropzone();
}

bindEvents();
setAuthTab("register");
renderDashboard();
restoreSession();
