# Serving the cutscene site at `trapt.robkrum.com`

`tools/site.py` writes a directory of plain files — no build step, no runtime,
nothing server-side. Anything that serves static files will do; the only
things that need deciding are where the ~0.9 GB lives and who terminates TLS.

```
452 files, 0.89 GB          largest single file 18.2 MB (e001/scene.js)
149 x scene.js  869 MB      gzips to ~55%, so ~0.5 GB on the wire
149 x poster.png  9 MB      151 x .html  11.5 MB
```

`robkrum.com` is already on Cloudflare nameservers (`aryanna`/`trey.ns.
cloudflare.com`) with the apex proxied, so whichever route you pick, the DNS
half is one record in that zone.

> The site is the complete asset set of a commercial game — models, textures,
> the whole voice track and script. That is a redistribution question worth
> settling before it is public; it is not a technical one.

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

`marketplace-s-1vcpu-1gb-sfo3` is a **1 vCPU / 1 GB / 25 GB** box, and
`~/forgejo/Caddyfile` already fronts `code.robkrum.com`, `rpcn.sonicthefighte.rs`
and `decomp.sonicthefighte.rs`. Adding this site means one Caddy block and one
container:

```
trapt.robkrum.com {
    reverse_proxy trapt:8080
}
```

```sh
# on the droplet, joined to the network Caddy is already on
NET=forgejo_default TRAPT_SITE=/srv/trapt-site \
  docker compose -f docker-compose.droplet.yml up -d
docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile
```

`deploy/docker-compose.droplet.yml` is the **bind-mounted** shape, not the
baked image, and `deploy/deploy-droplet.sh` rsyncs the site up **without** the
`.gz` sidecars. Both choices are about the 25 GB disk: a baked image would put
a ~0.95 GB layer on top of the ~0.89 GB it already has to store, and the
sidecars are another ~0.45 GB. Cloudflare caches the compressed response at
the edge, so the origin compresses almost nothing. The container is capped at
`mem_limit: 128m` — static file serving needs far less, and the box has 1 GB
to share three ways.

**Check the disk before you start.** 0.89 GB is not much, but decomp.me's
compiler images are not small:

```sh
df -h /            # needs ~1 GB free, comfortably
docker system df   # what the existing stacks are holding
```

If it is tight, §2 is the better answer — Pages costs the droplet nothing.

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
docker run --rm -it -v "$PWD/runner:/data"   data.forgejo.org/forgejo/runner:13.0.0   forgejo-runner register --no-interactive     --instance https://code.robkrum.com     --token <TOKEN> --name droplet     --labels 'docker:docker://node:20-bookworm-slim'

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

Sized for the box: one job at a time, a 15 minute timeout, 512 MB and one CPU
per job, and a single ~240 MB image rather than the gigabyte-each official
node and python ones. `git` and `python3` are installed in the first step,
before the checkout, because the slim image has neither and installing them
does not need the repository.

Job containers are removed as they finish but pulled images are not, so
`docker image prune -f` is worth a weekly cron entry on a 25 GB disk.

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
