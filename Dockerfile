FROM node:22-alpine

RUN apk add --no-cache wget unzip && \
    XRAY_VER=$(wget -qO- https://api.github.com/repos/XTLS/Xray-core/releases/latest | \
      grep -o '"tag_name":"[^"]*"' | head -1 | cut -d'"' -f4) && \
    wget -qO /tmp/xray.zip \
      "https://github.com/XTLS/Xray-core/releases/download/${XRAY_VER}/Xray-linux-64.zip" && \
    unzip /tmp/xray.zip xray -d /usr/local/bin/ && \
    chmod +x /usr/local/bin/xray && \
    rm /tmp/xray.zip && \
    apk del wget unzip

WORKDIR /app
COPY package.json ./
COPY src/ ./src/
COPY start.sh ./
RUN chmod +x start.sh && \
    addgroup -S prox && adduser -S prox -G prox && \
    chown -R prox:prox /app

USER prox
EXPOSE 8080
CMD ["sh", "start.sh"]
