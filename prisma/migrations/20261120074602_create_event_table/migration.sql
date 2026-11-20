-- CreateTable
CREATE TABLE "Event" (
    "shop" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "chartId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "size" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Event_pkey" PRIMARY KEY ("shop","id")
);

-- CreateIndex
CREATE INDEX "Event_shop_createdAt_idx" ON "Event"("shop", "createdAt");
