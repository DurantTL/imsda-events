# Backup scheduler image: PostgreSQL 16 client tools (pg_dump, pg_restore, psql;
# they must match the production server's major version) plus the AWS CLI used
# to copy backups to Cloudflare R2, with the scripts baked in. Built and
# published by .github/workflows/docker-image.yml as
# ghcr.io/duranttl/imsda-events-backup:<commit sha>.
#
# It contains no credentials. Every secret (database password, R2 keys) is
# supplied at runtime from an env file on the server.
FROM postgres:16-alpine

RUN apk add --no-cache aws-cli

COPY *.sh /usr/local/bin/
RUN chmod 0755 /usr/local/bin/*.sh

ENV BACKUP_DIR=/backups \
    ASSET_DIR=/assets \
    BACKUP_OFFSITE_COMMAND='/usr/local/bin/offsite-r2.sh "$1"'

# The base image's entrypoint starts a database server; this one runs backups.
ENTRYPOINT ["sh", "/usr/local/bin/backup-scheduler.sh"]
