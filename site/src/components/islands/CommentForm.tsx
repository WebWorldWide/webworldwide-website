/**
 * Comments — mounts the self-hosted Remark42 widget.
 *
 * Remark42 owns the thread, composer, and persistence. Anonymous posting is
 * enabled on the server (AUTH_ANON=true), so visitors can comment without an
 * account; signing in (GitHub, etc.) is optional. We just load the embed
 * script and let it populate the #remark42 container.
 */
import { useEffect, useRef } from 'react';

interface Props {
  /** Stable thread identifier — the post slug. Used to build the canonical url. */
  threadId: string;
  /** Remark42 base URL. If empty, nothing mounts. */
  remarkUrl: string;
  /** Remark42 site ID. */
  remarkSiteId: string;
}

export default function CommentForm({ threadId, remarkUrl, remarkSiteId }: Props): JSX.Element {
  const mounted = useRef(false);

  useEffect(() => {
    if (!remarkUrl || mounted.current) return;
    mounted.current = true;

    (window as unknown as { remark_config: unknown }).remark_config = {
      host: remarkUrl,
      site_id: remarkSiteId,
      url: `${location.origin}/blog/${threadId}/`,
      components: ['embed'],
      theme: 'light',
      max_shown_comments: 50,
    };

    const s = document.createElement('script');
    s.src = `${remarkUrl}/web/embed.js`;
    s.async = true;
    s.defer = true;
    document.head.appendChild(s);
  }, [remarkUrl, remarkSiteId, threadId]);

  if (!remarkUrl) {
    return <p className="comments-empty">Comments are temporarily unavailable.</p>;
  }

  // Remark42's embed script mounts into the element with id "remark42".
  return <div id="remark42" className="remark42-wrap" />;
}
