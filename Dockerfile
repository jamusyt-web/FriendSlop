# FriendSlop game server: builds the browser client, then runs the Node server
# (serves the game page + WebSocket at /ws on $PORT). Works on Render, Fly.io, Railway, any VPS.
#   docker build -t friendslop .
#   docker run -p 3000:3000 friendslop     -> http://localhost:3000

# 1) build the client (needs dev tools like vite)
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# 2) small runtime image: only the server, shared code, built client and runtime packages
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production NPM_CONFIG_UPDATE_NOTIFIER=false
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY shared ./shared
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3000
CMD ["npm", "start"]
