/**
 * Home page client behaviors:
 *   - mouseParallax — translate the wordmark stage with cursor position
 *   - sectionTitleCascade — wrap each char in a span for per-letter reveal
 *   - scrollReveal — IntersectionObserver toggles `.in` on `.reveal` elements
 *   - smoothAnchor — replaces default <a href="#x"> jump with smooth scroll
 *   - filmClouds — pixel-art clouds drifting inside the YouTube film frame
 *
 * All respect `prefers-reduced-motion`.
 */

const reducedMotion = (): boolean =>
  typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export function mouseParallax(stageId = 'wordmarkStage'): void {
  const stage = document.getElementById(stageId);
  if (!stage || reducedMotion()) return;
  let mx = 0,
    my = 0,
    tx = 0,
    ty = 0;
  window.addEventListener(
    'mousemove',
    (e) => {
      mx = (e.clientX / window.innerWidth - 0.5) * 2;
      my = (e.clientY / window.innerHeight - 0.5) * 2;
    },
    { passive: true },
  );
  (function tick() {
    tx += (mx - tx) * 0.06;
    ty += (my - ty) * 0.06;
    stage.style.transform = `translate(${(tx * 10).toFixed(1)}px, ${(ty * 5).toFixed(1)}px)`;
    requestAnimationFrame(tick);
  })();
}

export function sectionTitleCascade(): void {
  document.querySelectorAll<HTMLElement>('.section-title').forEach((t) => {
    const walk = (node: Node): DocumentFragment => {
      const out = document.createDocumentFragment();
      node.childNodes.forEach((child) => {
        if (child.nodeType === 3) {
          [...(child.textContent ?? '')].forEach((c) => {
            const span = document.createElement('span');
            span.className = 'ch';
            span.textContent = c === ' ' ? ' ' : c;
            out.appendChild(span);
          });
        } else if (child.nodeType === 1) {
          const elClone = (child as Element).cloneNode(false) as Element;
          elClone.appendChild(walk(child));
          out.appendChild(elClone);
        }
      });
      return out;
    };
    const frag = walk(t);
    t.innerHTML = '';
    t.appendChild(frag);
    t.querySelectorAll<HTMLElement>('.ch').forEach((s, i) => {
      s.style.transitionDelay = `${i * 0.035}s`;
    });
  });
}

export function scrollReveal(): void {
  const els = document.querySelectorAll<HTMLElement>('.reveal');
  if (!('IntersectionObserver' in window)) {
    els.forEach((el) => el.classList.add('in'));
    return;
  }
  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach((en) => {
        if (en.isIntersecting) {
          en.target.classList.add('in');
          io.unobserve(en.target);
        }
      });
    },
    { threshold: 0.15, rootMargin: '0px 0px -10% 0px' },
  );
  els.forEach((el) => io.observe(el));
}

export function smoothAnchor(): void {
  document.querySelectorAll<HTMLAnchorElement>('a[href^="#"]').forEach((a) => {
    a.addEventListener('click', (e) => {
      const id = a.getAttribute('href') ?? '';
      if (id.length > 1) {
        const t = document.querySelector(id);
        if (t) {
          e.preventDefault();
          const y = (t as HTMLElement).getBoundingClientRect().top + window.scrollY - 12;
          window.scrollTo({ top: y, behavior: reducedMotion() ? 'auto' : 'smooth' });
        }
      }
    });
  });
}

export function filmClouds(): void {
  const wrap = document.getElementById('film-clouds');
  if (!wrap) return;
  const shape = [
    '00022200002200',
    '00211122022112',
    '02111111111112',
    '02111111111112',
    '02222222222220',
  ];
  const svg = (scale: number): string => {
    const h = shape.length;
    const w = shape[0].length;
    let body = '';
    let outline = '';
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const ch = shape[y][x];
        if (ch === '1') body += `<rect x='${x}' y='${y}' width='1' height='1'/>`;
        else if (ch === '2') outline += `<rect x='${x}' y='${y}' width='1' height='1'/>`;
      }
    }
    return `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='${w * scale}' height='${h * scale}' viewBox='0 0 ${w} ${h}' shape-rendering='crispEdges'><g fill='%23ffffff'>${body}</g><g fill='%23a8c8f0'>${outline}</g></svg>")`;
  };
  for (let i = 0; i < 5; i++) {
    const c = document.createElement('div');
    c.className = 'film-cloud';
    const scale = 4 + Math.floor(Math.random() * 4);
    c.style.width = `${shape[0].length * scale}px`;
    c.style.height = `${shape.length * scale}px`;
    c.style.backgroundImage = svg(scale);
    c.style.top = `${12 + Math.random() * 60}%`;
    c.style.opacity = '0.85';
    const dur = 80 + Math.random() * 70;
    c.style.animationDuration = `${dur}s`;
    c.style.animationDelay = `${-Math.random() * dur}s`;
    wrap.appendChild(c);
  }
}

export function initHome(): void {
  scrollReveal();
  sectionTitleCascade();
  smoothAnchor();
  filmClouds();
  mouseParallax();
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initHome);
  } else {
    initHome();
  }
}
