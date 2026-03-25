const shareToken = decodeURIComponent(
  window.location.pathname.split("/").filter(Boolean).slice(-1)[0] || "",
);

const state = {
  file: null,
  grant: "",
  share: null,
  token: shareToken,
};

const elements = {
  banner: document.getElementById("share-page-banner"),
  detailDate: document.getElementById("share-detail-date"),
  detailExpiration: document.getElementById("share-detail-expiration"),
  detailName: document.getElementById("share-detail-name"),
  detailOwner: document.getElementById("share-detail-owner"),
  detailPermission: document.getElementById("share-detail-permission"),
  detailSize: document.getElementById("share-detail-size"),
  detailType: document.getElementById("share-detail-type"),
  downloadButton: document.getElementById("share-download-button"),
  passwordForm: document.getElementById("share-password-form"),
  passwordInput: document.getElementById("share-password-input"),
  passwordSubmit: document.getElementById("share-password-submit"),
  previewAudio: document.getElementById("share-preview-audio"),
  previewEmpty: document.getElementById("share-preview-empty"),
  previewImage: document.getElementById("share-preview-image"),
  previewPdf: document.getElementById("share-preview-pdf"),
  previewVideo: document.getElementById("share-preview-video"),
  renameForm: document.getElementById("share-rename-form"),
  renameInput: document.getElementById("share-rename-input"),
  renameSubmit: document.getElementById("share-rename-submit"),
  subtitle: document.getElementById("share-page-subtitle"),
  title: document.getElementById("share-page-title"),
  unlockPanel: document.getElementById("share-unlock-panel"),
};

function setBanner(message, tone = "info") {
  if (!message) {
    elements.banner.textContent = "";
    elements.banner.dataset.tone = "";
    elements.banner.classList.add("hidden");
    return;
  }

  elements.banner.textContent = message;
  elements.banner.dataset.tone = tone;
  elements.banner.classList.remove("hidden");
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

function getPreviewKind(file) {
  if (!file) {
    return null;
  }

  const mimeType = String(file.mimeType || "").toLowerCase();
  const extension = String(file.extension || "").toLowerCase();

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

function resetPreview() {
  elements.previewImage.classList.add("hidden");
  elements.previewVideo.classList.add("hidden");
  elements.previewAudio.classList.add("hidden");
  elements.previewPdf.classList.add("hidden");
  elements.previewImage.removeAttribute("src");
  elements.previewVideo.pause();
  elements.previewVideo.removeAttribute("src");
  elements.previewVideo.load();
  elements.previewAudio.pause();
  elements.previewAudio.removeAttribute("src");
  elements.previewAudio.load();
  elements.previewPdf.removeAttribute("src");
}

function contentUrl(download = false) {
  const url = new URL(
    `/api/share-links/${encodeURIComponent(state.token)}/content`,
    window.location.origin,
  );
  url.searchParams.set("grant", state.grant);

  if (download) {
    url.searchParams.set("download", "1");
  }

  return `${url.pathname}${url.search}`;
}

function renderPreview() {
  resetPreview();

  if (!state.grant || !state.file) {
    elements.previewEmpty.textContent = state.share?.requiresPassword
      ? "Unlock the shared file to load its preview."
      : "Preview loading...";
    elements.previewEmpty.classList.remove("hidden");
    return;
  }

  const kind = getPreviewKind(state.file);

  if (!kind) {
    elements.previewEmpty.textContent = "Preview unavailable for this file type. Download to open it.";
    elements.previewEmpty.classList.remove("hidden");
    return;
  }

  elements.previewEmpty.classList.add("hidden");

  if (kind === "image") {
    elements.previewImage.src = contentUrl(false);
    elements.previewImage.alt = state.file.name;
    elements.previewImage.classList.remove("hidden");
    return;
  }

  if (kind === "video") {
    elements.previewVideo.src = contentUrl(false);
    elements.previewVideo.classList.remove("hidden");
    return;
  }

  if (kind === "audio") {
    elements.previewAudio.src = contentUrl(false);
    elements.previewAudio.classList.remove("hidden");
    return;
  }

  elements.previewPdf.src = contentUrl(false);
  elements.previewPdf.classList.remove("hidden");
}

function render() {
  const file = state.file;
  const share = state.share;

  elements.title.textContent = file?.name || "Shared file";
  elements.subtitle.textContent = share
    ? `${share.sharedBy} shared ${
        share.permission === "edit" ? "edit" : "view"
      } access to this file.`
    : "Open a secure ClosetVault shared file link.";
  elements.detailName.textContent = file?.name || "Locked shared file";
  elements.detailType.textContent = file?.mimeType || "Hidden until unlocked";
  elements.detailSize.textContent = file ? formatBytes(file.size || 0) : "Hidden until unlocked";
  elements.detailDate.textContent = file?.createdAt ? formatDate(file.createdAt) : "-";
  elements.detailOwner.textContent = share?.sharedBy || "-";
  elements.detailPermission.textContent = share
    ? share.permission === "edit"
      ? "Edit access"
      : "View access"
    : "-";
  elements.detailExpiration.textContent = share?.expiresAt
    ? formatDate(share.expiresAt)
    : "No expiration";
  elements.downloadButton.disabled = !state.grant;
  elements.unlockPanel.classList.toggle(
    "hidden",
    !share?.requiresPassword || Boolean(state.grant),
  );
  elements.renameForm.classList.toggle(
    "hidden",
    !state.grant || share?.permission !== "edit" || !file,
  );

  if (file) {
    elements.renameInput.value = file.name;
  }

  renderPreview();
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});

  if (options.body && !headers.has("Content-Type")) {
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

async function unlockShare(password, showSuccess = false) {
  const data = await api(`/api/share-links/${encodeURIComponent(state.token)}/access`, {
    body: JSON.stringify(password ? { password } : {}),
    method: "POST",
  });

  state.file = data.file;
  state.grant = data.grant;
  state.share = data.share;
  render();

  if (showSuccess) {
    setBanner("Shared file unlocked.", "success");
  }
}

async function loadShare() {
  if (!state.token) {
    setBanner("This share link is invalid.", "error");
    return;
  }

  try {
    const data = await api(`/api/share-links/${encodeURIComponent(state.token)}`);
    state.share = data.share;
    state.file = data.file;
    render();

    if (!data.share.requiresPassword) {
      await unlockShare("", false);
    }
  } catch (error) {
    setBanner(error.message, "error");
    elements.previewEmpty.textContent = error.message;
    elements.previewEmpty.classList.remove("hidden");
  }
}

async function handlePasswordSubmit(event) {
  event.preventDefault();
  elements.passwordSubmit.disabled = true;
  elements.passwordSubmit.textContent = "Unlocking...";
  setBanner("");

  try {
    await unlockShare(elements.passwordInput.value, true);
    elements.passwordInput.value = "";
  } catch (error) {
    setBanner(error.message, "error");
  } finally {
    elements.passwordSubmit.disabled = false;
    elements.passwordSubmit.textContent = "Unlock file";
  }
}

async function handleRenameSubmit(event) {
  event.preventDefault();

  if (!state.grant || !state.file) {
    return;
  }

  elements.renameSubmit.disabled = true;
  elements.renameSubmit.textContent = "Saving...";

  try {
    const data = await api(
      `/api/share-links/${encodeURIComponent(state.token)}/file?grant=${encodeURIComponent(
        state.grant,
      )}`,
      {
        body: JSON.stringify({ name: elements.renameInput.value }),
        method: "PATCH",
      },
    );

    state.file = {
      ...state.file,
      ...data.file,
    };
    render();
    setBanner(data.message, "success");
  } catch (error) {
    setBanner(error.message, "error");
  } finally {
    elements.renameSubmit.disabled = false;
    elements.renameSubmit.textContent = "Save name";
  }
}

elements.passwordForm.addEventListener("submit", handlePasswordSubmit);
elements.renameForm.addEventListener("submit", handleRenameSubmit);
elements.downloadButton.addEventListener("click", () => {
  if (!state.grant) {
    return;
  }

  window.location.assign(contentUrl(true));
});

render();
loadShare();
