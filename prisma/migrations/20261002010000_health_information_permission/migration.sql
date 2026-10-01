-- #658: a dedicated, separately granted permission for the coordinator health
-- view (ADR 0005 Addendum C). No data is added or moved; no role gets it by default.
ALTER TYPE "EventPermission" ADD VALUE IF NOT EXISTS 'VIEW_HEALTH_INFORMATION';
