(() => {
  const STORAGE_KEY = "closetvault.theme";
  const THEME_OPTIONS = [
    {
      description: "Keep ClosetVault in its original dark explorer look.",
      label: "Dark",
      value: "dark",
    },
    {
      description: "Use a bright, clean workspace with light surfaces and crisp contrast.",
      label: "Light",
      value: "light",
    },
    {
      description: "Match your device appearance automatically.",
      label: "System",
      value: "system",
    },
    {
      description: "Warm sand, bright sky, and sunlit highlights.",
      label: "Summer",
      value: "summer",
    },
    {
      description: "Earthy amber tones with a cozy late-season feel.",
      label: "Autumn",
      value: "autumn",
    },
    {
      description: "Cool ice-blue accents over a crisp winter vault.",
      label: "Winter",
      value: "winter",
    },
    {
      description: "Fresh greens and soft bloom tones for a lighter spring mood.",
      label: "Spring",
      value: "spring",
    },
    {
      description: "Deep ocean blues and teals for a calm, modern explorer.",
      label: "Ocean",
      value: "ocean",
    },
    {
      description: "Coral dusk tones with a warm evening glow.",
      label: "Sunset",
      value: "sunset",
    },
  ];
  const VALID_THEMES = new Set(THEME_OPTIONS.map((option) => option.value));
  const colorModeQuery = window.matchMedia?.("(prefers-color-scheme: light)") || null;
  let animationTimer = 0;

  function normalizeTheme(theme) {
    return VALID_THEMES.has(theme) ? theme : "dark";
  }

  function getStoredTheme() {
    try {
      return normalizeTheme(localStorage.getItem(STORAGE_KEY));
    } catch {
      return normalizeTheme(document.documentElement.dataset.theme || "dark");
    }
  }

  function getSystemColorMode() {
    return colorModeQuery?.matches ? "light" : "dark";
  }

  function animateThemeChange() {
    document.documentElement.classList.add("theme-animating");
    window.clearTimeout(animationTimer);
    animationTimer = window.setTimeout(() => {
      document.documentElement.classList.remove("theme-animating");
    }, 260);
  }

  function syncColorMode() {
    document.documentElement.dataset.colorMode = getSystemColorMode();
  }

  function applyTheme(theme, options = {}) {
    const normalizedTheme = normalizeTheme(theme);
    const shouldAnimate = options.animate !== false;
    const shouldPersist = options.persist !== false;

    if (shouldAnimate) {
      animateThemeChange();
    }

    document.documentElement.dataset.theme = normalizedTheme;
    syncColorMode();

    if (shouldPersist) {
      try {
        localStorage.setItem(STORAGE_KEY, normalizedTheme);
      } catch {}
    }

    window.dispatchEvent(
      new CustomEvent("closetvault:themechange", {
        detail: {
          theme: normalizedTheme,
        },
      }),
    );

    return normalizedTheme;
  }

  if (!document.documentElement.dataset.theme) {
    document.documentElement.dataset.theme = getStoredTheme();
  }

  syncColorMode();

  if (colorModeQuery) {
    const handleSystemChange = () => {
      syncColorMode();

      if ((document.documentElement.dataset.theme || "dark") === "system") {
        animateThemeChange();
        window.dispatchEvent(
          new CustomEvent("closetvault:themechange", {
            detail: {
              theme: "system",
            },
          }),
        );
      }
    };

    if (typeof colorModeQuery.addEventListener === "function") {
      colorModeQuery.addEventListener("change", handleSystemChange);
    } else if (typeof colorModeQuery.addListener === "function") {
      colorModeQuery.addListener(handleSystemChange);
    }
  }

  window.ClosetVaultTheme = {
    applyTheme,
    getThemeOptions() {
      return THEME_OPTIONS.map((option) => ({ ...option }));
    },
    getThemePreference() {
      return normalizeTheme(document.documentElement.dataset.theme || getStoredTheme());
    },
  };
})();
