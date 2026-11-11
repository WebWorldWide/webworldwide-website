// Comment-account page (comments domain, /account/). No dependencies.
/* global document, window, fetch, setTimeout, location, HTMLFormElement */
(() => {
  const $ = (id) => document.getElementById(id);
  const siteOrigin = document.body.dataset.siteOrigin || '';
  const msg = $('msg');

  /**
   * Show a status line under the form.
   * @param {string} text Message to show.
   * @param {string} [kind] '' | 'ok' | 'error'.
   */
  const say = (text, kind = '') => {
    msg.textContent = text;
    msg.className = `msg ${kind}`;
  };

  /**
   * Call an /account/ endpoint; throws with the server's message on failure.
   * @param {string} path Endpoint under /account/.
   * @param {object} [body] JSON body (POST); omitted for GET.
   * @returns {Promise<Record<string, string>>} The JSON response.
   */
  async function call(path, body) {
    const res = await fetch(`/account/${path}`, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || 'Something went wrong. Please try again.');
    return data;
  }

  // Tell the post page we signed in/out so it reloads the comments widget.
  /**
   * Tell the post that opened this window about a sign-in or sign-out.
   * @param {'signed-in' | 'signed-out'} state What happened.
   * @param {string} [username] Who signed in.
   */
  function notify(state, username) {
    if (window.opener && siteOrigin) {
      try {
        window.opener.postMessage({ type: 'www-comments-auth', state, username }, siteOrigin);
      } catch {
        /* opener gone */
      }
    }
  }

  /**
   * Switch between the signed-in and signed-out panels.
   * @param {string | null} username Signed-in name, or null.
   */
  function show(username) {
    $('signed-in').hidden = !username;
    $('signed-out').hidden = !!username;
    if (username) {
      $('me-name').textContent = username;
      $('back-hint').textContent = window.opener
        ? 'This window will close; your comments now show your name with a ✓.'
        : 'Go back to the post: your comments now show your name with a ✓.';
    }
  }

  /**
   * Show the sign-in or create-account form.
   * @param {'login' | 'register'} which Form to show.
   */
  function tab(which) {
    const login = which === 'login';
    $('tab-login').setAttribute('aria-selected', String(login));
    $('tab-register').setAttribute('aria-selected', String(!login));
    $('form-login').hidden = !login;
    $('form-register').hidden = login;
    say('');
    (login ? $('login-user') : $('reg-user')).focus();
  }
  $('tab-login').addEventListener('click', () => tab('login'));
  $('tab-register').addEventListener('click', () => tab('register'));

  /**
   * Submit a form to `path`, disabling its button while in flight.
   * @param {HTMLFormElement} form The form being submitted.
   * @param {string} path Endpoint under /account/.
   * @param {() => object} body Builds the JSON body.
   * @param {(data: Record<string, string>) => void} done Called with the response on success.
   */
  async function submit(form, path, body, done) {
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    say('');
    try {
      const data = await call(path, body());
      done(data);
    } catch (err) {
      say(err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  }

  const signedIn = (data) => {
    show(data.username);
    say(`Welcome, ${data.username}!`, 'ok');
    notify('signed-in', data.username);
    if (window.opener) setTimeout(() => window.close(), 1200);
  };

  $('form-login').addEventListener('submit', (e) => {
    e.preventDefault();
    submit(
      e.target,
      'login',
      () => ({ username: $('login-user').value, password: $('login-pass').value }),
      signedIn,
    );
  });
  $('form-register').addEventListener('submit', (e) => {
    e.preventDefault();
    submit(
      e.target,
      'register',
      () => ({ username: $('reg-user').value, password: $('reg-pass').value }),
      signedIn,
    );
  });
  $('form-password').addEventListener('submit', (e) => {
    e.preventDefault();
    submit(
      e.target,
      'password',
      () => ({ current: $('pw-current').value, next: $('pw-next').value }),
      () => {
        e.target.reset();
        say('Password changed.', 'ok');
      },
    );
  });
  $('btn-logout').addEventListener('click', async () => {
    await call('logout', {}).catch(() => {});
    show(null);
    say('Signed out.', 'ok');
    notify('signed-out');
  });

  call('me')
    .then((d) => show(d.username))
    .catch(() => {
      show(null);
      if (location.hash === '#register') tab('register');
    });
})();
