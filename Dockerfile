FROM node:20-slim

WORKDIR /app

RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install --production

COPY src/ ./src/
COPY bin/ ./bin/

ENV PORT=8080
ENV DEBUG=false
ENV FALLBACK=true

EXPOSE 8080

CMD ["node", "src/index.js"]
