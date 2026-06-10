// @ts-check
/**
 * terminal.js — web terminal pane (System view).
 *
 * Backend: POST /api/health/terminal — allowlisted shell commands only
 * (uptime, df, free, ps, docker, etc.). Wraps execAsync server-side
 * w/ 15s timeout. Lives inside #view-system's Terminal tab; the old
 * modal wiring is kept optional for backward compatibility.
 */
(function () {
  function boot() {
    const openBtn = document.getElementById('btn-open-terminal');
    const closeBtn = document.getElementById('btn-close-terminal');
    const form = document.getElementById('terminal-form');
    const input = document.getElementById('terminal-input');
    const output = document.getElementById('terminal-output');
    if (!form || !input || !output) return;

    // Legacy modal affordances — the terminal now lives in the System
    // view, but a cached page may still render the old modal shell.
    if (openBtn) {
      openBtn.addEventListener('click', () => {
        if (document.getElementById('terminal-modal')) TE.openModal('terminal-modal');
        try {
          input.focus();
        } catch (_) {
          /* focus may fail in some sandboxes */
        }
      });
    }
    if (closeBtn) {
      closeBtn.addEventListener('click', () => TE.closeModal('terminal-modal'));
    }

    function append(text) {
      output.textContent += text;
      output.scrollTop = output.scrollHeight;
    }

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const cmd = input.value.trim();
      if (!cmd) return;
      append(`\n> ${cmd}\n`);
      input.value = '';

      try {
        const data = await TE.fetchJSON('/api/health/terminal', {
          method: 'POST',
          body: JSON.stringify({ command: cmd }),
        });
        append(data && data.output ? data.output + '\n' : '(no output)\n');
      } catch (err) {
        append(`[NETWORK ERROR] ${err.message || err}\n`);
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
