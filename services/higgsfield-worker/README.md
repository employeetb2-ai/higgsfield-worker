# Higgsfield video worker

This small Node service is the bridge between the Cloudflare dashboard and the
connected Higgsfield account. It runs Higgsfield's official CLI, selects
`kling3_0`, downloads the generated video, and returns the result URL to the
dashboard. The dashboard never receives the Higgsfield session token.

The dashboard does not call Kling directly or require Kling API credentials.
All video generation uses Kling through this Higgsfield worker. Copy, static ads,
carousel images, and collage panels continue to use Gemini as the primary
image generator.

## Image fallback (`/generate-image`)

Gemini's own image models occasionally block a generation with an
`IMAGE_SAFETY` finishReason on certain reference photos — most commonly
swimwear/lingerie product ads, even fully modest ones. This isn't
adjustable via Gemini's `safetySettings` (confirmed by testing — that
parameter only controls separate text-prompt harm categories, not this
filter). When that happens, the dashboard falls back once to this worker's
`/generate-image` endpoint instead of failing the part outright.

The default fallback model is `seedream_v4_5`, chosen by testing every
image model available on this Higgsfield account against a real reference
photo Gemini blocked (2026-08-27): `gpt_image_2` and `seedream_v5_pro` were
*also* blocked (same underlying issue — the photo itself, not a
Gemini-specific quirk), and the two cheapest Higgsfield-native models
(`text2image_soul_v2`, `soul_cinematic`) turned out not to ground on the
reference image at all — they produced unrelated content, cheap for a
reason. `seedream_v4_5` and `nano_banana_2_lite` were the best mix of
accuracy-to-reference and cost among the models that actually worked;
`seedream_v4_5` was picked as the default for slightly sharper output at
the same price. See `ALLOWED_IMAGE_MODELS` in `server.mjs` if that ever
needs revisiting — only re-add a model here after testing it the same way.

## Local setup

Authenticate the CLI once on the machine running the worker:

```bash
higgsfield auth login
```

Kling generation requires a Higgsfield workspace:

```bash
higgsfield workspace list
higgsfield workspace set <workspace-id>
```

Start the worker with a private internal secret:

```bash
HIGGSFIELD_WORKER_SECRET='use-a-long-random-value' \
HIGGSFIELD_WORKSPACE_ID='<workspace-id>' \
npm run higgsfield:worker
```

For this repository's local dashboard, the worker settings can live in
`.env.local` and the worker can then be started with:

```bash
npm run higgsfield:worker:local
```

Configure the dashboard's local environment separately:

```env
HIGGSFIELD_WORKER_URL=http://127.0.0.1:8788
HIGGSFIELD_WORKER_SECRET=use-a-long-random-value
HIGGSFIELD_WORKSPACE_ID=<workspace-id>
HIGGSFIELD_MODEL=kling3_0
HIGGSFIELD_DURATION=10
HIGGSFIELD_MODE=pro
HIGGSFIELD_ASPECT_RATIO=9:16
HIGGSFIELD_SOUND=on
HIGGSFIELD_API_RETRY_ATTEMPTS=3
HIGGSFIELD_API_RETRY_BASE_DELAY_MS=2000
HIGGSFIELD_PROMPT=Use the original product exactly as shown. Create a highly realistic vertical Dutch lifestyle fashion video with a naturally styled Dutch woman, gentle zoom, candid walking and turning, warm daylight, calm advertisement music, and no talking. Do not redesign the product or generate text in the scene.
```

The worker endpoints are:

- `GET /health`
- `POST /generate` — Kling video, protected by `x-higgsfield-worker-secret`
- `POST /generate-async` — Kling video with a callback URL, same auth
- `POST /generate-image` — image fallback for a Gemini `IMAGE_SAFETY` block, same auth. Body: `{ prompt, image_url, model?, aspect_ratio? }`. `model` defaults to `HIGGSFIELD_IMAGE_MODEL` (`seedream_v4_5`) and must be one of `ALLOWED_IMAGE_MODELS` in `server.mjs`. Synchronous — images finish in well under a minute, so there's no async/callback variant.

Image fallback env vars (all optional, sensible defaults above):

```env
HIGGSFIELD_IMAGE_MODEL=seedream_v4_5
HIGGSFIELD_IMAGE_ASPECT_RATIO=9:16
HIGGSFIELD_IMAGE_WAIT_TIMEOUT=3m
```

The dashboard sends the approved product image URL and prompt to `/generate`.
The generated result is downloaded and stored in the existing `ad-videos`
Supabase bucket, so the Creatives UI does not need a separate video storage
path.

## Deployment

Deploy this service to a persistent Node host such as Railway, Render, or a
small VPS. The host must have:

- Node.js
- the Higgsfield CLI installed
- the authenticated CLI state persisted between restarts
- outbound access to Higgsfield and the source image URL

Set `HIGGSFIELD_WORKER_HOST=0.0.0.0` on the deployed worker host. Locally it
binds to `127.0.0.1` by default.

The current Cloudflare Worker should call this service through
`HIGGSFIELD_WORKER_URL`. Do not put the Higgsfield token in the dashboard's
environment or browser. The worker session may expire; the official CLI can
be reauthenticated with `higgsfield auth login`.

## Railway deployment

Deploy this worker as its own Railway service. Keep the dashboard on Vercel.
Railway is used here because the CLI OAuth state needs a persistent filesystem
and Kling jobs can run for several minutes.

1. Create a service from this repository and set
   `RAILWAY_DOCKERFILE_PATH=services/higgsfield-worker/Dockerfile`.
2. Add a Railway Volume mounted at `/root/.config/higgsfield`.
3. Create a base64-encoded copy of the local CLI credentials without printing
   it into the repository or chat:

   ```bash
   base64 < ~/.config/higgsfield/credentials.json | tr -d '\n'
   ```

   Save that value as the Railway secret `HIGGSFIELD_CREDENTIALS_B64`. The
   startup script uses it only to seed the persistent volume on first start.
4. Add these service variables:

   ```env
   HIGGSFIELD_WORKER_HOST=0.0.0.0
   HIGGSFIELD_WORKER_SECRET=<long-random-secret>
   HIGGSFIELD_WORKSPACE_ID=<workspace-id>
   HIGGSFIELD_MODEL=kling3_0
   HIGGSFIELD_DURATION=10
   HIGGSFIELD_MODE=pro
   HIGGSFIELD_ASPECT_RATIO=9:16
   HIGGSFIELD_SOUND=on
   HIGGSFIELD_API_RETRY_ATTEMPTS=3
   HIGGSFIELD_API_RETRY_BASE_DELAY_MS=2000
   HIGGSFIELD_WAIT_TIMEOUT=15m
   HIGGSFIELD_COMMAND_TIMEOUT_MS=1200000
   ```
5. Set the Railway healthcheck path to `/health` and generate a public
   service domain. Confirm that `https://<domain>/health` returns `ok: true`.
6. Add the Railway URL and the same worker secret to the dashboard's Vercel
   environment:

   ```env
   HIGGSFIELD_WORKER_URL=https://<railway-domain>
   HIGGSFIELD_WORKER_SECRET=<same-long-random-secret>
   ```

   Redeploy the dashboard after changing its environment variables.

Treat `HIGGSFIELD_CREDENTIALS_B64` as a password. If the Higgsfield session is
revoked, authenticate locally again, replace that Railway secret, and restart
the service. The Higgsfield workspace and its web credits remain unchanged.
