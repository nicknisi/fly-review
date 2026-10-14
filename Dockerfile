# fruitfly.review: the fly-review server in public mode, for a Cloudflare Container (deploy/cloudflare).
# The connectome simulator is Java; the server is Node, run straight from TypeScript.
FROM eclipse-temurin:21-jdk AS jdk

FROM node:24-bookworm-slim
ENV JAVA_HOME=/opt/java/openjdk
ENV PATH=$JAVA_HOME/bin:$PATH
COPY --from=jdk /opt/java/openjdk /opt/java/openjdk
WORKDIR /app
COPY package.json package-lock.json ./
# The lockfile resolves through a private registry mirror; the same tarballs come from the public registry.
RUN npm ci --no-audit --no-fund --registry=https://registry.npmjs.org/ --replace-registry-host=always
COPY tsconfig.json tsconfig.web.json ./
COPY scripts scripts
COPY vendor vendor
COPY brain brain
COPY data data
COPY src src
COPY web web
# Compile the simulator and extract the anatomy (the connectome is in data/, so nothing is downloaded), build the
# pages, and make the trained memory the live fly.
RUN node scripts/setup.ts \
  && npm run build:web \
  && node src/review-install-memory.ts data/trained-memory.json
ENV FLY_REVIEW_PUBLIC=1 HOST=0.0.0.0 PORT=8080 PUBLIC_ORIGIN=https://fruitfly.review
EXPOSE 8080
CMD ["node", "src/server.ts"]
