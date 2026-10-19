(() => {
  const key = 'deepsearch-theme';
  const system = window.matchMedia('(prefers-color-scheme: dark)');
  let preference = 'system';
  try {
    const saved = localStorage.getItem(key);
    if (['light', 'dark', 'system'].includes(saved)) preference = saved;
  } catch { /* Storage may be disabled; keep the in-memory preference. */ }

  function apply() {
    const theme = preference === 'system' ? (system.matches ? 'dark' : 'light') : preference;
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.themePreference = preference;
    document.querySelector('meta[name="color-scheme"]').content = theme;
  }

  // This classic script runs before the stylesheet and before the body is parsed.
  apply();
  system.addEventListener('change', () => {
    if (preference === 'system') apply();
  });
  document.addEventListener('DOMContentLoaded', () => {
    const buttons = document.querySelectorAll('[data-theme-choice]');
    function syncButtons() {
      buttons.forEach(button => {
        button.setAttribute('aria-pressed', String(button.dataset.themeChoice === preference));
      });
    }
    syncButtons();
    buttons.forEach(button => {
      button.addEventListener('click', () => {
        // Enable motion only after an interaction, never during initial rendering.
        document.querySelector('.theme-picker').classList.add('is-interactive');
        preference = button.dataset.themeChoice;
        apply();
        syncButtons();
        try { localStorage.setItem(key, preference); } catch { /* Switching still works without storage. */ }
      });
    });
  });
})();
