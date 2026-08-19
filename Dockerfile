FROM node:20-alpine AS builder
WORKDIR /app

# install dependencies
COPY package.json package-lock.json* ./
RUN npm ci --production --silent || npm install --production --silent

# copy sources
COPY . .

FROM node:20-alpine
WORKDIR /app

# copy runtime files
COPY --from=builder /app .

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

CMD ["node", "server.js"]
