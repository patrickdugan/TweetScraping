export function handle(value) {
  const result = String(value ?? '').replace(/^@/, '').toLowerCase();
  if (!/^[a-z0-9_]{1,15}$/.test(result)) throw new Error('Expected an X handle (1–15 letters, digits or underscores).');
  return result;
}

export function tweetUrl(value) {
  try {
    const url = new URL(value);
    if (!['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(url.hostname)) return null;
    const match = url.pathname.match(/^\/([a-z0-9_]{1,15})\/status\/(\d+)(?:\/|$)/i);
    return match ? { id: match[2], author: handle(match[1]), url: `https://x.com/${handle(match[1])}/status/${match[2]}` } : null;
  } catch { return null; }
}

export function isoDate(value) {
  if (!value) return null;
  const date = new Date(typeof value === 'number' ? value * 1000 : value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function fromFx(status) {
  if (status?.type === 'tombstone') return null;
  const author = status?.author?.screen_name;
  const id = String(status?.id ?? '');
  if (!author || !/^\d+$/.test(id)) return null;
  // Fx v2 text is the expanded note text. raw_text can include hidden media URLs.
  const text = status.text;
  if (typeof text !== 'string' || (!text.trim() && !status.media)) return null;
  return {
    id, author: handle(author), author_id: status.author.id ?? null,
    url: `https://x.com/${handle(author)}/status/${id}`, text,
    created_at: isoDate(status.created_at ?? status.created_timestamp),
    lang: status.lang ?? null, conversation_id: status.conversation_id ?? null,
    reply_to: status.replying_to ?? null, quote_id: status.quote?.id ?? null,
    reposted_by: status.reposted_by?.screen_name?.toLowerCase() ?? null,
    metrics: { likes: status.likes, reposts: status.reposts ?? status.retweets,
      replies: status.replies, quotes: status.quotes, views: status.views },
    media: status.media ?? null, source: 'fxtwitter_v2', text_status: 'provider_text',
  };
}

export function fxRows(payload) {
  const rows = [];
  for (const entry of payload.results ?? [payload.status ?? payload.tweet]) {
    if (entry?.type === 'thread') {
      for (const item of entry.statuses ?? entry.posts ?? []) {
        const row = fromFx(item); if (row) rows.push(row);
      }
    } else { const row = fromFx(entry); if (row) rows.push(row); }
  }
  return rows;
}

// Parse only tweet objects, never treating quoted text as the outer author's text.
export function graphqlRows(payload) {
  const rows = [];
  const seen = new Set();
  function walk(value) {
    if (!value || typeof value !== 'object') return;
    const legacy = value.legacy;
    const user = value.core?.user_results?.result;
    const author = user?.core?.screen_name ?? user?.legacy?.screen_name;
    if (value.rest_id && legacy?.full_text != null && author && !legacy.retweeted_status_result) {
      const id = String(value.rest_id);
      if (!seen.has(id)) {
        seen.add(id);
        const note = value.note_tweet?.note_tweet_results?.result?.text;
        rows.push({ id, author: handle(author), author_id: user.rest_id ?? null,
          url: `https://x.com/${handle(author)}/status/${id}`,
          text: note ?? legacy.full_text, created_at: isoDate(legacy.created_at),
          lang: legacy.lang ?? null, conversation_id: legacy.conversation_id_str ?? null,
          reply_to: legacy.in_reply_to_status_id_str ?? null,
          quote_id: legacy.quoted_status_id_str ?? null, reposted_by: null,
          metrics: { likes: legacy.favorite_count, reposts: legacy.retweet_count,
            replies: legacy.reply_count, quotes: legacy.quote_count, views: value.views?.count },
          media: legacy.extended_entities?.media ?? null,
          source: 'x_browser_response', text_status: note ? 'note_text' : 'response_text' });
      }
    }
    for (const [key, item] of Object.entries(value)) {
      if (!['quoted_status_result', 'retweeted_status_result', 'quoted_status', 'retweeted_status'].includes(key)) walk(item);
    }
  }
  walk(payload);
  return rows;
}

export function accepts(row, options) {
  if (!row || row.author !== options.handle) return false;
  if (!options.includeReplies && row.reply_to) return false;
  if (options.since && (!row.created_at || row.created_at < `${options.since}T00:00:00.000Z`)) return false;
  if (options.until && (!row.created_at || row.created_at >= `${options.until}T00:00:00.000Z`)) return false;
  return true;
}

export function searchWindows(options) {
  if (!options.since && !options.until) return [`from:${options.handle}${options.includeReplies ? '' : ' -filter:replies'}`];
  if (!options.since || !options.until) return [`from:${options.handle}${options.since ? ` since:${options.since}` : ''}${options.until ? ` until:${options.until}` : ''}${options.includeReplies ? '' : ' -filter:replies'}`];
  const out = [];
  let start = new Date(`${options.since}T00:00:00Z`);
  const end = new Date(`${options.until}T00:00:00Z`);
  while (start < end) {
    const next = new Date(Math.min(start.getTime() + options.windowDays * 86400000, end.getTime()));
    out.push(`from:${options.handle} since:${start.toISOString().slice(0, 10)} until:${next.toISOString().slice(0, 10)}${options.includeReplies ? '' : ' -filter:replies'}`);
    start = next;
  }
  return out;
}
