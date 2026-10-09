# Batiyao developer sample

A small, complete web app that lets a person **Connect with Batiyao** and then
uses every capability of the [Batiyao API](https://developer.batiyao.com):
reading their profile, feed, notifications and chats, publishing a post,
uploading media and posting a story — and disconnecting again.

It is plain Node.js with **no dependencies**: clone it, add your app's client
ID, and run it on `localhost`.

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
| 401 | Token invalid, expired, or the app was disconnected | Refreshes once; if that fails, asks the person to connect again |
| 402 | Not enough BuckBuck | Says so plainly; nothing was spent; doesn't retry |
| 403 | Permission missing or switched off, or this account may not do it (accounts of minors are restricted) | Shows the message; doesn't retry or re-ask for consent |
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

## Tests

```bash
npm test
```

The end-to-end test runs the real server against a stand-in for Batiyao:
the sign-in with PKCE verified, every page, escaping of user content, the
confirm-before-spending rule, a 402, token refresh, media and story upload,
and Disconnect. No network access or Batiyao account is needed.

## Links

- Documentation: <https://developer.batiyao.com>
- Register an app: <https://batiyao.com/settings/developer>
- People manage connected apps at: <https://batiyao.com/settings/connections>

MIT licensed. See [LICENSE](LICENSE).
