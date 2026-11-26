FROM node:22-alpine
WORKDIR /app
# Sem dependências: só o Node.
COPY package.json ./
COPY src/ ./src/
EXPOSE 3000
CMD ["node", "src/server.js"]
