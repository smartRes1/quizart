FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server.js ./
COPY lib ./lib
COPY public ./public
# Beispiel-Quizze; werden nur verwendet, wenn im Volume noch kein quizzes/-Ordner liegt
COPY data/quizzes ./defaults/quizzes
RUN mkdir -p /app/data && chown -R node:node /app
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["sh", "-c", "[ -d /app/data/quizzes ] || cp -r /app/defaults/quizzes /app/data/quizzes; exec node server.js"]
