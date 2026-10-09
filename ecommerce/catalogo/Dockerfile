FROM node:22-alpine

WORKDIR /app

# Instala as dependências primeiro para aproveitar o cache das camadas
COPY package*.json ./
RUN npm install --omit=dev

COPY . .

EXPOSE 3002

# Roda o seed (idempotente) e depois sobe a API
CMD ["npm", "start"]
