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
 *   - On other pages  : redirects to /login.html if not authenticated.
 *                        (Passkey management: account.js.)
 */
(function () {
  // Resolve the WebAuthn library at CLICK time, not at script start: the
  // vendor bundle is loaded with `defer`, which executes AFTER this
  // (non-deferred, end-of-body) script — so reading it at startup always saw
  // `undefined` and passkey sign-in reported a bogus "library blocked".
  const webauthn = () =>
    /** @type {any} */ window.SimpleWebAuthnBrowser &&
    /** @type {any} */ window.SimpleWebAuthnBrowser.startAuthentication
      ? /** @type {any} */ window.SimpleWebAuthnBrowser
      : null;

  const onLogin =
    window.location.pathname === '/login.html' || window.location.pathname === '/login';

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
      // Passkeys enforced → don't offer a password form that will be refused.
      if (data.setupComplete && data.passwordLogin === false) {
        const disclosure = document.getElementById('toggle-password-form');
        const form = document.getElementById('login-form');
        if (disclosure) disclosure.hidden = true;
        if (form) form.hidden = true;
      }
      return;
    }

    // Any other page: gate it.
    if (!data.authenticated) {
      window.location.href = '/login.html';
      return;
    }
    // Passkey list / registration lives in account.js (Settings → Account security).
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
      if (password.length < 12) return showAuthError('Password must be at least 12 characters.');
      const tokenEl = /** @type {HTMLInputElement | null} */ document.getElementById('setup-token');
      const setupToken = tokenEl ? tokenEl.value : '';
      try {
        await TE.fetchJSON('/auth/setup', {
          method: 'POST',
          body: JSON.stringify({ username, password, setupToken }),
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
        showAuthError((err.data && err.data.message) || err.message);
      }
    });
  }

  // ── Passkey login button ──────────────────────────────────
  function wirePasskeyLogin() {
    const btn = document.getElementById('btn-passkey-login');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      clearAuthError();
      const lib = webauthn();
      if (!lib) {
        showAuthError(
          'The passkey component did not load. Reload the page; if it persists, a content blocker may be stopping /vendor/simplewebauthn-browser.umd.min.js.',
        );
        return;
      }
      try {
        const start = await TE.fetchJSON('/auth/passkey/login/start', {
          method: 'POST',
          body: '{}',
        });
        let assertion;
        try {
          assertion = await lib.startAuthentication({ optionsJSON: start.options });
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
      wireLogout();
      checkStatus();
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
