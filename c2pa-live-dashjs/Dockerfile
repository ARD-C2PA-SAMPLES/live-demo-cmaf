# Static website that plays the C2PA signed DASH stream from Unified Origin.
#
# The bundle is built from src/ here, so the served app always matches the
# sources - no need to run `npm run build` before `docker compose up`.
FROM node:22-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY build.mjs ./
COPY src ./src
RUN npm run build

FROM nginx:alpine

# revalidate instead of serving a stale bundle after a rebuild, see nginx.conf
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY index.html iframe.html streams.json styles.css c2pa-logo.svg ard-logo.png /usr/share/nginx/html/
COPY partners /usr/share/nginx/html/partners
COPY --from=build /app/app.bundle.js /app/app.bundle.js.map /usr/share/nginx/html/

EXPOSE 80
