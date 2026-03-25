(() => {
  const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const MESSAGE_MIN_LENGTH = 10;
  const MESSAGE_MAX_LENGTH = 2000;

  const elements = {
    backdrop: document.getElementById("support-backdrop"),
    button: document.getElementById("support-button"),
    cancel: document.getElementById("support-cancel"),
    close: document.getElementById("support-close"),
    email: document.getElementById("support-email"),
    feedback: document.getElementById("support-feedback"),
    form: document.getElementById("support-form"),
    message: document.getElementById("support-message"),
    submit: document.getElementById("support-submit"),
  };

  const isAvailable = Object.values(elements).every(Boolean);

  const state = {
    closeTimer: 0,
    defaultEmail: "",
    isBusy: false,
    notifier: null,
  };

  function clearCloseTimer() {
    if (state.closeTimer) {
      window.clearTimeout(state.closeTimer);
      state.closeTimer = 0;
    }
  }

  function setFeedback(message, tone = "info") {
    if (!isAvailable) {
      return;
    }

    if (!message) {
      elements.feedback.textContent = "";
      elements.feedback.dataset.tone = "";
      elements.feedback.classList.add("hidden");
      return;
    }

    elements.feedback.textContent = message;
    elements.feedback.dataset.tone = tone;
    elements.feedback.classList.remove("hidden");
  }

  function setBusy(isBusy) {
    state.isBusy = isBusy;

    if (!isAvailable) {
      return;
    }

    elements.email.disabled = isBusy;
    elements.message.disabled = isBusy;
    elements.cancel.disabled = isBusy;
    elements.close.disabled = isBusy;
    elements.submit.disabled = isBusy;
    elements.submit.textContent = isBusy ? "Sending..." : "Send";
  }

  function setDefaultEmail(email) {
    const previousEmail = state.defaultEmail;
    state.defaultEmail = String(email || "").trim();

    if (!isAvailable) {
      return;
    }

    if (!elements.email.value.trim() || elements.email.value === previousEmail) {
      elements.email.value = state.defaultEmail;
    }
  }

  function open() {
    if (!isAvailable) {
      return;
    }

    clearCloseTimer();
    setFeedback("");

    if (!elements.email.value.trim() && state.defaultEmail) {
      elements.email.value = state.defaultEmail;
    }

    elements.backdrop.classList.remove("hidden");

    if (elements.email.value.trim()) {
      elements.message.focus();
      return;
    }

    elements.email.focus();
  }

  function close(options = {}) {
    if (!isAvailable || state.isBusy) {
      return;
    }

    clearCloseTimer();
    elements.backdrop.classList.add("hidden");

    if (options.resetForm) {
      elements.form.reset();

      if (state.defaultEmail) {
        elements.email.value = state.defaultEmail;
      }
    }

    if (options.clearFeedback !== false) {
      setFeedback("");
    }
  }

  function validateForm() {
    const email = String(elements.email.value || "").trim().toLowerCase();
    const message = String(elements.message.value || "").trim();

    if (!EMAIL_PATTERN.test(email)) {
      throw new Error("Enter a valid support email address.");
    }

    if (message.length < MESSAGE_MIN_LENGTH) {
      throw new Error("Add a support message with at least 10 characters.");
    }

    if (message.length > MESSAGE_MAX_LENGTH) {
      throw new Error("Support messages must stay under 2000 characters.");
    }

    return { email, message };
  }

  async function submit(event) {
    event.preventDefault();

    if (!isAvailable) {
      return;
    }

    let payload;

    try {
      payload = validateForm();
    } catch (error) {
      setFeedback(error.message, "error");
      return;
    }

    setBusy(true);
    setFeedback("");

    try {
      const response = await fetch("/api/support", {
        body: JSON.stringify(payload),
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data?.error || "Request failed.");
      }

      setFeedback(data.message, "success");
      if (typeof state.notifier === "function") {
        state.notifier(data.message, "success");
      }

      elements.form.reset();
      if (state.defaultEmail) {
        elements.email.value = state.defaultEmail;
      }

      state.closeTimer = window.setTimeout(() => {
        state.closeTimer = 0;
        close({ clearFeedback: true });
      }, 900);
    } catch (error) {
      setFeedback(error.message, "error");
    } finally {
      setBusy(false);
    }
  }

  window.ClosetVaultSupport = {
    close,
    open,
    setDefaultEmail,
    setNotifier(notifier) {
      state.notifier = typeof notifier === "function" ? notifier : null;
    },
  };

  if (!isAvailable) {
    return;
  }

  elements.button.addEventListener("click", open);
  elements.close.addEventListener("click", () => close());
  elements.cancel.addEventListener("click", () => close());
  elements.form.addEventListener("submit", submit);
  elements.backdrop.addEventListener("click", (event) => {
    if (event.target === elements.backdrop) {
      close();
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !elements.backdrop.classList.contains("hidden")) {
      close();
    }
  });
})();
