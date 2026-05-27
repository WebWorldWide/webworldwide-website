/**
 * CommentForm — submission UI for "The Mailbag" comments section.
 *
 * Behavior:
 *   - Renders a name + body textarea + submit (always available).
 *   - When the Remark42 SCRIPT is configured (siteConfig.comments.url
 *     non-empty), mounts the Remark42 widget BELOW the form. We let it
 *     own the actual threading + persistence.
 *   - The form itself is for fast optimistic posting: it appends a local
 *     comment to a "you said" preview list while Remark42 finishes
 *     loading. This is purely UX — Remark42 is the source of truth.
 *
 * Accessibility:
 *   - <label> on every field
 *   - aria-disabled on submit until both fields non-empty
 *   - aria-live="polite" on the optimistic preview list
 */
import { useEffect, useRef, useState } from 'react';

interface Props {
  /** Stable identifier for the comment thread — usually the post slug. */
  threadId: string;
  /** Remark42 base URL. If empty, the widget is skipped. */
  remarkUrl: string;
  /** Remark42 site ID. */
  remarkSiteId: string;
}

interface LocalComment {
  id: number;
  author: string;
  initial: string;
  time: string;
  text: string;
}

export default function CommentForm({ threadId, remarkUrl, remarkSiteId }: Props): JSX.Element {
  const [name, setName] = useState('');
  const [text, setText] = useState('');
  const [previews, setPreviews] = useState<LocalComment[]>([]);
  const widgetMounted = useRef(false);

  const canSubmit = name.trim().length > 0 && text.trim().length > 0;

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    const c: LocalComment = {
      id: Date.now(),
      author: name.trim(),
      initial: name.trim()[0]?.toLowerCase() ?? '?',
      time: 'just now',
      text: text.trim()
    };
    setPreviews((cs) => [...cs, c]);
    setName('');
    setText('');
    // If Remark42 is configured, posting really happens in its iframe;
    // we surface a hint that the comment is being submitted to the queue.
  }

  // Mount Remark42 widget lazily, once.
  useEffect(() => {
    if (!remarkUrl || widgetMounted.current) return;
    widgetMounted.current = true;

    // Expose config Remark42 expects.
    (window as unknown as { remark_config: unknown }).remark_config = {
      host: remarkUrl,
      site_id: remarkSiteId,
      url: window.location.href,
      components: ['embed'],
      theme: 'light',
      max_shown_comments: 50
    };

    const s = document.createElement('script');
    s.src = `${remarkUrl}/web/embed.js`;
    s.async = true;
    s.defer = true;
    document.head.appendChild(s);
  }, [remarkUrl, remarkSiteId]);

  return (
    <>
      <form className="comment-form" onSubmit={onSubmit} aria-label="Write a reply">
        <div className="comment-form-row">
          <label className="sr-only" htmlFor="comment-name">Your handle</label>
          <input
            id="comment-name"
            type="text"
            placeholder="signed: your handle"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="name"
            maxLength={60}
          />
        </div>
        <div className="comment-form-row">
          <label className="sr-only" htmlFor="comment-text">Your reply</label>
          <textarea
            id="comment-text"
            placeholder="Write a reply — keep it kind, keep it interesting."
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={4000}
          />
        </div>
        <div className="comment-form-foot">
          <span>// signed letters preferred · markdown allowed</span>
          <button
            className="comment-submit"
            type="submit"
            disabled={!canSubmit}
            aria-disabled={!canSubmit}
          >
            Post reply →
          </button>
        </div>
      </form>

      {previews.length > 0 && (
        <ul className="comment-previews" aria-live="polite" aria-label="Your draft replies">
          {previews.map((c) => (
            <li key={c.id} className="comment">
              <div className="comment-avatar is-me" aria-hidden="true">{c.initial}</div>
              <div>
                <div className="comment-meta">
                  <span className="comment-author">{c.author}</span>
                  <span className="comment-tag">you</span>
                  <span className="comment-time">{c.time}</span>
                </div>
                <p className="comment-text">{c.text}</p>
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* Remark42 mounts inside this div. If remarkUrl is empty, the
          widget never loads and the preview list is the whole thread. */}
      <div id={`remark42-${threadId}`} className="remark42-wrap"></div>
    </>
  );
}
