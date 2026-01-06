// Simple client-side lock screen. Low-stakes deterrent only.
// Password is checked client-side; visible to anyone who reads source.

(function() {
  const LOCK_KEY_SESSION = 'daymx-unlocked';
  const LOCK_KEY_PERSIST = 'daymx-unlocked';
  const LOCK_PASS = '6349xj';

  let unlockResolve;
  const ready = new Promise(res => (unlockResolve = res));
  window.daymxUnlockReady = ready;

  function unlocked() {
    try {
      if (sessionStorage.getItem(LOCK_KEY_SESSION) === '1') return true;
      if (localStorage.getItem(LOCK_KEY_PERSIST) === '1') return true;
      return false;
    } catch { return false; }
  }

  function markUnlocked(persist) {
    try {
      sessionStorage.setItem(LOCK_KEY_SESSION, '1');
      if (persist) localStorage.setItem(LOCK_KEY_PERSIST, '1');
    } catch {}
  }

  function showLock() {
    const overlay = document.getElementById('lock');
    if (!overlay) { unlockResolve(); return; }
    overlay.hidden = false;

    const form = document.getElementById('lock-form');
    const input = document.getElementById('lock-input');
    const msg = document.getElementById('lock-msg');
    const remember = document.getElementById('lock-remember');

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const pwd = (input.value || '').trim();
      if (pwd === LOCK_PASS) {
        markUnlocked(remember.checked);
        overlay.hidden = true;
        const app = document.getElementById('app');
        if (app) app.hidden = false;
        // Fully remove overlay to avoid any z-index or pointer-events issues
        try { overlay.parentNode && overlay.parentNode.removeChild(overlay); } catch {}
        unlockResolve();
      } else {
        msg.textContent = 'Incorrect password';
        input.select();
      }
    });
    input.focus();
  }

  document.addEventListener('DOMContentLoaded', () => {
    if (unlocked()) {
      const overlay = document.getElementById('lock');
      overlay?.setAttribute('hidden', 'true');
      const app = document.getElementById('app');
      if (app) app.hidden = false;
      try { overlay?.parentNode && overlay.parentNode.removeChild(overlay); } catch {}
      unlockResolve();
    } else {
      showLock();
    }
  });
})();
