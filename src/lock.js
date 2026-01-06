// Simple client-side lock screen. Low-stakes deterrent only.
// Default password: "daymx" (change by updating LOCK_HASH below).

(function() {
  const LOCK_KEY_SESSION = 'daymx-unlocked';
  const LOCK_KEY_PERSIST = 'daymx-unlocked';
  // SHA-256("daymx") in hex (lowercase)
  const LOCK_HASH = '5f8a2f4c2ed2e2fd68ebf209c098f0fdb5a9a0d0c8a1a0f2f1a8c4a7e3a9a4b0';

  async function sha256Hex(text) {
    const enc = new TextEncoder();
    const data = enc.encode(text);
    const hash = await crypto.subtle.digest('SHA-256', data);
    const bytes = new Uint8Array(hash);
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  }

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
      const pwd = input.value || '';
      const hex = await sha256Hex(pwd);
      if (hex === LOCK_HASH) {
        markUnlocked(remember.checked);
        overlay.hidden = true;
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
      document.getElementById('lock')?.setAttribute('hidden', 'true');
      unlockResolve();
    } else {
      showLock();
    }
  });
})();

