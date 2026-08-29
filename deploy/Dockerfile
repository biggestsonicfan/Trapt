# syntax=docker/dockerfile:1.7
#
# trapt.robkrum.com as one image: Caddy plus the built site.
#
# The site is ~0.9 GB and lives wherever `tools/site.py` wrote it, which is
# usually *not* inside the repo -- so it comes in as a named build context
# rather than being copied into the repo first:
#
#   docker build -t trapt-site \
#     --build-context site=/path/to/trapt-site \
#     -f deploy/Dockerfile deploy
#
# The image serves plain HTTP on 8080.  TLS is deliberately somebody else's
# job: Cloudflare terminates it at the edge, or a front proxy does.  See
# ../docs/DEPLOY.md.
FROM caddy:2-alpine

COPY Caddyfile.docker /etc/caddy/Caddyfile
COPY --from=site . /srv/trapt-site

# Fail the build rather than ship an image that 404s on its own front page.
RUN test -f /srv/trapt-site/index.html \
 && test -f /srv/trapt-site/order.js \
 && test -f /srv/trapt-site/e001/scene.js \
 && caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO /dev/null http://127.0.0.1:8080/index.html || exit 1

CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
