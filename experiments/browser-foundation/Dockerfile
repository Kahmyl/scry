FROM scry-ten-current:918b22d
USER root
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg xvfb && rm -rf /var/lib/apt/lists/*
WORKDIR /candidate/experiments/browser-foundation
COPY experiments/browser-foundation/package*.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org
ENV PLAYWRIGHT_BROWSERS_PATH=/candidate-browsers
RUN node node_modules/playwright/cli.js install chromium
COPY packages/veil/src/classifier.ts packages/veil/src/native-mask-runtime.js /candidate/packages/veil/src/
COPY experiments/browser-foundation/src ./src
COPY experiments/browser-foundation/test ./test
CMD ["node","src/server.mjs"]
