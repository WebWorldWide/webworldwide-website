// @ts-check
/**
 * terminal.js — web terminal modal on the dashboard.
 *
 * Backend: POST /api/health/terminal — allowlisted shell commands only
 * (uptime, df, free, ps, docker, etc.). Wraps execAsync server-side
 * w/ 15s timeout. Untouched in Phase 2.
 */
(function () {
  function boot() {
    const openBtn = document.getElementById('btn-open-terminal');
    const closeBtn = document.getElementById('btn-close-terminal');
    const modal = document.getElementById('terminal-modal');
    const form = document.getElementById('terminal-form');
    const input = document.getElementById('terminal-input');
    const output = document.getElementById('terminal-output');
    if (!modal || !form || !input || !output) return;

    if (openBtn) {
      openBtn.addEventListener('click', () => {
        TE.openModal('terminal-modal');
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
