// @ts-check
/**
 * terminal.js — web terminal pane (System view).
 *
 * Backend: POST /api/health/terminal runs the command via execAsync
 * server-side (60s timeout, 8MB buffer). It is NOT allowlisted — it's a
 * full shell, gated only by the admin session auth on /api. Lives inside
 * #view-system's Terminal tab; the old modal wiring is kept optional for
 * backward compatibility.
 *
 * Client niceties: ↑/↓ history recall, `clear`/`cls` to wipe the pane, and
 * an in-flight lock so commands run one at a time (no interleaved output /
 * piled-up shells).
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

    const inputEl = /** @type {HTMLInputElement} */ (input);
    const basePlaceholder = inputEl.getAttribute('placeholder') || '';
    /** @type {string[]} */
    const history = [];
    let histIdx = -1; // -1 = not browsing history (editing a fresh line)
    let running = false;

    // ↑/↓ recall recent commands.
    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowUp') {
        if (!history.length) return;
        e.preventDefault();
        histIdx = histIdx < 0 ? history.length - 1 : Math.max(0, histIdx - 1);
        inputEl.value = history[histIdx];
      } else if (e.key === 'ArrowDown') {
        if (histIdx < 0) return;
        e.preventDefault();
        histIdx += 1;
        if (histIdx >= history.length) {
          histIdx = -1;
          inputEl.value = '';
        } else {
          inputEl.value = history[histIdx];
        }
      }
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (running) return; // one command at a time
      const cmd = inputEl.value.trim();
      if (!cmd) return;
      history.push(cmd);
      histIdx = -1;
      // `clear`/`cls` is a local convenience — wipe the pane, no round-trip.
      if (cmd === 'clear' || cmd === 'cls') {
        output.textContent = '';
        inputEl.value = '';
        return;
      }
      append(`\n> ${cmd}\n`);
      inputEl.value = '';
      running = true;
      inputEl.disabled = true;
      inputEl.setAttribute('placeholder', 'running…');

      try {
        const data = await TE.fetchJSON('/api/health/terminal', {
          method: 'POST',
          body: JSON.stringify({ command: cmd }),
        });
        append(data && data.output ? data.output + '\n' : '(no output)\n');
      } catch (err) {
        append(`[NETWORK ERROR] ${err.message || err}\n`);
      } finally {
        running = false;
        inputEl.disabled = false;
        inputEl.setAttribute('placeholder', basePlaceholder);
        try {
          inputEl.focus();
        } catch (_) {
          /* focus may fail in some sandboxes */
        }
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
