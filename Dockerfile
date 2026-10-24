FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server.js ./
COPY public ./public
# Beispiel-Fragen; wird nur verwendet, wenn im Volume noch keine questions.json liegt
COPY data/questions.json ./defaults/questions.json
RUN mkdir -p /app/data && chown -R node:node /app
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["sh", "-c", "[ -f /app/data/questions.json ] || cp /app/defaults/questions.json /app/data/questions.json; exec node server.js"]
