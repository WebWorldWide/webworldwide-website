/* Web World Wide admin — a11y enhancement shim.
 *
 * Auto-labels color-only status indicators (`.pip`, `.ddot`, `.log-dot`)
 * so screen readers announce their state. Per WCAG 1.4.1 (Use of Color),
 * status MUST be conveyed by something other than color alone. The
 * markup is templated/JS-rendered across many files; centralising the
 * fix here is cleaner than touching every template.
 *
 * Strategy:
 *   - DOMContentLoaded: scan the document, label anything missing one.
 *   - MutationObserver: same treatment for nodes added later by
 *     dashboard.js / posts-bulk.js / activity rendering.
 *
 * Label rules (class → aria-label):
 *   .ok | (no state)  → "OK"
 *   .warn             → "Warning"
 *   .bad | .danger    → "Error"
 *   For pips inside an element with `data-pip-label`, use that instead.
 */
(function () {
  'use strict';

  var PIP_SELECTOR = '.pip, .ddot, .log-dot';

  function labelFor(el) {
    var explicit = el.getAttribute('data-pip-label');
    if (explicit) return explicit;
    if (el.classList.contains('warn')) return 'Warning';
    if (el.classList.contains('bad') || el.classList.contains('danger')) return 'Error';
    if (el.classList.contains('ok')) return 'OK';
    return 'Status indicator';
  }

  function annotate(el) {
    if (!el || el.nodeType !== 1) return;
    if (el.hasAttribute('aria-label') || el.hasAttribute('aria-hidden')) return;
    // If the pip is decorative (sits next to its own text label), the
    // template can set aria-hidden=true explicitly. We never overwrite.
    el.setAttribute('role', 'status');
    el.setAttribute('aria-label', labelFor(el));
  }

  function scan(root) {
    var nodes = (root || document).querySelectorAll(PIP_SELECTOR);
    for (var i = 0; i < nodes.length; i++) annotate(nodes[i]);
  }

  function start() {
    scan(document);
    if (typeof MutationObserver === 'undefined') return;
    var mo = new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) {
        var added = records[i].addedNodes;
        for (var j = 0; j < added.length; j++) {
          var n = added[j];
          if (n.nodeType !== 1) continue;
          if (n.matches && n.matches(PIP_SELECTOR)) annotate(n);
          if (n.querySelectorAll) scan(n);
        }
      }
    });
    mo.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
