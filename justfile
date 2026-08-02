set dotenv-load := true

setup:
    npm install
    npm run assets:generate
    docker compose up -d db
    npm run db:migrate:dev -w @sky-bar/api

dev:
    npm run dev

check:
    npm run check

e2e:
    docker compose up -d db
    npm run test:e2e

seed:
    npm run db:seed -w @sky-bar/api
