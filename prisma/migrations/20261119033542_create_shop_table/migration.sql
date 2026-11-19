-- CreateTable
CREATE TABLE "Shop" (
    "shop" TEXT NOT NULL,
    "plan" TEXT NOT NULL,
    "planCheckedAt" TIMESTAMP(3),
    "planOnStore" TEXT,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "Shop_pkey" PRIMARY KEY ("shop")
);
