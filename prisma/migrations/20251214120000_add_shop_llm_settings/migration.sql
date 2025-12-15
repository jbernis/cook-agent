-- CreateTable
CREATE TABLE "ShopLlmSettings" (
  "shop" TEXT NOT NULL PRIMARY KEY,
  "llmProvider" TEXT NOT NULL DEFAULT 'anthropic',
  "defaultModel" TEXT,
  "anthropicApiKeyEnc" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);

