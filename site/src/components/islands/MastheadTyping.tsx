/**
 * MastheadTyping — types out "The Blog." letter by letter into a
 * blinking cursor. The "The " prefix lands normally; "Blog." comes in
 * italic + cherry to match the design's mast-title em treatment.
 *
 * A11y: the visible animation is decorative; the <h1> in the parent has
 * an aria-label with the final text so screen readers get it immediately.
 */
import { useEffect, useState } from 'react';

const HEAD = 'The ';
const TAIL = 'Blog.';
const FULL = HEAD + TAIL;

export default function MastheadTyping(): JSX.Element {
  const [typed, setTyped] = useState(0);

  useEffect(() => {
    const mq = matchMedia('(prefers-reduced-motion: reduce)');
    if (mq.matches) {
      setTyped(FULL.length);
      return;
    }
    let i = 0;
    let timer: ReturnType<typeof setTimeout>;
    let cancelled = false;
    const tick = () => {
      if (cancelled) return;
      i = Math.min(i + 1, FULL.length);
      setTyped(i);
      if (i < FULL.length) {
        timer = setTimeout(tick, 70 + Math.random() * 70);
      }
    };
    timer = setTimeout(tick, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);

  const headShown = FULL.slice(0, typed).slice(0, HEAD.length);
  const tailShown = FULL.slice(0, typed).slice(HEAD.length);

  return (
    <>
      <span>{headShown}</span>
      <em>{tailShown}</em>
      <span className="type-cursor" aria-hidden="true" />
    </>
  );
}
