# Build context must be the repo root (so both backend/ and frontend/ are available).
# docker build -t pi-workshop-backend -f backend/Dockerfile .
FROM node:22-slim
WORKDIR /app
# Install deps
COPY backend/package*.json backend/tsconfig.json backend/
RUN cd backend && npm ci
# Copy source
COPY backend/src backend/src
# Frontend served by the backend at runtime
COPY frontend frontend
CMD ["backend/node_modules/.bin/tsx", "backend/src/index.ts"]
