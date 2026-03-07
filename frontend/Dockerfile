FROM node:20-bullseye

RUN apt-get update \
  && apt-get install -y --no-install-recommends openjdk-17-jdk libnspr4 libnss3 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY app/package*.json ./
RUN npm install
CMD ["npm", "start"]
