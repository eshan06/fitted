-- CreateTable
CREATE TABLE "Job" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "progress" JSONB,
    "result" JSONB,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Job_shop_kind_createdAt_idx" ON "Job"("shop", "kind", "createdAt");

-- CreateIndex
CREATE INDEX "Job_status_updatedAt_idx" ON "Job"("status", "updatedAt");
