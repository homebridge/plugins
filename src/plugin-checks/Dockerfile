FROM node:lts

RUN apt-get update && apt-get install -y build-essential git python3 && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /workspace /results

WORKDIR /workspace

COPY workspace /workspace

RUN npm ci

CMD ["npx", "tsx", "index.ts"]
