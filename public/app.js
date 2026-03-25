const initialUploadLimit = 50 * 1024 * 1024;

const state = {
  currentFolder: {
    breadcrumb: [{ id: null, name: "Vault" }],
    id: null,
    name: "Vault",
    parentId: null,
  },
  folderTree: [],
  items: [],
  previewItem: null,
  search: "",
  sharedWithMe: [],
  showTrash: false,
  sortBy: localStorage.getItem("closetvault.sortBy") || "date",
  sortDirection: localStorage.getItem("closetvault.sortDirection") || "desc",
  stats: {
    bytesUsed: 0,
    fileCount: 0,
    folderCount: 0,
    storageCapBytes: 0,
    totalBytes: 0,
    trashBytes: 0,
    trashCount: 0,
    uploadLimitBytes: initialUploadLimit,
  },
  storage: {
    detail: "",
    label: "Pending storage backend",
  },
  uploads: [],
  user: null,
  viewMode: localStorage.getItem("closetvault.viewMode") || "list",
};

const dialogState = {
  resolver: null,
};

const shareDialogState = {
  fileId: null,
  fileName: "",
  share: null,
};

let searchTimer = null;

const elements = {
  authView: document.getElementById("auth-view"),
  breadcrumb: document.getElementById("breadcrumb"),
  createVaultCta: document.getElementById("create-vault-cta"),
  dashboardSubtitle: document.getElementById("dashboard-subtitle"),
  dashboardTitle: document.getElementById("dashboard-title"),
  dashboardView: document.getElementById("dashboard-view"),
  dialogBackdrop: document.getElementById("dialog-backdrop"),
  dialogCancel: document.getElementById("dialog-cancel"),
  dialogDescription: document.getElementById("dialog-description"),
  dialogForm: document.getElementById("dialog-form"),
  dialogInput: document.getElementById("dialog-input"),
  dialogInputLabel: document.getElementById("dialog-input-label"),
  dialogInputWrap: document.getElementById("dialog-input-wrap"),
  dialogSelect: document.getElementById("dialog-select"),
  dialogSelectLabel: document.getElementById("dialog-select-label"),
  dialogSelectWrap: document.getElementById("dialog-select-wrap"),
  dialogSubmit: document.getElementById("dialog-submit"),
  dialogTitle: document.getElementById("dialog-title"),
  dropzone: document.getElementById("dropzone"),
  explorerEmpty: document.getElementById("explorer-empty"),
  explorerItems: document.getElementById("explorer-items"),
  filesCount: document.getElementById("files-count"),
  fileInput: document.getElementById("file-input"),
  folderTree: document.getElementById("folder-tree"),
  foldersCount: document.getElementById("folders-count"),
  itemsHeader: document.getElementById("items-header"),
  jumpToVault: document.getElementById("jump-to-vault"),
  limitHint: document.getElementById("limit-hint"),
  loginForm: document.getElementById("login-form"),
  logoutButton: document.getElementById("logout-button"),
  messageBanner: document.getElementById("message-banner"),
  newFolderButton: document.getElementById("new-folder-button"),
  previewAudio: document.getElementById("preview-audio"),
  previewBackdrop: document.getElementById("preview-backdrop"),
  previewClose: document.getElementById("preview-close"),
  previewDate: document.getElementById("preview-date"),
  previewEmpty: document.getElementById("preview-empty"),
  previewImage: document.getElementById("preview-image"),
  previewName: document.getElementById("preview-name"),
  previewPdf: document.getElementById("preview-pdf"),
  previewSize: document.getElementById("preview-size"),
  previewSubtitle: document.getElementById("preview-subtitle"),
  previewTitle: document.getElementById("preview-title"),
  previewType: document.getElementById("preview-type"),
  previewVideo: document.getElementById("preview-video"),
  quickRoot: document.getElementById("quick-root"),
  quickTrash: document.getElementById("quick-trash"),
  refreshButton: document.getElementById("refresh-button"),
  registerForm: document.getElementById("register-form"),
  searchInput: document.getElementById("search-input"),
  shareBackdrop: document.getElementById("share-backdrop"),
  shareClose: document.getElementById("share-close"),
  shareCopy: document.getElementById("share-copy"),
  shareExpiration: document.getElementById("share-expiration"),
  shareForm: document.getElementById("share-form"),
  shareLink: document.getElementById("share-link"),
  sharePassword: document.getElementById("share-password"),
  sharePermission: document.getElementById("share-permission"),
  shareRevoke: document.getElementById("share-revoke"),
  shareStatus: document.getElementById("share-status"),
  shareSubtitle: document.getElementById("share-subtitle"),
  shareTitle: document.getElementById("share-title"),
  shareSubmit: document.getElementById("share-submit"),
  sharedWithMeCount: document.getElementById("shared-with-me-count"),
  sharedWithMeList: document.getElementById("shared-with-me-list"),
  sortDirection: document.getElementById("sort-direction"),
  sortField: document.getElementById("sort-field"),
  storageDriver: document.getElementById("storage-driver"),
  storageTotal: document.getElementById("storage-total"),
  tabButtons: Array.from(document.querySelectorAll(".tab-button")),
  trashBanner: document.getElementById("trash-banner"),
  trashCount: document.getElementById("trash-count"),
  uploadButton: document.getElementById("upload-button"),
  uploadQueue: document.getElementById("upload-queue"),
  usageCaption: document.getElementById("usage-caption"),
  usageFill: document.getElementById("usage-fill"),
  vaultPanel: document.getElementById("vault-panel"),
  viewButtons: Array.from(document.querySelectorAll("[data-view]")),
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

function toLocalDateTimeValue(isoString) {
  if (!isoString) {
    return "";
  }

  const value = new Date(isoString);

  if (Number.isNaN(value.getTime())) {
    return "";
  }

  const offset = value.getTimezoneOffset() * 60 * 1000;
  return new Date(value.getTime() - offset).toISOString().slice(0, 16);
}

function toIsoDateTime(value) {
  if (!value) {
    return null;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function shareAbsoluteUrl(share) {
  if (!share?.sharePath) {
    return "";
  }

  return new URL(share.sharePath, window.location.origin).toString();
}

async function copyText(text) {
  if (!text) {
    throw new Error("No share link is available yet.");
  }

  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const temporaryInput = document.createElement("input");
  temporaryInput.value = text;
  temporaryInput.setAttribute("readonly", "readonly");
  temporaryInput.style.position = "absolute";
  temporaryInput.style.left = "-9999px";
  document.body.appendChild(temporaryInput);
  temporaryInput.select();
  document.execCommand("copy");
  temporaryInput.remove();
}

function getPreviewKind(item) {
  if (!item || item.kind !== "file") {
    return null;
  }

  const mimeType = String(item.mimeType || "").toLowerCase();
  const extension = String(item.extension || "").toLowerCase();

  if (
    mimeType === "image/jpeg" ||
    mimeType === "image/png" ||
    mimeType === "image/webp" ||
    extension === "jpg" ||
    extension === "jpeg" ||
    extension === "png" ||
    extension === "webp"
  ) {
    return "image";
  }

  if (mimeType === "video/mp4" || extension === "mp4") {
    return "video";
  }

  if (mimeType === "audio/mpeg" || extension === "mp3") {
    return "audio";
  }

  if (mimeType === "application/pdf" || extension === "pdf") {
    return "pdf";
  }

  return null;
}

function previewUrl(item) {
  return `/api/files/${encodeURIComponent(item.id)}/preview`;
}

function resetPreviewMedia() {
  elements.previewImage.classList.add("hidden");
  elements.previewVideo.classList.add("hidden");
  elements.previewAudio.classList.add("hidden");
  elements.previewPdf.classList.add("hidden");
  elements.previewEmpty.classList.add("hidden");
  elements.previewImage.removeAttribute("src");
  elements.previewVideo.pause();
  elements.previewVideo.removeAttribute("src");
  elements.previewVideo.load();
  elements.previewAudio.pause();
  elements.previewAudio.removeAttribute("src");
  elements.previewAudio.load();
  elements.previewPdf.removeAttribute("src");
}

function closePreview() {
  state.previewItem = null;
  resetPreviewMedia();
  elements.previewBackdrop.classList.add("hidden");
}

function openPreview(item) {
  const kind = getPreviewKind(item);

  if (!kind) {
    setMessage("ClosetVault cannot preview this file type yet.", "info");
    return;
  }

  state.previewItem = item;
  resetPreviewMedia();
  elements.previewTitle.textContent = item.name;
  elements.previewSubtitle.textContent = `${item.typeLabel || item.mimeType} preview`;
  elements.previewName.textContent = item.name;
  elements.previewType.textContent = item.mimeType || item.typeLabel || "Unknown";
  elements.previewSize.textContent = formatBytes(item.size || 0);
  elements.previewDate.textContent = formatDate(item.createdAt);
  elements.previewBackdrop.classList.remove("hidden");

  if (kind === "image") {
    elements.previewImage.src = previewUrl(item);
    elements.previewImage.alt = item.name;
    elements.previewImage.classList.remove("hidden");
    return;
  }

  if (kind === "video") {
    elements.previewVideo.src = previewUrl(item);
    elements.previewVideo.classList.remove("hidden");
    return;
  }

  if (kind === "audio") {
    elements.previewAudio.src = previewUrl(item);
    elements.previewAudio.classList.remove("hidden");
    return;
  }

  if (kind === "pdf") {
    elements.previewPdf.src = previewUrl(item);
    elements.previewPdf.classList.remove("hidden");
    return;
  }

  elements.previewEmpty.classList.remove("hidden");
}

function renderShareModal() {
  const share = shareDialogState.share;
  elements.shareTitle.textContent = shareDialogState.fileName
    ? `Share ${shareDialogState.fileName}`
    : "Share file";
  elements.shareSubtitle.textContent = share
    ? `${share.permission === "edit" ? "Edit" : "View"} link is active${
        share.requiresPassword ? ", with password protection." : "."
      }`
    : "Generate a secure file link with access controls.";
  elements.shareLink.value = share ? shareAbsoluteUrl(share) : "";
  elements.shareStatus.textContent = share
    ? `Permission: ${share.permission}. ${
        share.requiresPassword ? "Password required. " : "No password required. "
      }${
        share.expiresAt ? `Expires ${formatDate(share.expiresAt)}.` : "No expiration set."
      }`
    : "No active share link for this file yet.";
  elements.shareCopy.disabled = !share;
  elements.shareRevoke.disabled = !share;
  elements.shareSubmit.textContent = share ? "Replace link" : "Generate link";
}

function closeShareModal() {
  shareDialogState.fileId = null;
  shareDialogState.fileName = "";
  shareDialogState.share = null;
  elements.sharePassword.value = "";
  elements.shareBackdrop.classList.add("hidden");
}

function openShareModal(item) {
  shareDialogState.fileId = item.id;
  shareDialogState.fileName = item.name;
  shareDialogState.share = item.share ? { ...item.share } : null;
  elements.sharePermission.value = item.share?.permission || "view";
  elements.shareExpiration.value = toLocalDateTimeValue(item.share?.expiresAt);
  elements.sharePassword.value = "";
  renderShareModal();
  elements.shareBackdrop.classList.remove("hidden");
}

function syncShareModalWithExplorer() {
  if (!shareDialogState.fileId) {
    return;
  }

  const currentItem = state.items.find((entry) => entry.id === shareDialogState.fileId);

  if (!currentItem) {
    return;
  }

  shareDialogState.fileName = currentItem.name;
  shareDialogState.share = currentItem.share ? { ...currentItem.share } : null;
  renderShareModal();
}

function setShareBusy(isBusy) {
  elements.shareSubmit.disabled = isBusy;
  elements.sharePermission.disabled = isBusy;
  elements.shareExpiration.disabled = isBusy;
  elements.sharePassword.disabled = isBusy;
  elements.shareClose.disabled = isBusy;
  elements.shareCopy.disabled = isBusy || !shareDialogState.share;
  elements.shareRevoke.disabled = isBusy || !shareDialogState.share;
  elements.shareSubmit.textContent = isBusy
    ? shareDialogState.share
      ? "Replacing..."
      : "Generating..."
    : shareDialogState.share
      ? "Replace link"
      : "Generate link";
}

async function copyShareLink(share) {
  await copyText(shareAbsoluteUrl(share));
  setMessage("Share link copied.", "success");
}

async function revokeShareLink(share, options = {}) {
  if (!share) {
    throw new Error("No active share link is available.");
  }

  if (options.confirm !== false && !window.confirm("Revoke this share link?")) {
    return false;
  }

  const data = await api(`/api/shares/${encodeURIComponent(share.id)}`, {
    method: "DELETE",
  });

  await refreshExplorer();
  if (shareDialogState.fileId && shareDialogState.share?.id === share.id) {
    shareDialogState.share = null;
    renderShareModal();
  }
  setMessage(data.message, "success");
  return true;
}

async function submitShare(event) {
  event.preventDefault();

  if (!shareDialogState.fileId) {
    return;
  }

  setShareBusy(true);

  try {
    const data = await api(`/api/files/${encodeURIComponent(shareDialogState.fileId)}/shares`, {
      body: JSON.stringify({
        expiresAt: toIsoDateTime(elements.shareExpiration.value),
        password: elements.sharePassword.value.trim() || null,
        permission: elements.sharePermission.value,
      }),
      method: "POST",
    });

    elements.sharePassword.value = "";
    shareDialogState.share = data.share;
    await refreshExplorer();
    shareDialogState.share = data.share;
    renderShareModal();
    setMessage(data.message, "success");
  } catch (error) {
    setMessage(error.message, "error");
  } finally {
    setShareBusy(false);
  }
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

function scrollToVault() {
  elements.vaultPanel.scrollIntoView({ behavior: "smooth", block: "start" });
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
  document.body.classList.toggle("dashboard-active", isAuthenticated);
  elements.authView.classList.toggle("hidden", isAuthenticated);
  elements.dashboardView.classList.toggle("hidden", !isAuthenticated);
}

function apiUrl(path, params = {}) {
  const url = new URL(path, window.location.origin);

  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, value);
    }
  });

  return `${url.pathname}${url.search}`;
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});

  if (options.body && !(options.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(path, {
    ...options,
    credentials: "same-origin",
    headers,
  });
  const isJson = response.headers.get("content-type")?.includes("application/json");
  const data = isJson ? await response.json() : null;

  if (!response.ok) {
    throw new Error(data?.error || "Request failed.");
  }

  return data;
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

function closeDialog(result = null) {
  elements.dialogBackdrop.classList.add("hidden");
  const resolver = dialogState.resolver;
  dialogState.resolver = null;

  if (resolver) {
    resolver(result);
  }
}

function openDialog(config) {
  elements.dialogTitle.textContent = config.title;
  elements.dialogDescription.textContent = config.description || "";
  elements.dialogSubmit.textContent = config.submitLabel || "Save";
  elements.dialogInputWrap.classList.toggle("hidden", !config.showInput);
  elements.dialogSelectWrap.classList.toggle("hidden", !config.showSelect);
  elements.dialogInputLabel.textContent = config.inputLabel || "Name";
  elements.dialogSelectLabel.textContent = config.selectLabel || "Destination";
  elements.dialogInput.value = config.inputValue || "";
  elements.dialogSelect.innerHTML = "";

  if (config.showSelect) {
    config.options.forEach((option) => {
      const node = document.createElement("option");
      node.value = option.value;
      node.textContent = option.label;
      if (option.value === (config.selectValue || "")) {
        node.selected = true;
      }

      elements.dialogSelect.appendChild(node);
    });
  }

  elements.dialogBackdrop.classList.remove("hidden");
  return new Promise((resolve) => {
    dialogState.resolver = resolve;
  });
}

function buildFolderPathMap() {
  const folderMap = new Map(state.folderTree.map((folder) => [folder.id, folder]));
  const pathMap = new Map([[null, "Vault"]]);

  state.folderTree.forEach((folder) => {
    const segments = [folder.name];
    let current = folder.parentId ? folderMap.get(folder.parentId) : null;

    while (current) {
      segments.unshift(current.name);
      current = current.parentId ? folderMap.get(current.parentId) : null;
    }

    pathMap.set(folder.id, `Vault / ${segments.join(" / ")}`);
  });

  return pathMap;
}

function renderStats() {
  elements.storageTotal.textContent = `${formatBytes(state.stats.totalBytes)} / ${formatBytes(
    state.stats.storageCapBytes,
  )}`;
  elements.filesCount.textContent = String(state.stats.fileCount || 0);
  elements.foldersCount.textContent = String(state.stats.folderCount || 0);
  elements.trashCount.textContent = String(state.stats.trashCount || 0);
  elements.limitHint.textContent = `Per-file limit: ${formatBytes(
    state.stats.uploadLimitBytes || initialUploadLimit,
  )}`;
  elements.storageDriver.textContent = `${state.storage.label} | ${state.storage.detail}`;
  elements.usageCaption.textContent = `${formatBytes(
    state.stats.totalBytes,
  )} used total. Trash holds ${formatBytes(state.stats.trashBytes || 0)}.`;
  elements.usageFill.style.width = `${Math.min(
    100,
    ((state.stats.totalBytes || 0) / Math.max(1, state.stats.storageCapBytes || 1)) * 100,
  )}%`;
}

function renderBreadcrumb() {
  elements.breadcrumb.innerHTML = state.currentFolder.breadcrumb
    .map((crumb, index) => {
      const isLast = index === state.currentFolder.breadcrumb.length - 1;
      const content = escapeHtml(crumb.name);
      return isLast
        ? `<span class="crumb is-current">${content}</span>`
        : `<button class="crumb" type="button" data-breadcrumb="${escapeHtml(
            crumb.id || "",
          )}">${content}</button>`;
    })
    .join('<span class="crumb-separator">/</span>');
}

function renderFolderTree() {
  const folderMap = new Map(state.folderTree.map((folder) => [folder.id, folder]));
  const childMap = new Map([[null, []]]);

  state.folderTree.forEach((folder) => {
    const bucket = childMap.get(folder.parentId || null) || [];
    bucket.push(folder);
    childMap.set(folder.parentId || null, bucket);
  });

  function renderBranch(parentId, depth) {
    return (childMap.get(parentId) || [])
      .sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true }))
      .map((folder) => {
        const isActive = !state.showTrash && state.currentFolder.id === folder.id;
        return `
          <div class="tree-node" style="--depth:${depth}">
            <button
              class="tree-button${isActive ? " is-active" : ""}"
              type="button"
              data-folder-nav="${escapeHtml(folder.id)}"
            >
              <span class="tree-name">${escapeHtml(folder.name)}</span>
              <span class="tree-count">${folder.itemCount || 0}</span>
            </button>
            ${renderBranch(folder.id, depth + 1)}
          </div>
        `;
      })
      .join("");
  }

  elements.folderTree.innerHTML =
    renderBranch(null, 0) || '<p class="sidebar-note">No folders yet.</p>';
  elements.quickRoot.classList.toggle("is-active", !state.showTrash && !state.currentFolder.id);
  elements.quickTrash.classList.toggle("is-active", state.showTrash);
}

function renderSharedWithMe() {
  const entries = state.sharedWithMe || [];
  elements.sharedWithMeCount.textContent = `${entries.length} link${entries.length === 1 ? "" : "s"}`;

  if (!entries.length) {
    elements.sharedWithMeList.innerHTML =
      '<p class="sidebar-note">Shared links you open while signed in will appear here.</p>';
    return;
  }

  elements.sharedWithMeList.innerHTML = entries
    .map(
      (entry) => `
        <article class="shared-link-card">
          <strong>${escapeHtml(entry.file.name)}</strong>
          <div class="shared-link-meta">
            ${escapeHtml(entry.ownerName)} shared ${escapeHtml(
              entry.permission,
            )} access. ${escapeHtml(
              entry.expiresAt ? `Expires ${formatDate(entry.expiresAt)}.` : "No expiration.",
            )}
          </div>
          <button
            class="ghost-button"
            type="button"
            data-shared-link="${escapeHtml(entry.sharePath)}"
          >
            Open shared file
          </button>
        </article>
      `,
    )
    .join("");
}

function renderUploadQueue() {
  if (!state.uploads.length) {
    elements.uploadQueue.classList.add("hidden");
    elements.uploadQueue.innerHTML = "";
    return;
  }

  elements.uploadQueue.classList.remove("hidden");
  elements.uploadQueue.innerHTML = state.uploads
    .map(
      (upload) => `
        <article class="upload-row">
          <div>
            <strong>${escapeHtml(upload.name)}</strong>
            <span>${escapeHtml(upload.statusLabel)}</span>
          </div>
          <div class="upload-bar">
            <span style="width:${upload.progress}%"></span>
          </div>
        </article>
      `,
    )
    .join("");
}

function iconLabel(item) {
  if (item.kind === "folder") {
    return "DIR";
  }

  switch (item.category) {
    case "image":
      return "IMG";
    case "video":
      return "VID";
    case "audio":
      return "AUD";
    case "document":
      return "DOC";
    default:
      return "FILE";
  }
}

function renderItems() {
  const isList = state.viewMode === "list";
  elements.itemsHeader.classList.toggle("hidden", !isList);
  elements.trashBanner.classList.toggle("hidden", !state.showTrash);

  if (!state.items.length) {
    elements.explorerEmpty.classList.remove("hidden");
    elements.explorerItems.innerHTML = "";
    elements.explorerItems.className = "explorer-items";
    return;
  }

  elements.explorerEmpty.classList.add("hidden");
  elements.explorerItems.className = `explorer-items ${isList ? "is-list" : "is-grid"}`;
  elements.explorerItems.innerHTML = state.items
    .map((item) => {
      const sizeText = item.kind === "folder" ? `${item.itemCount || 0} items` : formatBytes(item.size);
      const shareBadge =
        !state.showTrash && item.kind === "file" && item.share
          ? `<span class="item-share-pill">Shared ${escapeHtml(item.share.permission)}</span>`
          : "";
      const previewAction =
        !state.showTrash && item.kind === "file" && getPreviewKind(item)
          ? `
              <button class="item-action" type="button" data-action="preview-file" data-id="${escapeHtml(item.id)}">
                Preview
              </button>
            `
          : "";
      const commonActions = state.showTrash
        ? `
            <button class="item-action" type="button" data-action="restore" data-id="${escapeHtml(item.id)}">
              Restore
            </button>
            <button class="item-action danger" type="button" data-action="delete-forever" data-id="${escapeHtml(item.id)}">
              Delete forever
            </button>
          `
        : item.kind === "folder"
          ? `
              <button class="item-action" type="button" data-action="open-folder" data-id="${escapeHtml(item.id)}">
                Open
              </button>
              <button class="item-action" type="button" data-action="rename-folder" data-id="${escapeHtml(item.id)}">
                Rename
              </button>
              <button class="item-action danger" type="button" data-action="delete-folder" data-id="${escapeHtml(item.id)}">
                Delete
              </button>
            `
          : `
              ${previewAction}
              <button class="item-action" type="button" data-action="open-share" data-id="${escapeHtml(item.id)}">
                Share
              </button>
              ${
                item.share
                  ? `
                      <button class="item-action" type="button" data-action="copy-share" data-id="${escapeHtml(item.id)}">
                        Copy link
                      </button>
                      <button class="item-action" type="button" data-action="revoke-share" data-id="${escapeHtml(item.id)}">
                        Revoke
                      </button>
                    `
                  : ""
              }
              <button class="item-action" type="button" data-action="download-file" data-id="${escapeHtml(item.id)}">
                Download
              </button>
              <button class="item-action" type="button" data-action="rename-file" data-id="${escapeHtml(item.id)}">
                Rename
              </button>
              <button class="item-action" type="button" data-action="move-file" data-id="${escapeHtml(item.id)}">
                Move
              </button>
              <button class="item-action danger" type="button" data-action="delete-file" data-id="${escapeHtml(item.id)}">
                Delete
              </button>
            `;

      return isList
        ? `
            <article class="item-row">
              <div class="item-main">
                <span class="item-icon" data-kind="${escapeHtml(item.kind)}">${iconLabel(item)}</span>
                <button
                  class="item-name-button"
                  type="button"
                  ${
                    item.kind === "folder"
                      ? `data-action="open-folder" data-id="${escapeHtml(item.id)}"`
                      : getPreviewKind(item)
                        ? `data-action="preview-file" data-id="${escapeHtml(item.id)}"`
                        : ""
                  }
                >
                  ${escapeHtml(item.name)}
                </button>
                ${shareBadge}
              </div>
              <span>${escapeHtml(formatDate(item.updatedAt))}</span>
              <span>${escapeHtml(item.typeLabel || "")}</span>
              <span>${escapeHtml(sizeText)}</span>
              <div class="item-actions">${commonActions}</div>
            </article>
          `
        : `
            <article class="item-card">
              <div class="item-card-head">
                <span class="item-icon" data-kind="${escapeHtml(item.kind)}">${iconLabel(item)}</span>
                <button
                  class="item-name-button"
                  type="button"
                  ${
                    item.kind === "folder"
                      ? `data-action="open-folder" data-id="${escapeHtml(item.id)}"`
                      : getPreviewKind(item)
                        ? `data-action="preview-file" data-id="${escapeHtml(item.id)}"`
                        : ""
                  }
                >
                  ${escapeHtml(item.name)}
                </button>
                ${shareBadge}
              </div>
              <p class="item-meta">${escapeHtml(item.typeLabel || "")}</p>
              <p class="item-meta">${escapeHtml(formatDate(item.updatedAt))}</p>
              <p class="item-meta">${escapeHtml(sizeText)}</p>
              <div class="item-actions">${commonActions}</div>
            </article>
          `;
    })
    .join("");
}

function renderExplorer() {
  renderStats();
  renderBreadcrumb();
  renderFolderTree();
  renderSharedWithMe();
  renderItems();
  renderUploadQueue();
  if (state.user) {
    elements.dashboardTitle.textContent = `${state.user.name}'s ClosetVault`;
    elements.dashboardSubtitle.textContent = `Signed in as ${state.user.email}. ${state.currentFolder.name} is open.`;
  } else {
    elements.dashboardTitle.textContent = "ClosetVault Explorer";
    elements.dashboardSubtitle.textContent = "Your secure file workspace is ready.";
  }
  elements.sortField.value = state.sortBy;
  elements.sortDirection.value = state.sortDirection;
  elements.searchInput.value = state.search;
  elements.viewButtons.forEach((button) => {
    button.classList.toggle("is-active", button.dataset.view === state.viewMode);
  });
}

async function refreshExplorer() {
  const data = await api(
    apiUrl("/api/explorer", {
      folderId: state.showTrash ? undefined : state.currentFolder.id,
      search: state.search || undefined,
      sortBy: state.sortBy,
      sortDirection: state.sortDirection,
      trash: state.showTrash ? "1" : undefined,
    }),
  );

  state.currentFolder = data.currentFolder;
  state.folderTree = data.folderTree || [];
  state.items = data.items || [];
  state.sharedWithMe = data.sharedWithMe || [];
  state.stats = data.stats || state.stats;
  state.storage = data.storage || state.storage;
  syncShareModalWithExplorer();
  renderExplorer();
}

async function restoreSession() {
  try {
    const data = await api("/api/auth/session");

    if (!data.authenticated) {
      state.user = null;
      state.items = [];
      state.sharedWithMe = [];
      closeShareModal();
      renderExplorer();
      setDashboardVisibility(false);
      return;
    }

    state.user = data.user;
    state.storage = data.storage || state.storage;
    state.stats = data.stats || state.stats;
    setDashboardVisibility(true);
    await refreshExplorer();
  } catch (error) {
    setMessage(error.message, "error");
  }
}

async function submitRegister(event) {
  event.preventDefault();
  const formData = new FormData(elements.registerForm);

  setFormBusy(elements.registerForm, true, "Creating...");
  setMessage("");

  try {
    const data = await api("/api/auth/register", {
      body: JSON.stringify({
        email: formData.get("email"),
        name: formData.get("name"),
        password: formData.get("password"),
      }),
      method: "POST",
    });

    state.user = data.user;
    elements.registerForm.reset();
    setDashboardVisibility(true);
    await refreshExplorer();
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
      body: JSON.stringify({
        email: formData.get("email"),
        password: formData.get("password"),
      }),
      method: "POST",
    });

    state.user = data.user;
    elements.loginForm.reset();
    setDashboardVisibility(true);
    await refreshExplorer();
    setMessage(data.message, "success");
  } catch (error) {
    setMessage(error.message, "error");
  } finally {
    setFormBusy(elements.loginForm, false, "Unlocking...");
  }
}

async function uploadBinary(file, targetFolderId, uploadId) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", apiUrl("/api/files/upload", { folderId: targetFolderId || undefined }));
    xhr.responseType = "json";
    xhr.setRequestHeader("X-ClosetVault-Name", encodeURIComponent(file.name));
    xhr.setRequestHeader("X-ClosetVault-Size", String(file.size));

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        const upload = state.uploads.find((entry) => entry.id === uploadId);

        if (upload) {
          upload.progress = Math.round((event.loaded / event.total) * 100);
          upload.statusLabel = `${upload.progress}% uploaded`;
          renderUploadQueue();
        }
      }
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(xhr.response);
        return;
      }

      reject(new Error(xhr.response?.error || "Upload failed."));
    };

    xhr.onerror = () => reject(new Error("Network error during upload."));
    xhr.send(file);
  });
}

async function uploadFiles(fileList) {
  const files = Array.from(fileList || []);

  if (!files.length) {
    return;
  }

  if (state.showTrash) {
    setMessage("Leave Trash before uploading new files.", "error");
    return;
  }

  const targetFolderId = state.currentFolder.id || null;

  files.forEach((file) => {
    state.uploads.push({
      id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
      name: file.name,
      progress: 0,
      statusLabel: "Queued",
    });
  });
  renderUploadQueue();

  try {
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      const upload = state.uploads[index];
      upload.statusLabel = "Uploading...";
      renderUploadQueue();
      await uploadBinary(file, targetFolderId, upload.id);
      upload.progress = 100;
      upload.statusLabel = "Completed";
      renderUploadQueue();
    }

    elements.fileInput.value = "";
    await refreshExplorer();
    setMessage(`${files.length} file${files.length === 1 ? "" : "s"} uploaded.`, "success");
  } catch (error) {
    setMessage(error.message, "error");
  } finally {
    window.setTimeout(() => {
      state.uploads = [];
      renderUploadQueue();
    }, 1200);
  }
}

async function handleLogout() {
  try {
    await api("/api/auth/logout", { method: "POST" });
    closePreview();
    closeShareModal();
    state.currentFolder = { breadcrumb: [{ id: null, name: "Vault" }], id: null, name: "Vault", parentId: null };
    state.folderTree = [];
    state.items = [];
    state.sharedWithMe = [];
    state.showTrash = false;
    state.user = null;
    renderExplorer();
    setDashboardVisibility(false);
    setMessage("Vault locked.", "info");
    scrollToVault();
  } catch (error) {
    setMessage(error.message, "error");
  }
}

function folderOptions(currentFolderId) {
  const pathMap = buildFolderPathMap();
  return [{ label: "Vault / Root", value: "" }]
    .concat(
      state.folderTree
        .filter((folder) => folder.id !== currentFolderId)
        .map((folder) => ({
          label: pathMap.get(folder.id),
          value: folder.id,
        })),
    );
}

async function promptCreateFolder() {
  const result = await openDialog({
    description: "Create a folder in the current location.",
    inputLabel: "Folder name",
    inputValue: "New folder",
    showInput: true,
    showSelect: false,
    submitLabel: "Create",
    title: "Create folder",
  });

  if (!result?.inputValue) {
    return;
  }

  const data = await api("/api/folders", {
    body: JSON.stringify({
      name: result.inputValue,
      parentId: state.showTrash ? null : state.currentFolder.id,
    }),
    method: "POST",
  });

  await refreshExplorer();
  setMessage(data.message, "success");
}

async function renameItem(item, isFolder) {
  const result = await openDialog({
    description: `Choose a new ${isFolder ? "folder" : "file"} name.`,
    inputLabel: "Name",
    inputValue: item.name,
    showInput: true,
    showSelect: false,
    submitLabel: "Save",
    title: `Rename ${isFolder ? "folder" : "file"}`,
  });

  if (!result?.inputValue || result.inputValue === item.name) {
    return;
  }

  const path = isFolder ? `/api/folders/${item.id}` : `/api/files/${item.id}`;
  const data = await api(path, {
    body: JSON.stringify({ name: result.inputValue }),
    method: "PATCH",
  });

  await refreshExplorer();
  setMessage(data.message, "success");
}

async function moveFile(item) {
  const result = await openDialog({
    description: "Choose a destination folder for this file.",
    options: folderOptions(item.folderId),
    selectLabel: "Destination folder",
    selectValue: item.folderId || "",
    showInput: false,
    showSelect: true,
    submitLabel: "Move",
    title: "Move file",
  });

  if (!result) {
    return;
  }

  const data = await api(`/api/files/${item.id}`, {
    body: JSON.stringify({ folderId: result.selectValue || null }),
    method: "PATCH",
  });

  await refreshExplorer();
  setMessage(data.message, "success");
}

async function deleteFolder(item) {
  if (!window.confirm(`Delete folder "${item.name}"? The folder must be empty.`)) {
    return;
  }

  const data = await api(`/api/folders/${item.id}`, { method: "DELETE" });

  if (state.currentFolder.id === item.id) {
    state.currentFolder.id = item.parentId || null;
  }

  await refreshExplorer();
  setMessage(data.message, "success");
}

async function deleteFile(item, permanent = false) {
  const label = permanent ? "permanently delete" : "move to Trash";

  if (!window.confirm(`Do you want to ${label} "${item.name}"?`)) {
    return;
  }

  const data = await api(
    apiUrl(`/api/files/${item.id}`, permanent ? { permanent: "1" } : {}),
    { method: "DELETE" },
  );

  await refreshExplorer();
  setMessage(data.message, "success");
}

async function restoreFile(item) {
  const data = await api(`/api/files/${item.id}/restore`, { method: "POST" });
  await refreshExplorer();
  setMessage(data.message, "success");
}

async function handleExplorerAction(event) {
  const trigger = event.target.closest("[data-action], [data-folder-nav], [data-breadcrumb]");

  if (!trigger) {
    return;
  }

  if (trigger.dataset.folderNav !== undefined) {
    state.showTrash = false;
    state.currentFolder.id = trigger.dataset.folderNav || null;
    await refreshExplorer();
    return;
  }

  if (trigger.dataset.breadcrumb !== undefined) {
    state.showTrash = false;
    state.currentFolder.id = trigger.dataset.breadcrumb || null;
    await refreshExplorer();
    return;
  }

  const item = state.items.find((entry) => entry.id === trigger.dataset.id);

  if (!item && trigger.dataset.action) {
    return;
  }

  try {
    switch (trigger.dataset.action) {
      case "open-folder":
        state.showTrash = false;
        state.currentFolder.id = item.id;
        await refreshExplorer();
        break;
      case "preview-file":
        openPreview(item);
        break;
      case "open-share":
        openShareModal(item);
        break;
      case "copy-share":
        await copyShareLink(item.share);
        break;
      case "revoke-share":
        await revokeShareLink(item.share);
        break;
      case "rename-folder":
        await renameItem(item, true);
        break;
      case "delete-folder":
        await deleteFolder(item);
        break;
      case "download-file":
        window.location.assign(`/api/files/${encodeURIComponent(item.id)}/download`);
        break;
      case "rename-file":
        await renameItem(item, false);
        break;
      case "move-file":
        await moveFile(item);
        break;
      case "delete-file":
        await deleteFile(item, false);
        break;
      case "restore":
        await restoreFile(item);
        break;
      case "delete-forever":
        await deleteFile(item, true);
        break;
      default:
        break;
    }
  } catch (error) {
    setMessage(error.message, "error");
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
    uploadFiles(event.dataTransfer?.files);
  });
}

function bindEvents() {
  elements.createVaultCta.addEventListener("click", () => {
    setAuthTab("register");
    scrollToVault();
  });
  elements.jumpToVault.addEventListener("click", scrollToVault);
  elements.tabButtons.forEach((button) => {
    button.addEventListener("click", () => setAuthTab(button.dataset.tab || "register"));
  });
  elements.registerForm.addEventListener("submit", submitRegister);
  elements.loginForm.addEventListener("submit", submitLogin);
  elements.logoutButton.addEventListener("click", handleLogout);
  elements.uploadButton.addEventListener("click", () => elements.fileInput.click());
  elements.newFolderButton.addEventListener("click", () => {
    promptCreateFolder().catch((error) => setMessage(error.message, "error"));
  });
  elements.quickRoot.addEventListener("click", async () => {
    state.showTrash = false;
    state.currentFolder.id = null;
    await refreshExplorer();
  });
  elements.quickTrash.addEventListener("click", async () => {
    state.showTrash = true;
    await refreshExplorer();
  });
  elements.refreshButton.addEventListener("click", async () => {
    try {
      await refreshExplorer();
      setMessage("Explorer refreshed.", "info");
    } catch (error) {
      setMessage(error.message, "error");
    }
  });
  elements.fileInput.addEventListener("change", (event) => uploadFiles(event.target.files));
  elements.searchInput.addEventListener("input", (event) => {
    state.search = event.target.value;
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      refreshExplorer().catch((error) => setMessage(error.message, "error"));
    }, 180);
  });
  elements.sortField.addEventListener("change", (event) => {
    state.sortBy = event.target.value;
    localStorage.setItem("closetvault.sortBy", state.sortBy);
    refreshExplorer().catch((error) => setMessage(error.message, "error"));
  });
  elements.sortDirection.addEventListener("change", (event) => {
    state.sortDirection = event.target.value;
    localStorage.setItem("closetvault.sortDirection", state.sortDirection);
    refreshExplorer().catch((error) => setMessage(error.message, "error"));
  });
  elements.viewButtons.forEach((button) => {
    button.addEventListener("click", () => {
      state.viewMode = button.dataset.view;
      localStorage.setItem("closetvault.viewMode", state.viewMode);
      renderExplorer();
    });
  });
  elements.explorerItems.addEventListener("click", handleExplorerAction);
  elements.folderTree.addEventListener("click", handleExplorerAction);
  elements.breadcrumb.addEventListener("click", handleExplorerAction);
  elements.dialogCancel.addEventListener("click", () => closeDialog(null));
  elements.dialogBackdrop.addEventListener("click", (event) => {
    if (event.target === elements.dialogBackdrop) {
      closeDialog(null);
    }
  });
  elements.previewClose.addEventListener("click", closePreview);
  elements.previewBackdrop.addEventListener("click", (event) => {
    if (event.target === elements.previewBackdrop) {
      closePreview();
    }
  });
  elements.shareClose.addEventListener("click", closeShareModal);
  elements.shareBackdrop.addEventListener("click", (event) => {
    if (event.target === elements.shareBackdrop) {
      closeShareModal();
    }
  });
  elements.shareForm.addEventListener("submit", submitShare);
  elements.shareCopy.addEventListener("click", () => {
    copyShareLink(shareDialogState.share).catch((error) => setMessage(error.message, "error"));
  });
  elements.shareRevoke.addEventListener("click", () => {
    revokeShareLink(shareDialogState.share).catch((error) => setMessage(error.message, "error"));
  });
  elements.sharedWithMeList.addEventListener("click", (event) => {
    const trigger = event.target.closest("[data-shared-link]");

    if (!trigger) {
      return;
    }

    window.open(trigger.dataset.sharedLink, "_blank", "noopener");
  });
  elements.dialogForm.addEventListener("submit", (event) => {
    event.preventDefault();
    closeDialog({
      inputValue: elements.dialogInput.value.trim(),
      selectValue: elements.dialogSelect.value,
    });
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      if (!elements.previewBackdrop.classList.contains("hidden")) {
        closePreview();
        return;
      }

      if (!elements.shareBackdrop.classList.contains("hidden")) {
        closeShareModal();
        return;
      }

      if (!elements.dialogBackdrop.classList.contains("hidden")) {
        closeDialog(null);
      }
    }
  });
  bindDropzone();
}

bindEvents();
setAuthTab("register");
renderExplorer();
restoreSession();
