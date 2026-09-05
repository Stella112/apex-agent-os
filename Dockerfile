# APEX has no dependencies, so the image is the runtime plus the source.
FROM node:22-alpine

WORKDIR /app
COPY package.json ./
COPY server.mjs ./
COPY src ./src
COPY public ./public
COPY config ./config
COPY fixtures ./fixtures
COPY bin ./bin

ENV HOST=0.0.0.0
ENV PORT=4173
EXPOSE 4173

# Run unprivileged.
USER node

CMD ["node", "server.mjs"]
