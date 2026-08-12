FROM caddy:2.11.4-alpine

ARG AERSTELLO_DOMAIN
ARG ACME_EMAIL
ENV AERSTELLO_DOMAIN=${AERSTELLO_DOMAIN}
ENV ACME_EMAIL=${ACME_EMAIL}

COPY Caddyfile /etc/caddy/Caddyfile
RUN caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
