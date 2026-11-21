-- Run on every `pnpm infra:up` by the keep-database service, so existing local volumes get Keep's database too.
SELECT 'CREATE ROLE keep LOGIN PASSWORD ''local-keep''' WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'keep') \gexec
SELECT 'CREATE DATABASE keep OWNER keep' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'keep') \gexec
\connect keep
-- pgvector is not a trusted extension, so the superuser installs it for Keep.
CREATE EXTENSION IF NOT EXISTS vector;
