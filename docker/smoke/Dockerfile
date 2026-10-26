# Headless Chromium that can actually SEE the app.
#
# The in-editor preview pane never fires requestAnimationFrame and returns black
# screenshots while hidden, so animation and layout were being verified by reading
# computed styles. This gives real pixels and a real frame clock:
#
#   docker compose run --rm smoke        ->  docker/out/*.png + report.json
#
# The npm package must match the image's bundled browsers, hence the pinned pair.
FROM mcr.microsoft.com/playwright:v1.63.0-noble
WORKDIR /smoke
RUN npm init -y >/dev/null && npm install --no-audit --no-fund playwright@1.63.0 >/dev/null
COPY docker/smoke/smoke.js smoke.js
ENV BASE=http://web:80 OUT=/out
CMD ["node", "smoke.js"]
