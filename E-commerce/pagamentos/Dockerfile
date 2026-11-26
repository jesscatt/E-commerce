FROM node:22-alpine
WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY migrations/ ./migrations/
COPY scripts/ ./scripts/
COPY src/ ./src/

ENV NODE_ENV=production
EXPOSE 3000

# Migração idempotente antes de subir a API.
CMD ["npm", "start"]
