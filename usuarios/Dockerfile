FROM node:24-alpine
WORKDIR /app

# Após gerar package-lock.json, npm ci torna as instalações reproduzíveis.
COPY package*.json ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev --no-audit --no-fund; else npm install --omit=dev --no-audit --no-fund; fi

COPY migrations/ ./migrations/
COPY seeds/ ./seeds/
COPY scripts/ ./scripts/
COPY src/ ./src/

ENV NODE_ENV=production
EXPOSE 3001

# Migração e seed idempotentes antes de iniciar a API.
CMD ["sh", "-c", "node scripts/bootstrap.js && node src/server.js"]
