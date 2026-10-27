# Serving the Trapt pages

There are two different sites in this repository, and they have very different
hosting problems.

**The ISO page** ([`tools/web/pick.html`](../tools/web/pick.html)) is ~940 KB
of code and no game data — the visitor supplies their own disc and the browser
decodes it. It is published to **GitHub Pages**; skip to §3.1.

**The exported site** (`tools/site.py`) is a directory of plain files with all
149 cutscenes already decoded — no build step, no runtime, nothing
server-side. Anything that serves static files will do; the only things that
need deciding are where the ~0.9 GB lives and who terminates TLS. Sections 1,
2 and 4 are about that one.

```
452 files, 0.89 GB          largest single file 18.2 MB (e001/scene.js)
149 x scene.js  869 MB      gzips to ~55%, so ~0.5 GB on the wire
149 x poster.png  9 MB      151 x .html  11.5 MB
```

`robkrum.com` is already on Cloudflare nameservers (`aryanna`/`trey.ns.
cloudflare.com`) with the apex proxied, so whichever route you pick, the DNS
half is one record in that zone.

> The **exported** site is the complete asset set of a commercial game —
> models, textures, the whole voice track and script. That is a
> redistribution question worth settling before it is public, and it is not a
> technical one. The ISO page raises none of it: it ships no assets, and a
> visitor without their own disc sees nothing.

---

## 1. Docker — one image, runs anywhere

`deploy/Dockerfile` bakes the site into `caddy:2-alpine`. The site normally
lives outside the repo (it is 0.9 GB and the repo is on a nearly-full drive),
so it comes in as a **named build context** rather than being copied in first:

```sh
docker build -t trapt-site \
  --build-context site='E:/Seagate/OpenSuseBack/Emulators/PS2EMU/trapt-site' \
  -f deploy/Dockerfile deploy

docker run -d --name trapt -p 127.0.0.1:8080:8080 trapt-site
```

The build fails rather than shipping a broken image if `index.html`,
`order.js` or `e001/scene.js` is missing, or if the Caddyfile does not
validate. The container serves **plain HTTP on 8080** and has no certificates
in it — TLS is Cloudflare's job (§5) or a front proxy's.

`deploy/docker-compose.yml` has both shapes:

| service | image | when |
|---|---|---|
| `trapt` | ~1 GB, site baked in | one artifact to `docker save` and ship; content changes mean a rebuild |
| `trapt-mounted` | ~50 MB, site bind-mounted | content changes by rsync, no rebuild |

```sh
TRAPT_SITE='E:/.../trapt-site' docker compose up -d trapt
```

Baking is the better default here: the site only changes when you re-run
`site.py`, and an immutable image is the whole point of shipping it to a host.
The mounted variant is better while you are still rebuilding cutscenes.

**Sidecars roughly double the image.** If you run `deploy/precompress.py`
before building, the `.gz` files are baked in too — the image goes from
~0.95 GB to ~1.4 GB, and Caddy serves the compressed bytes with no CPU per
request. If you skip it, `encode zstd gzip` in the Caddyfile compresses on the
fly instead and the image stays small. Behind Cloudflare the edge caches the
compressed response anyway, so the on-the-fly route is the sensible default
there; precompress when the origin is exposed directly.

## 2. Cloudflare Pages — no server at all

Everything fits: 452 files against a 20,000 limit, largest file 18.2 MB
against a 25 MiB limit, and the DNS is already in the right account.

```sh
npx wrangler pages project create trapt
npx wrangler pages deploy 'E:/.../trapt-site' --project-name trapt
```

Then add `trapt.robkrum.com` as a custom domain on the project; Cloudflare
writes the DNS record and issues the certificate itself. `site.py` writes a
`_headers` file into the site, which Pages (and Netlify) picks up for the
cache policy — a week on the bundles, five minutes on the pages that change
every build.

The trade: ~0.9 GB per deployment upload, and the content sits in Cloudflare's
account rather than yours.

## 3. The droplet that already runs Forgejo and decomp.me

`marketplace-s-1vcpu-1gb-sfo3` is **1 vCPU / 1 GB / 48 GB**, about 18 GB free.
**Memory, not disk, is the constraint** — it runs near 57% with swap already in
use. `~/forgejo/Caddyfile` already fronts `code.robkrum.com`,
`rpcn.sonicthefighte.rs` and `decomp.sonicthefighte.rs`. Adding this site means
one Caddy block and one container:

```
trapt.robkrum.com {
    reverse_proxy trapt:8080
}
```

`proxy` is declared `external: true` in your compose file, so it already exists
and is not owned by the Forgejo stack — it is how `decompme-nginx` is reached,
and joining it disturbs nothing.

There are two different things that could sit behind that block.

### 3.1 The ISO page — GitHub Pages

[`tools/web/pick.html`](../tools/web/pick.html) ships **no game data**. The
visitor supplies their own disc and the browser does what `export.py` does
([`BROWSER.md`](BROWSER.md)). That is ~940 KB of code, and it makes the
redistribution question at the top of this file go away — which is also what
makes it fit for a public GitHub repository.

`deploy/build-web.py` turns the checkout into a servable tree: `pick.html`
becomes `index.html`, the scripts it names are copied out (the test suites and
`stub_three.js` are not), `../vendor/three.min.js` lands under `vendor/`, and
every script filename gets a content hash. Every path in it is relative, so
the same tree works at `https://<user>.github.io/Trapt/` and at a domain root.

[`.github/workflows/pages.yml`](../.github/workflows/pages.yml) does the rest
on every push to `main`: parse every module, run the no-disc suites, build
into `_site`, and deploy it with `actions/deploy-pages`. Forgejo ignores
`.github/workflows` while `.forgejo/workflows` exists, so the CI on
`code.robkrum.com` is unaffected.

To switch it on, once:

```sh
gh repo create Trapt --public --source . --remote github   # or an existing repo
git push github main
gh api -X POST repos/{owner}/Trapt/pages -f build_type=workflow
```

(or Settings → Pages → Source: **GitHub Actions**). Pages on a free account
needs the repository public; check nothing in it is game data first —
`.gitignore` keeps out `*.iso`, `*.zip`, `*.bin` and `*.elf`, and `out/` and
`.scratch/` hold the extracted assets.

**A custom domain** such as `trapt.robkrum.com`: set it under Settings →
Pages (a `CNAME` file in the artifact is ignored by Actions deploys), then in
Cloudflare add `CNAME trapt -> <user>.github.io`, **DNS only** (grey) until
GitHub has issued its certificate, then tick *Enforce HTTPS*.

What Pages cannot do, and what replaces it:

| was in the Caddy config | on Pages |
|---|---|
| `Content-Security-Policy` | already a `<meta>` written by the build, sha256-pinned to the one inline script |
| `Referrer-Policy: no-referrer` | a `<meta name="referrer">`, also written by the build |
| `immutable` for a year on the hashed scripts | Pages sends `max-age=600` for everything; the hashed names still mean a stale script can never be paired with a new `index.html` |
| `frame-ancestors 'none'`, `nosniff`, COOP | not settable. The page holds no session and no secrets, so being framed costs nothing |

To check a build locally the way Pages serves it:

```sh
python3 deploy/build-web.py /tmp/trapt-web/Trapt
python3 -m http.server -d /tmp/trapt-web 8000   # http://localhost:8000/Trapt/
```

### 3.2 The exported site

`deploy/docker-compose.droplet.yml` serves the 0.9 GB export from `site.py`
instead — every model, texture, voice line and subtitle, pre-decoded.

```sh
TRAPT_SITE=/srv/trapt-site docker compose -f docker-compose.droplet.yml up -d
```

`deploy/docker-compose.droplet.yml` is the **bind-mounted** shape, not the
baked image, and `deploy/deploy-droplet.sh` rsyncs the site up **without** the
`.gz` sidecars. With 18 GB free either would fit, so the reasons are smaller
ones: a baked image is a second copy of bytes already on disk, and the sidecars
buy nothing because Cloudflare caches the compressed response at the edge, so
the origin compresses almost nothing. The container is capped at
`mem_limit: 128m`, which is a ceiling and not a reservation — Caddy serving
static files sits nearer 20 MB.

> An earlier draft of this file said 25 GB, inferred from the droplet's size
> rather than measured. The box reports 48 GB with 18 GB free, so disk was
> never the pressure; memory is.

> Unrelated but worth knowing: `rpcn.sonicthefighte.rs` resolves straight to
> `<droplet-ip>` while everything else is proxied, so the origin IP is
> public and the proxying on the other names buys less than it looks like.
> Proxying that record too, or moving it, would close that.

## 4. Any other box

`deploy/Caddyfile` is standalone with automatic TLS; `deploy/nginx.conf` is
for a machine already running nginx, with `gzip_static on`.

```sh
rsync -avz --delete-after 'E:/.../trapt-site/' trapt.robkrum.com:/srv/trapt-site/
```

Run `python deploy/precompress.py <site-dir>` first for either of these. It
writes `.gz` (and `.br` if the `brotli` module is installed) sidecars that
Caddy's `precompressed` and nginx's `gzip_static` serve directly, instead of
re-compressing 18 MB on every request. It only ever adds files.

## 5. The DNS record, and TLS

For the droplet, in the Cloudflare dashboard for `robkrum.com` -- the same
shape as the `code` record you already have:

```
Type  Name    Content            Proxy
A     trapt   <droplet-ip>     Proxied (orange)
```

Proxied means Cloudflare terminates TLS at the edge and the origin only has to
speak HTTP — which is exactly what the container does. Set the zone's SSL mode
to **Full (strict)** and give the origin a Cloudflare Origin Certificate if you
want the hop encrypted too; with the standalone `deploy/Caddyfile` it gets a
real certificate on its own and Full (strict) works with no extra step.

Two things to know about putting 0.9 GB of game audio behind the free plan:
Cloudflare's terms restrict using the CDN for disproportionate non-HTML
content, and the payload here is mostly base64 audio and textures inside
`.js`. Pages advertises unlimited bandwidth and is the safer of the two on
that point.

## 6. The CI runner

`code.robkrum.com` has an Actions tab but nothing runs in it until a runner is
registered. `deploy/docker-compose.runner.yml` is one, on the same droplet:

```sh
# a token from the repo's Settings -> Actions -> Runners, or site admin
mkdir -p runner
docker run --rm -it -v "$PWD/runner:/data" \
  data.forgejo.org/forgejo/runner:13.0.0 \
  forgejo-runner register --no-interactive \
    --instance https://code.robkrum.com \
    --token <TOKEN> --name droplet \
    --labels 'docker:docker://node:20-bookworm-slim'

cp deploy/runner-config.yml runner/config.yml
docker compose -f deploy/docker-compose.runner.yml up -d
```

The label has to match the workflow: `runs-on: docker` picks the label named
`docker`, and the image after `docker://` is the default for a job that does
not name its own container.

**It mounts the host's Docker socket.** That is the light option — a
docker-in-docker sidecar wants its own daemon and storage layer, which is a
lot next to Forgejo and decomp.me on 1 GB — but it is not a small permission:
a job can talk to the host daemon, which is effectively root on the droplet.
For a private instance whose workflows you write yourself that is a considered
trade; it would not be one for a repository taking pull requests from
strangers.

Sized for the box: one job at a time, a 15 minute timeout, 256 MB and one CPU
per job, and a single ~240 MB image rather than the gigabyte-each official
node and python ones. The memory cap is measured rather than guessed — each
suite peaks near 50 MB of RSS and they run one at a time — and it is a ceiling,
not a reservation. `git` and `python3` are installed in the first step, before
the checkout, because the slim image has neither and installing them does not
need the repository.

Job containers are removed as they finish but pulled images are not, so
`docker image prune -f` is worth a weekly cron entry.

### What it can actually test

Nothing here builds without the disc, and most suites are parity diffs against
the Python over real game data, so they skip themselves (exit 2) and the job
still passes:

```
node tools/web/test_all.js              # 390 checks, disc present
node tools/web/test_all.js --no-disc    # 114 checks, what CI runs
```

The 114 are the three suites that have caught bugs that shipped: module
loading under a browser's shared global scope, the GS shaders in `gs.js`
matching `player.html`, and `pick.html`'s initialisation order. See
[`BROWSER.md`](BROWSER.md) §4.

## 7. Rebuilding

The site is regenerated, never patched:

```sh
python tools/site.py <site-dir> --resume --posters --jobs 12
python deploy/precompress.py <site-dir>
```

`--resume` skips what is already built, so a re-run after changing
`player.html` alone is still a full re-export — the player template is baked
into every page. 149 cutscenes takes about 3 minutes at `--jobs 12`.
