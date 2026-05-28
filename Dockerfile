FROM node:22-alpine

WORKDIR /app

COPY package.json .
COPY src/ ./src/

RUN addgroup -S prox && adduser -S prox -G prox && \
    chown -R prox:prox /app

USER prox

EXPOSE 8080 8081

CMD ["node", "src/server.js"]
