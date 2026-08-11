set dotenv-load := true

setup:
    npm install
    npm run assets:generate
    docker compose up -d db
    npm run db:migrate:dev -w @aerstello/api

dev:
    npm run dev

check:
    npm run check:full

e2e:
    docker compose up -d db
    npm run test:e2e:full

seed:
    npm run db:seed -w @aerstello/api
