// --- THEME SWITCHER LOGIC ---
let currentTheme = localStorage.getItem('role-console-theme') || 'dark';

function applyTheme(theme) {
  const themeIcon = document.getElementById('theme-icon');
  if (theme === 'light') {
    document.documentElement.setAttribute('data-theme', 'light');
    if (themeIcon) themeIcon.textContent = 'DARK';
  } else {
    document.documentElement.removeAttribute('data-theme');
    if (themeIcon) themeIcon.textContent = 'LIGHT';
  }
  localStorage.setItem('role-console-theme', theme);
}

function initTheme() {
  const themeToggleBtn = document.getElementById('btn-theme-toggle');
  applyTheme(currentTheme);

  if (themeToggleBtn) {
    themeToggleBtn.addEventListener('click', () => {
      currentTheme = currentTheme === 'dark' ? 'light' : 'dark';
      applyTheme(currentTheme);
    });
  }
}
