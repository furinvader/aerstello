FROM caddy:2.11.4-alpine

ARG SKY_BAR_DOMAIN
ARG ACME_EMAIL
ENV SKY_BAR_DOMAIN=${SKY_BAR_DOMAIN}
ENV ACME_EMAIL=${ACME_EMAIL}

COPY Caddyfile /etc/caddy/Caddyfile
RUN caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
