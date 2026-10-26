# The web app, exactly as GitHub Pages and the APK get it: scripts/build-web.js decides
# what ships, so this image can never serve a file the real targets do not.
#
#   docker compose up web          ->  http://localhost:8080
#
# Also a complete self-hosting answer: any box that runs a container can serve Reeldeck,
# which is the way out if the repository ever goes private (Pages on a private repo is a
# paid feature; this is not).

FROM node:22-alpine AS build
WORKDIR /src
# Only what build-web.js reads. Nothing here needs node_modules.
COPY scripts/build-web.js scripts/web-files.js scripts/
COPY index.html app.js styles.css stage.css sw.js manifest.webmanifest ./
COPY assets assets
RUN node scripts/build-web.js

FROM nginx:1.27-alpine
COPY docker/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /src/www /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=10s --timeout=3s --retries=5 CMD wget -qO- http://127.0.0.1/ >/dev/null || exit 1
