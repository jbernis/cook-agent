## scripts/

Small local helpers (dev only).

### Check saved LLM settings (SQLite)

DB path: `prisma/dev.sqlite`

List all shops:

```bash
sqlite3 prisma/dev.sqlite "SELECT shop, llmProvider, defaultModel, anthropicApiKeyHint, length(anthropicApiKeyEnc) AS enc_len FROM ShopLlmSettings;"
```

Check one shop:

```bash
sqlite3 prisma/dev.sqlite "SELECT shop, llmProvider, defaultModel, anthropicApiKeyHint, length(anthropicApiKeyEnc) AS enc_len FROM ShopLlmSettings WHERE shop='dev-gusto.myshopify.com' LIMIT 1;"
```

Include OpenAI/Gemini columns too:

```bash
sqlite3 prisma/dev.sqlite "SELECT shop, llmProvider, defaultModel, anthropicApiKeyHint, length(anthropicApiKeyEnc) AS anthropic_enc_len, openaiApiKeyHint, length(openaiApiKeyEnc) AS openai_enc_len, geminiApiKeyHint, length(geminiApiKeyEnc) AS gemini_enc_len FROM ShopLlmSettings;"
```

### Check saved LLM settings (Node script)

Prints provider/model + whether an encrypted key blob exists + stored obfuscated hint (never prints the real key).

```bash
node scripts/check-llm-settings.mjs
```

Filter to a shop:

```bash
node scripts/check-llm-settings.mjs dev-gusto.myshopify.com
```

Verify the hint matches the last 8 chars of your key:

```bash
node scripts/check-llm-settings.mjs dev-gusto.myshopify.com KEHTpgAA
```
