-- Uniform ordering (#497): uniforms join the club order layer (#487) as a
-- second source of "needs". A uniform need is a ClubOrderNeed row for one
-- member and one sized ClubSupplyItem (each size is its own catalog item), so
-- it flows through the same order batches, stock math, locks, exports and
-- audit as honors. The status path needed -> ordered -> received -> issued is
-- the existing NEEDED -> ORDERED -> RECEIVED -> AWARDED. The only schema change
-- is the new source type.
-- Hand-written; matches `prisma migrate diff` against the schema exactly.

-- AlterEnum (PostgreSQL 12+ allows this in a transaction; the new value is not used here)
ALTER TYPE "ClubOrderSourceType" ADD VALUE 'UNIFORM';
