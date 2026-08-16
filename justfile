set dotenv-load := true

setup:
    npm install
    npm run assets:generate
    npm run db:start:dev
    npm run db:migrate:dev -w @aerstello/api

dev:
    npm run db:start:dev
    npm run dev

check:
    npm run check:full

e2e:
    npm run db:start:dev
    npm run test:e2e:full

seed:
    npm run db:seed -w @aerstello/api
