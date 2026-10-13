# Batiyao developer sample

A small, complete web app that lets a person **Connect with Batiyao** and then
uses every capability of the [Batiyao API](https://developer.batiyao.com):
reading their profile, feed, notifications and chats, publishing a post,
uploading media and posting a story — and disconnecting again.

It is plain Node.js with **no dependencies**: clone it, add your app's client
ID, and run it on `localhost`.

It also has a **mini app**: [Wingbeat](miniapp/wingbeat), a small flying game
that runs *inside* Batiyao, with the SDK and tools to build your own — see
[Mini apps](#mini-apps).

## What you need

- **Node.js 18 or newer** (it uses the built-in `fetch`).
- **A Batiyao account** — any account can register apps; there is no separate
  developer sign-up.

## Run it on localhost

1. **Register an app.** Sign in at
   [batiyao.com → Settings → Developer](https://batiyao.com/settings/developer)
   and choose **Register an app**. Add this redirect URI, exactly:

   ```
   http://localhost:3000/callback
   ```

   `http://localhost` is allowed while you test; anything else must be
   `https://`. You get a **client ID** straight away. It is public: Batiyao
   issues no client secret, and PKCE is what secures the sign-in.

2. **Configure the sample.**

   ```bash
   git clone https://github.com/batiyao-app/developer-sample.git
   cd developer-sample
   cp .env.example .env
   # put your client ID in BATIYAO_CLIENT_ID
   ```

3. **Start it.**

   ```bash
   npm start
   ```

   Open <http://localhost:3000>, choose the permissions to ask for, and
   select **Connect with Batiyao**. Batiyao shows a consent screen naming your
   app and the permissions; approve it and you are back in the sample,
   connected.

To use another port, set both `PORT` and `REDIRECT_URI` in `.env`, and
register that redirect URI on your app too.

## What it shows

| Page | API call | Permission | Cost |
|---|---|---|---|
| Profile | `GET /v1/profile` | `read:feed` | free |
| Feed | `GET /v1/updates?limit=` | `read:feed` | free |
| A single post | `GET /v1/posts/{id}` | `read:feed` | free |
| Notifications | `GET /v1/notifications` | `read:notifications` | free |
| Chats, and one conversation | `GET /v1/chat`, `GET /v1/chat?conversation_id=` | `read:chat` | free |
| New post | `POST /v1/posts` | `write:post` | **1.0 BuckBuck** |
| Upload media | `POST /v1/media` | `write:media` | free |
| Post a story | `POST /v1/stories` | `write:post` + `write:media` | free |
| Disconnect | `POST /oauth/revoke` | — | — |

Ask for the fewest permissions you need. A person can switch any of them off
later in Batiyao → Settings → Connected apps, and that takes effect on your
very next request.

## How it works

Everything Batiyao-specific is in two files, written to be read:

- [`lib/oauth.js`](lib/oauth.js) — the sign-in: PKCE (S256), the authorize
  URL, the code exchange, refresh, and revoke.
- [`lib/api.js`](lib/api.js) — a client for `https://api.batiyao.com/v1`
  that keeps the token fresh and turns status codes into plain outcomes.

[`server.js`](server.js) is the web app around them.

### Connecting (OAuth 2.1 with PKCE)

1. `/connect` makes a fresh PKCE verifier and `state` for this attempt, keeps
   them in the server-side session, and sends the person to
   `https://api.batiyao.com/oauth/authorize` with the challenge.
2. Batiyao shows its consent screen and redirects back to `/callback` with a
   one-time `code`.
3. `/callback` checks that `state` is the one this session started with
   (otherwise the callback belongs to someone else's sign-in), then exchanges
   the code **and the verifier** at `/oauth/token`.

Discovery document:
`https://api.batiyao.com/.well-known/oauth-authorization-server`.

### Tokens

- **Tokens never reach the browser.** The browser holds only an `HttpOnly`
  session cookie; the tokens stay in the server's session.
- **Access tokens last an hour.** The client refreshes a minute before
  expiry, and once more if Batiyao rejects a token early.
- **Refresh tokens rotate.** Each refresh returns a new refresh token and the
  old one stops working, so always store the one you get back.
- **Disconnect** posts the **access token** to `/oauth/revoke`, which ends the
  whole connection on the person's account.

### Things about the API worth knowing

- **Results come in an envelope:** `{"result": "..."}`. For reads, the string
  is a one-line label (`UNTRUSTED PLATFORM DATA (feed) — …`) followed by a JSON
  document. The label is a reminder that the content was written by people:
  **escape everything you display** (this sample does, everywhere).
  `unwrap()` in [`lib/support.js`](lib/support.js) returns the parsed document.
- **Media upload** answers with a sentence whose last line is the media
  reference. Pass that string, unchanged, in a post's `media_urls`; don't
  build or parse it.
- **Posts:** at most 500 characters (an emoji counts as one), **no typed
  `#hashtags`** (Batiyao adds them and rejects typed ones), links bare and on
  their own line at the end. Set `content_rating` honestly (`sfw`,
  `suggestive`, `nsfw`); when unsure, choose the more restrictive one.
- **Stories** reach every follower, including people under 18, so they must
  be suitable for everyone (`content_rating: "sfw"`). They disappear after 48
  hours.
- **Chats:** apps get conversation and member ids, not names, and never see
  a conversation that includes a minor. Don't fetch or show a chat
  attachment's URL; say what it is in words.

### When Batiyao says no

| Status | Means | What this sample does |
|---|---|---|
| 400 | Batiyao refused what was sent: too long, a typed `#hashtag`, a rating it doesn't accept — or **not enough BuckBuck**, which comes back as `post creation failed: status 402`. The message is written for people | Shows the message; for a low balance says so plainly (nothing was spent); doesn't retry |
| 401 | No token was sent | Asks the person to connect |
| 403 | The token is no longer good (expired, or the person disconnected the app), **or** a permission is missing or switched off, **or** this account may not do this (accounts of minors are restricted). Batiyao doesn't say which | Tries one refresh. If the refresh fails (`invalid_grant`, "connection revoked"), the app was disconnected: asks the person to connect again. If a fresh token still gets 403, it's a permission: shows the message, doesn't re-ask for consent |
| 429 | Too many requests | Asks the person to wait |

### Spending someone's BuckBuck

Publishing a post costs 1.0 BuckBuck from the person's balance and cannot be
undone. The sample **asks before it spends**: the post form has a
confirmation box, and nothing is published without it. Never spend on a
schedule or in a loop — see [Costs](https://developer.batiyao.com/costs.html).

## Before you build on this for real

The sample keeps things short on purpose. For production:

- Serve over **https** and register an `https://` redirect URI.
- Store sessions in a persistent, encrypted store and mark the cookie
  `Secure` (here they live in memory; a restart signs everyone out).
- Keep the `state` and CSRF checks.

## Mini apps

A mini app is a different kind of thing from the web app above: a folder of
HTML, CSS and JavaScript that Batiyao hosts and runs for people, sealed off
from the internet. You host nothing. The full guide is at
<https://developer.batiyao.com/miniapps>.

| | |
|---|---|
| [`miniapp-sdk/batiyao-miniapp.js`](miniapp-sdk/batiyao-miniapp.js) | The SDK (1.4.0): one file, copy it into your app. `ready`, `getContext`, `storage`, `pay`, `share`, `pickImage`, `pickVideo`, `getNickname`, `db`, `multiplayer`, `ai` (BGen pictures, BAudio sounds, Batiyao AI answers), `capability`, `supports`, `getPurchases`, `consume`, `close`. |
| [`miniapp/wingbeat/`](miniapp/wingbeat) | The sample game: saved best score, a consumable (golden feathers), a permanent purchase (night sky), and "Share my score" (a score card drawn on a canvas, offered with `share()`). Live on Batiyao — open Mini apps and play it. |
| [`tools/miniapp-simulator.js`](tools/miniapp-simulator.js) | A stand-in for Batiyao on your machine: same sandbox, a payment sheet from your manifest, share and photo/video sheets, nicknames, a shared store and multiplayer across tabs, a log of every SDK call. |
| [`tools/pack-miniapp.js`](tools/pack-miniapp.js) | Checks the folder against Batiyao's upload rules and zips it. |

```bash
npm run miniapp                         # simulate Wingbeat at http://localhost:3100
npm run miniapp -- path/to/your-app     # or your own folder

# Register your app on batiyao.com → Mini apps → Built by me → New app,
# then pack it with the App ID you were given:
npm run pack:miniapp -- miniapp/wingbeat --app-id ma_abcdefgh23
```

Upload the zip on your app's page and press **Test**: that runs your version
exactly as people will see it, with payments that move nothing. An admin
reviews each version; if nobody acts within an hour it goes live by itself.

The rules that shape the code:

- **Bundle everything, with relative paths.** Nothing outside the folder
  loads: no CDN, no remote font, no `fetch` to another host.
- **Batiyao draws the payment sheet, not you.** Call `Batiyao.pay({ product })`
  from a tap; the price and wording come from your reviewed manifest.
- **Batiyao draws the share sheet too.** `Batiyao.share({ image: canvas, text })`
  from a tap; the person picks story, post or chat and decides. Your app only
  hears that the sheet closed — never reward or require sharing.
- **Photos and videos come from Batiyao's picker.** A file input in your
  app opens nothing. Call `Batiyao.pickImage({ max_size })` or
  `Batiyao.pickVideo({ max_seconds })` from a tap: Batiyao shows its own
  sheet and the device's picker, and your app gets only the file the person
  chose, as a `Blob`, with its location, camera and time removed. The answer
  is `{ status: 'picked', … }`, `'cancelled'` or `'unavailable'` (a child
  whose guardian hasn't allowed it); carry on in every case. An older
  Batiyao doesn't have these calls, so show the button only when
  `await Batiyao.supports('pickImage')` is true. In the simulator, tick
  "unavailable" (or open `/?pick=unavailable`) to try that answer.

  ```js
  if (await Batiyao.supports('pickImage')) button.hidden = false;
  button.onclick = async () => {
    const r = await Batiyao.pickImage({ max_size: 1024 });
    if (r.status !== 'picked') return;               // cancelled or unavailable
    img.src = URL.createObjectURL(r.image);           // or createImageBitmap(r.image)
  };
  ```
- **Nicknames are Batiyao's too.** Your app never asks for a name.
  `await Batiyao.getNickname()` gives `{ nickname }` (or `null` if the
  person has none yet); `getNickname({ ask: true })`, from a tap, shows
  Batiyao's own sheet first. Children choose from Batiyao's suggestions
  ("Calm Koala 47"). People can change it from Batiyao's menu: listen with
  `Batiyao.on('nickname', fn)`.
- **One store shared by everyone in your app: `Batiyao.db`.** 1 MB in all
  (test runs get their own). Each person writes only their own records, one
  per key, and everyone reads them — a champions list is one key everyone
  writes their best to. Values are text of at most 1,024 bytes. Mark a write
  `replaceable` (with a `rank`, such as the score) and Batiyao may replace it
  when the store is full: no rank before ranked, lower rank first, older
  first. If your write would be the first to go, it isn't saved
  (`{ saved: false }`: it didn't make the board); with nothing replaceable,
  a full store refuses with `STORE_FULL`. Scores come from people's own
  devices, so treat the board as for fun.

  ```js
  if (await Batiyao.supports('db')) {
    await Batiyao.db.set('best', JSON.stringify({ score }), { replaceable: true, rank: score });
    const { records } = await Batiyao.db.list('best', { order: 'rank_desc', limit: 10 });
    records.forEach((r) => addRow(r.player.nickname || 'Player', JSON.parse(r.value).score));
  }
  ```
- **Multiplayer is real-time matches of 2-8, relayed by Batiyao.** Only for
  apps a Batiyao admin has allowed (ask on your app's page), and adults
  only unless the admin allows children too; then children play only with
  children of their age, and only if a guardian has allowed it. Check
  `supports('multiplayer')`. `host({ max_players, public, meta })` and
  `join({ code })` (from a tap) resolve `{ status: 'joined', match }`,
  `'cancelled'` or `'unavailable'`; Batiyao asks for a nickname first.
  `send(data, { to })` takes any JSON up to 1,024 bytes and resolves at once
  (no receipt; past 20 a second the extra are dropped). Events:
  `multiplayer.on('joined' | 'left' | 'message' | 'host' | 'closed', fn)`.
  Nothing players send is kept. **Never use it to let people chat**: a
  developer whose game does is banned and all their apps are blocked.

  ```js
  const r = await Batiyao.multiplayer.host({ max_players: 2 });
  if (r.status === 'joined') showCode(r.match.code);    // the friend types it into join()
  Batiyao.multiplayer.on('message', ({ from, data }) => applyMove(from.id, data));
  Batiyao.multiplayer.send({ move: 'e4' });
  ```

  In the simulator every tab is its own player: open two to play against
  yourself. `/?age=minor` makes a tab a child; `/?mp=off` and
  `/?mp=ask_guardian` (or the switch on the page) try the other answers.
- **Credit, save, then consume.** Check `getPurchases()` at start-up and
  credit anything new before `consume()`, so nothing is lost if the app
  closes mid-way (see `syncPurchases` in [game.js](miniapp/wingbeat/game.js)).

## Tests

```bash
npm test
```

The end-to-end test runs the real server against a stand-in for Batiyao:
the sign-in with PKCE verified, every page, escaping of user content, the
confirm-before-spending rule, a 402, token refresh, media and story upload,
and Disconnect. No network access or Batiyao account is needed. The mini app
tests check Wingbeat against the upload rules, that remote and root-relative
references are refused, the packer's zip, that the simulator serves the game
sealed off and offers the picker, the SDK's option checks and
`supports()` (including what an older Batiyao without `features` has), the
nickname rules, the order a full shared store replaces records in, match
codes, and the simulator's leaderboard and matches.

## Links

- Documentation: <https://developer.batiyao.com>
- Register an app: <https://batiyao.com/settings/developer>
- People manage connected apps at: <https://batiyao.com/settings/connections>
- Mini apps guide: <https://developer.batiyao.com/miniapps>
- Build a mini app: <https://batiyao.com/apps?tab=built>

MIT licensed. See [LICENSE](LICENSE).
