FROM postgres:17-trixie

# Install repmgr and required utilities
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       postgresql-17-repmgr \
       ca-certificates \
       procps \
       iproute2 \
       netcat-openbsd \
    && rm -rf /var/lib/apt/lists/*

# Create directories for our configuration
RUN mkdir -p /etc/repmgr \
    && chown postgres:postgres /etc/repmgr

# Default PostgreSQL data directory
ENV PGDATA=/var/lib/postgresql/data

# PostgreSQL image's original entrypoint is retained
