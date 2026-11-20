-- CreateTable
CREATE TABLE "ChartVersion" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "chartId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "by" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,

    CONSTRAINT "ChartVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ChartVersion_shop_chartId_createdAt_idx" ON "ChartVersion"("shop", "chartId", "createdAt");
