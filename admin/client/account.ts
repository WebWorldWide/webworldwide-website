// @ts-check
/**
 * account.js — Settings → Account security.
 *
 * Passkey list / add / rename / remove, signed-in sessions with revoke, and
 * password change. Backed by /api/account (routes/account.ts) and the
 * WebAuthn ceremony endpoints under /auth/passkey/register/*.
 */
(function () {
  /** @param {string} id */
  const $ = (id) => document.getElementById(id);
  const esc = (/** @type {unknown} */ v) =>
    window.TE ? TE.escape(String(v ?? '')) : String(v ?? '');

  /** @param {string | null | undefined} v SQLite datetime or epoch ms */
  function when(v) {
    if (v === null || v === undefined || v === '') return 'never';
    const d =
      typeof v === 'number'
        ? new Date(v)
        : new Date(String(v).replace(' ', 'T') + (String(v).includes('Z') ? '' : 'Z'));
    if (Number.isNaN(d.getTime())) return String(v);
    return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  }

  /** Short device summary from a User-Agent string. */
  function device(ua) {
    const s = String(ua || '');
    const os = /iPhone|iPad/.test(s)
      ? 'iOS'
      : /Android/.test(s)
        ? 'Android'
        : /Mac OS X/.test(s)
          ? 'macOS'
          : /Windows/.test(s)
            ? 'Windows'
            : /Linux/.test(s)
              ? 'Linux'
              : 'Unknown OS';
    const br = /Edg\//.test(s)
      ? 'Edge'
      : /Firefox\//.test(s)
        ? 'Firefox'
        : /Chrome\//.test(s)
          ? 'Chrome'
          : /Safari\//.test(s)
            ? 'Safari'
            : 'Browser';
    return `${br} on ${os}`;
  }

  /** @param {any} err */
  const msg = (err) =>
    (err && err.data && err.data.message) || (err && err.message) || 'Something went wrong.';

  async function load() {
    const panel = $('account-security');
    if (!panel || !window.TE) return;
    let data;
    try {
      data = await TE.fetchJSON('/api/account');
    } catch (err) {
      const list = $('passkey-list');
      if (list)
        list.innerHTML = `<li class="account-empty">Couldn't load account: ${esc(msg(err))}</li>`;
      return;
    }

    const status = $('passkey-status');
    if (status) {
      status.textContent = data.passkeys.length
        ? `${data.passkeys.length} passkey${data.passkeys.length === 1 ? '' : 's'}`
        : 'No passkey yet';
    }

    const warn = $('account-warning');
    if (warn) {
      if (!data.passkeys.length) {
        warn.hidden = false;
        warn.textContent =
          'This account is protected only by a password. Add a passkey now — password sign-in turns off automatically once you do.';
      } else if (data.breakGlass) {
        warn.hidden = false;
        warn.textContent =
          'ALLOW_PASSWORD_LOGIN=1 is set on the server, so password sign-in is still enabled. Remove it once you can sign in with a passkey.';
      } else {
        warn.hidden = true;
      }
    }

    const pk = $('passkey-list');
    if (pk) {
      pk.innerHTML = data.passkeys.length
        ? data.passkeys
            .map(
              (/** @type {any} */ k) => `<li class="account-item" data-id="${esc(k.id)}">
                <span class="account-main"><b>${esc(k.name || 'Passkey')}</b>
                  <small>added ${esc(when(k.created_at))} · last used ${esc(when(k.last_used_at))}</small></span>
                <span class="account-actions">
                  <button type="button" class="btn ghost" data-act="rename">Rename</button>
                  <button type="button" class="btn ghost danger" data-act="remove">Remove</button>
                </span>
              </li>`,
            )
            .join('')
        : '<li class="account-empty">No passkeys registered.</li>';
    }

    const sl = $('session-list');
    if (sl) {
      sl.innerHTML = data.sessions
        .map(
          (/** @type {any} */ s) => `<li class="account-item" data-id="${esc(s.id)}">
            <span class="account-main"><b>${esc(device(s.user_agent))}</b>${s.current ? ' <em>(this session)</em>' : ''}
              <small>${esc(s.method)} sign-in ${esc(when(s.created_at))} · active ${esc(when(s.last_seen_at))} · ${esc(s.ip || 'unknown IP')}</small></span>
            <span class="account-actions">
              <button type="button" class="btn ghost" data-act="revoke">${s.current ? 'Sign out' : 'Revoke'}</button>
            </span>
          </li>`,
        )
        .join('');
    }
  }

  async function addPasskey() {
    const lib = /** @type {any} */ window.SimpleWebAuthnBrowser;
    if (!lib || !lib.startRegistration) {
      TE.toast('Passkey library blocked. Disable ad-blocker.', 'error');
      return;
    }
    const nameEl = /** @type {HTMLInputElement | null} */ $('passkey-name');
    try {
      const start = await TE.fetchJSON('/auth/passkey/register/start', {
        method: 'POST',
        body: '{}',
      });
      let credential;
      try {
        credential = await lib.startRegistration({ optionsJSON: start.options });
      } catch (err) {
        if (err && err.name === 'NotAllowedError') return;
        throw err;
      }
      await TE.fetchJSON('/auth/passkey/register/finish', {
        method: 'POST',
        body: JSON.stringify({
          challengeId: start.challengeId,
          credential,
          name: nameEl ? nameEl.value : '',
        }),
      });
      if (nameEl) nameEl.value = '';
      TE.toast('Passkey added. Password sign-in is now off for this account.');
      load();
    } catch (err) {
      console.error(err);
      TE.toast(msg(err), 'error');
    }
  }

  function wire() {
    const panel = $('account-security');
    if (!panel) return;

    $('btn-register-passkey')?.addEventListener('click', addPasskey);

    $('passkey-list')?.addEventListener('click', async (e) => {
      const btn = /** @type {HTMLElement} */ e.target.closest('button[data-act]');
      const item = btn && btn.closest('[data-id]');
      if (!btn || !item) return;
      const id = item.getAttribute('data-id') || '';
      try {
        if (btn.getAttribute('data-act') === 'rename') {
          const name = window.prompt('Passkey name', item.querySelector('b')?.textContent || '');
          if (!name) return;
          await TE.fetchJSON(`/api/account/passkeys/${encodeURIComponent(id)}`, {
            method: 'PATCH',
            body: JSON.stringify({ name }),
          });
        } else {
          if (
            !window.confirm('Remove this passkey? You will no longer be able to sign in with it.')
          )
            return;
          const r = await TE.fetchJSON(`/api/account/passkeys/${encodeURIComponent(id)}`, {
            method: 'DELETE',
          });
          if (r.remaining === 0)
            TE.toast('Last passkey removed — password sign-in is enabled again.', 'error');
        }
        load();
      } catch (err) {
        TE.toast(msg(err), 'error');
      }
    });

    $('session-list')?.addEventListener('click', async (e) => {
      const btn = /** @type {HTMLElement} */ e.target.closest('button[data-act="revoke"]');
      const item = btn && btn.closest('[data-id]');
      if (!btn || !item) return;
      try {
        const r = await TE.fetchJSON(
          `/api/account/sessions/${encodeURIComponent(item.getAttribute('data-id') || '')}`,
          { method: 'DELETE' },
        );
        if (r.current) {
          window.location.href = '/login.html';
          return;
        }
        load();
      } catch (err) {
        TE.toast(msg(err), 'error');
      }
    });

    $('btn-revoke-others')?.addEventListener('click', async () => {
      try {
        const r = await TE.fetchJSON('/api/account/sessions/revoke-others', {
          method: 'POST',
          body: '{}',
        });
        TE.toast(`Signed out ${r.revoked} other session${r.revoked === 1 ? '' : 's'}.`);
        load();
      } catch (err) {
        TE.toast(msg(err), 'error');
      }
    });

    $('password-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const cur = /** @type {HTMLInputElement} */ $('pw-current');
      const next = /** @type {HTMLInputElement} */ $('pw-next');
      if (next.value.length < 12) {
        TE.toast('Use at least 12 characters.', 'error');
        return;
      }
      try {
        const r = await TE.fetchJSON('/api/account/password', {
          method: 'POST',
          body: JSON.stringify({ current: cur.value, next: next.value }),
        });
        cur.value = '';
        next.value = '';
        TE.toast(`Password changed. ${r.revokedSessions} other session(s) signed out.`);
        load();
      } catch (err) {
        TE.toast(msg(err), 'error');
      }
    });

    load();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();
})();
