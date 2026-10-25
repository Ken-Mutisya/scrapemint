// Threads (threads.com) page parser for logged-out profile and post pages.
//
// The server-rendered page embeds its data as JSON in
// <script type="application/json"> blocks. Posts sit in arrays named
// "thread_items" ([{post: {...}}]); the profile owner is an object with
// follower_count and biography. Rather than chase a fixed path (Meta moves
// it), every JSON block is walked. On a profile, the latest posts are
// present (about 10-20); on a post URL, the post and the first replies.
// Verified 2026-10-25 on threads.com/@zuck.

const decodeHtml = (s) => s.replace(/&quot;/g, '"').replace(/&amp;/g, '&');

function blocks(html) {
    const out = [];
    for (const m of html.matchAll(/<script type="application\/json"[^>]*>([\s\S]*?)<\/script>/g)) {
        const body = m[1];
        if (!/thread_items|follower_count/.test(body)) continue;
        try { out.push(JSON.parse(body)); } catch { try { out.push(JSON.parse(decodeHtml(body))); } catch { /* skip */ } }
    }
    return out;
}

function walk(node, visit, depth = 0) {
    if (!node || typeof node !== 'object' || depth > 60) return;
    visit(node);
    if (Array.isArray(node)) { for (const x of node) walk(x, visit, depth + 1); return; }
    for (const k of Object.keys(node)) walk(node[k], visit, depth + 1);
}

function media(p) {
    const img = (x) => x?.image_versions2?.candidates?.[0]?.url || null;
    const vid = (x) => x?.video_versions?.[0]?.url || null;
    if (Array.isArray(p.carousel_media) && p.carousel_media.length) {
        return p.carousel_media.map((m) => ({ type: vid(m) ? 'video' : 'image', url: vid(m) || img(m) }));
    }
    if (vid(p)) return [{ type: 'video', url: vid(p), thumbnail: img(p) }];
    if (img(p) && p.media_type !== 19) return [{ type: 'image', url: img(p) }];
    return [];
}

function toPost(p, kind) {
    const info = p.text_post_app_info || {};
    const user = p.user || {};
    const quoted = info.share_info?.quoted_post;
    const reposted = info.share_info?.reposted_post;
    const link = info.link_preview_attachment;
    return {
        postId: p.pk || null,
        code: p.code || null,
        url: user.username && p.code ? `https://www.threads.com/@${user.username}/post/${p.code}` : null,
        kind,
        author: user.username || null,
        authorVerified: user.is_verified ?? null,
        text: p.caption?.text ?? null,
        createdAt: p.taken_at ? new Date(p.taken_at * 1000).toISOString() : null,
        likes: p.like_count ?? null,
        replies: info.direct_reply_count ?? null,
        reposts: info.repost_count ?? null,
        quotes: info.quote_count ?? null,
        shares: info.reshare_count ?? null,
        isReply: info.is_reply ?? false,
        replyTo: info.reply_to_author?.username || null,
        quotedPost: quoted ? { author: quoted.user?.username || null, code: quoted.code || null, text: quoted.caption?.text ?? null } : null,
        repostedPost: reposted ? { author: reposted.user?.username || null, code: reposted.code || null, text: reposted.caption?.text ?? null } : null,
        media: media(p),
        link: link ? { url: link.url || null, title: link.title || null, domain: link.display_url || null } : null,
        language: p.original_lang_for_translations || null,
        pinned: info.pinned_post_info?.is_pinned_to_profile ?? false,
    };
}

export function parseThreadsPage(html, { pageType, username, code } = {}) {
    const posts = new Map();
    let profile = null;
    for (const b of blocks(html)) {
        walk(b, (n) => {
            if (Array.isArray(n.thread_items)) {
                for (const it of n.thread_items) {
                    const p = it?.post;
                    if (!p?.pk || posts.has(p.pk)) continue;
                    let kind = 'post';
                    if (pageType === 'post') kind = p.code === code ? 'post' : 'reply';
                    posts.set(p.pk, toPost(p, kind));
                }
            }
            if (!profile && n.follower_count != null && n.username && (!username || n.username.toLowerCase() === username.toLowerCase())) {
                profile = {
                    username: n.username,
                    fullName: n.full_name || null,
                    userId: n.pk || n.id || null,
                    verified: n.is_verified ?? null,
                    followers: n.follower_count,
                    biography: n.biography || null,
                    bioLinks: (n.bio_links || []).map((l) => l.url).filter(Boolean),
                    profilePic: n.hd_profile_pic_versions?.slice(-1)[0]?.url || n.profile_pic_url || null,
                };
            }
        });
    }
    let list = [...posts.values()];
    if (pageType === 'profile' && username) list = list.filter((p) => !p.author || p.author.toLowerCase() === username.toLowerCase() || p.repostedPost);
    list.sort((a, b) => (a.kind === b.kind ? (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0) : a.kind === 'post' ? -1 : 1));
    return { profile, posts: list };
}

export function isThreadsBlock(r) {
    if (r.statusCode === 429 || r.statusCode >= 500 || r.statusCode === 403) return true;
    return r.statusCode === 200 && r.body.length < 20_000 && /login|checkpoint/i.test(r.url || '');
}
