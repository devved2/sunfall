FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts
ENV PORT=8787 DATA_DIR=/data
EXPOSE 8787
CMD ["node", "src/server.js"]
