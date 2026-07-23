-- PostgreSQL requires a newly-added enum value to be committed before rows
-- can safely use it. The data seed therefore lives in the following migration.
ALTER TYPE "MessageTemplateKey" ADD VALUE 'BALANCE_REMINDER';
