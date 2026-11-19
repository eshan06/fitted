-- CreateTable
CREATE TABLE "Shop" (
    "shop" TEXT NOT NULL PRIMARY KEY,
    "plan" TEXT NOT NULL,
    "planCheckedAt" DATETIME,
    "planOnStore" TEXT,
    "resolvedAt" DATETIME
);
