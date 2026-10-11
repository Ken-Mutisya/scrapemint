// Sites the checker knows. Each check answers "taken" (an account with this
// username exists), "available" (none) or "unknown" (blocked, rate-limited,
// or an answer that matched neither rule). `known` is an account that exists,
// used by the self-test that decides which sites ship.
//
// check kinds:
//   status  taken on 200, available on 404 (or the codes given)
//   json    `taken(data)` on the parsed body; available on 404 or when
//           `taken` returns false
//   body    taken when the body contains `taken`, available when it
//           contains `available` (strings or regexes)

const enc = encodeURIComponent;

export const SITES = [
    // Code and developer
    { name: 'GitHub', category: 'developer', url: (u) => `https://github.com/${u}`, check: { kind: 'status', url: (u) => `https://github.com/${enc(u)}` }, known: 'torvalds' },
    { name: 'GitLab', category: 'developer', url: (u) => `https://gitlab.com/${u}`, check: { kind: 'json', url: (u) => `https://gitlab.com/api/v4/users?username=${enc(u)}`, taken: (d) => Array.isArray(d) && d.length > 0 }, known: 'gitlab-bot' },
    { name: 'Bitbucket', category: 'developer', url: (u) => `https://bitbucket.org/${u}/`, check: { kind: 'status', url: (u) => `https://api.bitbucket.org/2.0/workspaces/${enc(u)}` }, known: 'atlassian' },
    { name: 'Docker Hub', category: 'developer', url: (u) => `https://hub.docker.com/u/${u}`, check: { kind: 'status', url: (u) => `https://hub.docker.com/v2/users/${enc(u)}/` }, known: 'bitnami' },
    { name: 'dev.to', category: 'developer', url: (u) => `https://dev.to/${u}`, check: { kind: 'status', url: (u) => `https://dev.to/api/users/by_username?url=${enc(u)}` }, known: 'ben' },
    { name: 'Hacker News', category: 'developer', url: (u) => `https://news.ycombinator.com/user?id=${u}`, check: { kind: 'json', url: (u) => `https://hacker-news.firebaseio.com/v0/user/${enc(u)}.json`, taken: (d) => Boolean(d && d.id) }, known: 'pg' },
    { name: 'Keybase', category: 'developer', url: (u) => `https://keybase.io/${u}`, check: { kind: 'json', url: (u) => `https://keybase.io/_/api/1.0/user/lookup.json?usernames=${enc(u)}`, taken: (d) => Boolean(d?.them?.[0]) }, known: 'max' },
    { name: 'Codewars', category: 'developer', url: (u) => `https://www.codewars.com/users/${u}`, check: { kind: 'status', url: (u) => `https://www.codewars.com/api/v1/users/${enc(u)}` }, known: 'jhoffner' },
    { name: 'Hugging Face', category: 'developer', url: (u) => `https://huggingface.co/${u}`, check: { kind: 'status', url: (u) => `https://huggingface.co/api/users/${enc(u)}/overview` }, known: 'julien-c' },
    { name: 'LeetCode', category: 'developer', url: (u) => `https://leetcode.com/u/${u}/`, check: { kind: 'json', method: 'POST', url: () => 'https://leetcode.com/graphql', body: (u) => JSON.stringify({ query: `query { matchedUser(username: ${JSON.stringify(u)}) { username } }` }), taken: (d) => Boolean(d?.data?.matchedUser) }, known: 'lee215' },

    // Social and community
    { name: 'Bluesky', category: 'social', url: (u) => `https://bsky.app/profile/${u}.bsky.social`, check: { kind: 'json', url: (u) => `https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=${enc(u)}.bsky.social`, taken: (d) => Boolean(d?.did), availableStatus: [400, 404] }, known: 'jay' },
    { name: 'Mastodon (mastodon.social)', category: 'social', url: (u) => `https://mastodon.social/@${u}`, check: { kind: 'status', url: (u) => `https://mastodon.social/api/v1/accounts/lookup?acct=${enc(u)}` }, known: 'Gargron' },
    { name: 'Telegram', category: 'social', url: (u) => `https://t.me/${u}`, check: { kind: 'body', url: (u) => `https://t.me/${enc(u)}`, taken: /tgme_page_title/, available: /tgme_page_icon|If you have <strong>Telegram<\/strong>, you can contact/ }, known: 'durov' },
    { name: 'Pinterest', category: 'social', url: (u) => `https://www.pinterest.com/${u}/`, check: { kind: 'body', url: (u) => `https://www.pinterest.com/${enc(u)}/`, taken: /- Profile \| Pinterest<\/title>/, available: /<title[^>]*>\s*<\/title>/ }, known: 'pinterest' },
    { name: 'Snapchat', category: 'social', url: (u) => `https://www.snapchat.com/add/${u}`, check: { kind: 'status', url: (u) => `https://www.snapchat.com/add/${enc(u)}` }, known: 'djkhaled305' },
    { name: 'TikTok', category: 'social', url: (u) => `https://www.tiktok.com/@${u}`, check: { kind: 'body', url: (u) => `https://www.tiktok.com/@${enc(u)}`, taken: /"uniqueId":"[^"]+"/, available: /"statusCode":10221|"statusCode":10202/ }, known: 'khaby.lame' },
    { name: 'VK', category: 'social', url: (u) => `https://vk.com/${u}`, check: { kind: 'status', url: (u) => `https://vk.com/${enc(u)}` }, known: 'durov' },
    { name: 'Tumblr', category: 'social', url: (u) => `https://${u}.tumblr.com`, check: { kind: 'status', url: (u) => `https://${enc(u)}.tumblr.com` }, known: 'staff' },
    { name: 'Gravatar', category: 'social', url: (u) => `https://gravatar.com/${u}`, check: { kind: 'status', url: (u) => `https://en.gravatar.com/${enc(u)}.json` }, known: 'beau' },
    { name: 'Wikipedia', category: 'social', url: (u) => `https://en.wikipedia.org/wiki/User:${u}`, check: { kind: 'json', url: (u) => `https://en.wikipedia.org/w/api.php?action=query&list=users&ususers=${enc(u)}&format=json`, taken: (d) => Boolean(d?.query?.users?.[0] && !('missing' in d.query.users[0]) && !('invalid' in d.query.users[0])) }, known: 'Jimbo_Wales' },

    // Video, streaming, music
    { name: 'Twitch', category: 'video', url: (u) => `https://www.twitch.tv/${u}`, check: { kind: 'json', method: 'POST', url: () => 'https://gql.twitch.tv/gql', headers: { 'Client-Id': 'kimne78kx3ncx6brgo4mv6wki5h1ko' }, body: (u) => JSON.stringify({ query: `query { user(login: ${JSON.stringify(u.toLowerCase())}) { id } }` }), taken: (d) => Boolean(d?.data?.user?.id) }, known: 'shroud' },
    { name: 'Dailymotion', category: 'video', url: (u) => `https://www.dailymotion.com/${u}`, check: { kind: 'status', url: (u) => `https://api.dailymotion.com/user/${enc(u)}` }, known: 'dailymotion' },
    { name: 'SoundCloud', category: 'music', url: (u) => `https://soundcloud.com/${u}`, check: { kind: 'status', url: (u) => `https://soundcloud.com/${enc(u)}` }, known: 'skrillex' },
    { name: 'Bandcamp', category: 'music', url: (u) => `https://${u}.bandcamp.com`, check: { kind: 'status', url: (u) => `https://${enc(u)}.bandcamp.com`, redirectAvailable: /bandcamp\.com\/signup/ }, known: 'radiohead' },
    { name: 'Mixcloud', category: 'music', url: (u) => `https://www.mixcloud.com/${u}/`, check: { kind: 'status', url: (u) => `https://api.mixcloud.com/${enc(u)}/` }, known: 'spartacus' },

    // Gaming
    { name: 'Steam', category: 'gaming', url: (u) => `https://steamcommunity.com/id/${u}`, check: { kind: 'body', url: (u) => `https://steamcommunity.com/id/${enc(u)}`, taken: /class="actual_persona_name"/, available: /The specified profile could not be found/ }, known: 'gabelogannewell' },
    { name: 'Chess.com', category: 'gaming', url: (u) => `https://www.chess.com/member/${u}`, check: { kind: 'status', url: (u) => `https://api.chess.com/pub/player/${enc(u.toLowerCase())}` }, known: 'hikaru' },
    { name: 'Lichess', category: 'gaming', url: (u) => `https://lichess.org/@/${u}`, check: { kind: 'status', url: (u) => `https://lichess.org/api/user/${enc(u)}` }, known: 'DrNykterstein' },
    { name: 'Roblox', category: 'gaming', url: () => null, check: { kind: 'json', method: 'POST', url: () => 'https://users.roblox.com/v1/usernames/users', body: (u) => JSON.stringify({ usernames: [u], excludeBannedUsers: false }), taken: (d) => Array.isArray(d?.data) && d.data.length > 0 }, known: 'builderman', profile: (d) => (d?.data?.[0]?.id ? `https://www.roblox.com/users/${d.data[0].id}/profile` : null) },
    { name: 'Minecraft', category: 'gaming', url: () => null, check: { kind: 'json', url: (u) => `https://api.mojang.com/users/profiles/minecraft/${enc(u)}`, taken: (d) => Boolean(d?.id), availableStatus: [204, 404] }, known: 'Notch' },
    { name: 'Speedrun.com', category: 'gaming', url: (u) => `https://www.speedrun.com/users/${u}`, check: { kind: 'json', url: (u) => `https://www.speedrun.com/api/v1/users?lookup=${enc(u)}`, taken: (d) => Array.isArray(d?.data) && d.data.length > 0 }, known: 'cheese05' },

    // Creative and writing
    { name: 'Medium', category: 'writing', url: (u) => `https://medium.com/@${u}`, check: { kind: 'json', method: 'POST', url: () => 'https://medium.com/_/graphql', body: (u) => JSON.stringify([{ query: `query { userResult(username: ${JSON.stringify(u)}) { __typename } }` }]), taken: (d) => d?.[0]?.data?.userResult?.__typename === 'User' }, known: 'karpathy' },
    { name: 'Substack', category: 'writing', url: (u) => `https://${u}.substack.com`, check: { kind: 'status', url: (u) => `https://${enc(u)}.substack.com` }, known: 'noahpinion' },
    { name: 'WordPress.com', category: 'writing', url: (u) => `https://${u}.wordpress.com`, check: { kind: 'status', url: (u) => `https://public-api.wordpress.com/rest/v1.1/sites/${enc(u)}.wordpress.com` }, known: 'wordpressdotcom' },
    { name: 'Dribbble', category: 'creative', url: (u) => `https://dribbble.com/${u}`, check: { kind: 'status', url: (u) => `https://dribbble.com/${enc(u)}` }, known: 'dribbble' },
    { name: 'Flickr', category: 'creative', url: (u) => `https://www.flickr.com/people/${u}`, check: { kind: 'status', url: (u) => `https://www.flickr.com/people/${enc(u)}` }, known: 'flickr' },
    { name: 'Duolingo', category: 'other', url: (u) => `https://www.duolingo.com/profile/${u}`, check: { kind: 'json', url: (u) => `https://www.duolingo.com/2017-06-30/users?username=${enc(u)}&fields=users%7Bid%7D`, taken: (d) => Array.isArray(d?.users) && d.users.length > 0 }, known: 'luis' },
    { name: 'Trello', category: 'other', url: (u) => `https://trello.com/u/${u}`, check: { kind: 'status', url: (u) => `https://trello.com/1/members/${enc(u)}` }, known: 'trello' },
    { name: 'Patreon', category: 'other', url: (u) => `https://www.patreon.com/${u}`, check: { kind: 'status', url: (u) => `https://www.patreon.com/${enc(u)}` }, known: 'patreon' },
    { name: 'Gumroad', category: 'other', url: (u) => `https://${u}.gumroad.com`, check: { kind: 'status', url: (u) => `https://${enc(u)}.gumroad.com` }, known: 'sahil' },
    { name: 'About.me', category: 'other', url: (u) => `https://about.me/${u}`, check: { kind: 'status', url: (u) => `https://about.me/${enc(u)}` }, known: 'tony' },
    { name: 'Lobsters', category: 'developer', url: (u) => `https://lobste.rs/~${u}`, check: { kind: 'status', url: (u) => `https://lobste.rs/~${enc(u)}` }, known: 'pushcx' },
    { name: 'Launchpad', category: 'developer', url: (u) => `https://launchpad.net/~${u}`, check: { kind: 'status', url: (u) => `https://launchpad.net/~${enc(u)}` }, known: 'sabdfl' },
    { name: 'Scratch', category: 'developer', url: (u) => `https://scratch.mit.edu/users/${u}/`, check: { kind: 'status', url: (u) => `https://api.scratch.mit.edu/users/${enc(u)}` }, known: 'griffpatch' },
    { name: 'OpenStreetMap', category: 'other', url: (u) => `https://www.openstreetmap.org/user/${u}`, check: { kind: 'status', url: (u) => `https://www.openstreetmap.org/user/${enc(u)}` }, known: 'steve' },
    { name: 'itch.io', category: 'gaming', url: (u) => `https://${u}.itch.io`, check: { kind: 'status', url: (u) => `https://${enc(u)}.itch.io` }, known: 'leafo' },
    { name: 'DeviantArt', category: 'creative', url: (u) => `https://www.deviantart.com/${u}`, check: { kind: 'status', url: (u) => `https://www.deviantart.com/${enc(u)}` }, known: 'team' },
    { name: 'Disqus', category: 'social', url: (u) => `https://disqus.com/by/${u}/`, check: { kind: 'status', url: (u) => `https://disqus.com/by/${enc(u)}/` }, known: 'disqus' },
    { name: 'Wattpad', category: 'writing', url: (u) => `https://www.wattpad.com/user/${u}`, check: { kind: 'status', url: (u) => `https://www.wattpad.com/api/v3/users/${enc(u)}`, availableStatus: [400, 404] }, known: 'Wattpad' },
    { name: 'Pastebin', category: 'other', url: (u) => `https://pastebin.com/u/${u}`, check: { kind: 'status', url: (u) => `https://pastebin.com/u/${enc(u)}` }, known: 'admin' },
];
