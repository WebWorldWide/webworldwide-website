// @ts-check
/**
 * auth.js — login, setup, passkey register/login, logout.
 *
 * Backend endpoints (unchanged from v1):
 *   POST /auth/setup                  — first-time admin user (username + password)
 *   POST /auth/login/password         — password login
 *   GET  /auth/status                 — { setupComplete, authenticated, hasPasskey }
 *   POST /auth/passkey/register/start, /finish
 *   POST /auth/passkey/login/start,    /finish
 *   POST /auth/logout
 *
 * Auth flow:
 *   - On /login.html  : runs status check, flips between setup/login panels,
 *                        wires forms + passkey button + password show/hide.
 *   - On other pages  : redirects to /login.html if not authenticated;
 *                        hides #security-panel if user already has a passkey.
 */
(function () {
  let startRegistration, startAuthentication;
  try {
    if (typeof SimpleWebAuthnBrowser !== 'undefined') {
      startRegistration = SimpleWebAuthnBrowser.startRegistration;
      startAuthentication = SimpleWebAuthnBrowser.startAuthentication;
    }
  } catch (_) {
    /* CDN blocked — handled at use site */
  }

  const onLogin =
    window.location.pathname === '/login.html' || window.location.pathname === '/login';
  const onEditor = window.location.pathname.startsWith('/editor');

  function showAuthError(message) {
    const el = document.getElementById('auth-error');
    if (el) {
      el.textContent = String(message || 'Something went wrong.');
      el.classList.add('show');
      return;
    }
    if (window.TE) TE.toast(message, 'error');
    else alert(message);
  }
  function clearAuthError() {
    const el = document.getElementById('auth-error');
    if (el) {
      el.textContent = '';
      el.classList.remove('show');
    }
  }

  function showPanel(id) {
    document.querySelectorAll('.auth-panel').forEach((p) => p.classList.remove('active'));
    const el = document.getElementById(id);
    if (el) el.classList.add('active');
  }

  // ── Status check (decides which panel/state to render) ────
  async function checkStatus() {
    let data;
    try {
      const res = await fetch('/auth/status', { credentials: 'same-origin' });
      data = await res.json();
    } catch (err) {
      console.error('auth status check failed', err);
      return;
    }

    if (onLogin) {
      if (data.authenticated) {
        window.location.href = '/index.html';
        return;
      }
      showPanel(data.setupComplete ? 'login-panel' : 'setup-panel');
      return;
    }

    // Any other page: gate it.
    if (!data.authenticated) {
      window.location.href = '/login.html';
      return;
    }
    // Hide the "register passkey" CTA if user already has one.
    if (data.hasPasskey) {
      const sec = document.getElementById('security-panel');
      if (sec) sec.style.display = 'none';
    } else {
      const status = document.getElementById('passkey-status');
      if (status) status.textContent = 'No passkey on this device';
    }
  }

  // ── Setup form (first-time admin) ─────────────────────────
  function wireSetupForm() {
    const form = document.getElementById('setup-form');
    if (!form) return;
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      clearAuthError();
      const username = document.getElementById('setup-user').value.trim();
      const password = document.getElementById('setup-pass').value;
      if (username.length < 2) return showAuthError('Username must be at least 2 characters.');
      if (password.length < 8) return showAuthError('Password must be at least 8 characters.');
      try {
        await TE.fetchJSON('/auth/setup', {
          method: 'POST',
          body: JSON.stringify({ username, password }),
        });
        window.location.href = '/index.html';
      } catch (err) {
        showAuthError(err.message);
      }
    });
  }

  // ── Password login ─────────────────────────────────────────
  function wireLoginForm() {
    const form = document.getElementById('login-form');
    if (!form) return;
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      clearAuthError();
      const username = document.getElementById('login-user').value.trim();
      const password = document.getElementById('login-pass').value;
      if (!username || !password) return showAuthError('Username and password required.');
      try {
        await TE.fetchJSON('/auth/login/password', {
          method: 'POST',
          body: JSON.stringify({ username, password }),
        });
        window.location.href = '/index.html';
      } catch (err) {
        showAuthError(err.message);
      }
    });
  }

  // ── Passkey login button ──────────────────────────────────
  function wirePasskeyLogin() {
    const btn = document.getElementById('btn-passkey-login');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      clearAuthError();
      if (!startAuthentication) {
        showAuthError('Passkey library blocked. Disable ad-blocker, or use password.');
        return;
      }
      try {
        const start = await TE.fetchJSON('/auth/passkey/login/start', {
          method: 'POST',
          body: '{}',
        });
        let assertion;
        try {
          assertion = await startAuthentication(start.options);
        } catch (err) {
          if (err.name === 'NotAllowedError') return; // user cancelled
          throw err;
        }
        await TE.fetchJSON('/auth/passkey/login/finish', {
          method: 'POST',
          body: JSON.stringify({ challengeId: start.challengeId, credential: assertion }),
        });
        window.location.href = '/index.html';
      } catch (err) {
        console.error(err);
        showAuthError(err.message || 'Passkey login failed. Try password.');
      }
    });
  }

  // ── Passkey registration (dashboard "register passkey") ───
  function wirePasskeyRegister() {
    const btn = document.getElementById('btn-register-passkey');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      if (!startRegistration) {
        TE.toast('Passkey library blocked. Disable ad-blocker.', 'error');
        return;
      }
      try {
        const start = await TE.fetchJSON('/auth/passkey/register/start', {
          method: 'POST',
          body: '{}',
        });
        let credential;
        try {
          credential = await startRegistration(start.options);
        } catch (err) {
          if (err.name === 'NotAllowedError') return;
          throw err;
        }
        await TE.fetchJSON('/auth/passkey/register/finish', {
          method: 'POST',
          body: JSON.stringify({ challengeId: start.challengeId, credential }),
        });
        TE.toast('Passkey registered. You can now sign in with it.');
        const sec = document.getElementById('security-panel');
        if (sec) sec.style.display = 'none';
      } catch (err) {
        console.error(err);
        TE.toast(err.message || 'Passkey registration failed.', 'error');
      }
    });
  }

  // ── Logout ─────────────────────────────────────────────────
  function wireLogout() {
    const btn = document.getElementById('btn-logout');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      try {
        await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' });
      } catch (_) {
        /* ignore */
      }
      window.location.href = '/login.html';
    });
  }

  // ── Password show/hide toggle + "use password" disclosure ─
  function wirePasswordToggles() {
    document.querySelectorAll('.pw-toggle').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-target');
        const input = document.getElementById(id);
        if (!input) return;
        if (input.type === 'password') {
          input.type = 'text';
          btn.textContent = 'Hide';
          btn.setAttribute('aria-label', 'Hide password');
        } else {
          input.type = 'password';
          btn.textContent = 'Show';
          btn.setAttribute('aria-label', 'Show password');
        }
      });
    });

    const disclosure = document.getElementById('toggle-password-form');
    const form = document.getElementById('login-form');
    if (disclosure && form) {
      disclosure.addEventListener('click', () => {
        const open = form.classList.toggle('open');
        disclosure.setAttribute('aria-expanded', open ? 'true' : 'false');
        if (open) {
          const user = document.getElementById('login-user');
          if (user)
            try {
              user.focus();
            } catch (_) {
              /* focus may fail in some sandboxes */
            }
        }
      });
    }
  }

  // ── Boot ───────────────────────────────────────────────────
  function boot() {
    wirePasswordToggles();
    if (onLogin) {
      wireSetupForm();
      wireLoginForm();
      wirePasskeyLogin();
      checkStatus();
    } else {
      // Skip status check on editor page only if you want — but editor
      // currently doesn't have its own. We always gate.
      void onEditor;
      wireLogout();
      wirePasskeyRegister();
      checkStatus();
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
