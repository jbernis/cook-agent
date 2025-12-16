# Déploiement rapide sur Cloudflare

Guide rapide en 5 minutes pour déployer votre app sur Cloudflare.

## ⚡ Déploiement rapide

### 1. Prérequis (2 min)

```bash
# Installer Wrangler
npm install -g wrangler

# Se connecter à Cloudflare
wrangler login
```

### 2. Base de données PostgreSQL (3 min)

**Option rapide: Neon (gratuit)**
1. Aller sur https://neon.tech
2. Créer un compte et une base de données
3. Copier l'URL de connexion (DATABASE_URL)

**Migrer le schéma:**
```bash
# Copier le schéma PostgreSQL
cp prisma/schema.postgresql.prisma prisma/schema.prisma

# Générer le client Prisma
npx prisma generate

# Appliquer les migrations
npx prisma migrate deploy
```

### 3. Configuration des secrets (2 min)

```bash
# Secrets Shopify (obligatoires)
wrangler secret put SHOPIFY_API_KEY
wrangler secret put SHOPIFY_API_SECRET
wrangler secret put SHOPIFY_APP_URL  # Sera mis à jour après le déploiement
wrangler secret put SCOPES
wrangler secret put REDIRECT_URL

# Base de données
wrangler secret put DATABASE_URL

# Optionnel: Liste des magasins autorisés
wrangler secret put SHOPIFY_ALLOWED_SHOPS
```

### 4. Déploiement (1 min)

```bash
# Build et déploiement
npm run deploy:cloudflare
```

L'URL de votre app sera affichée (ex: `https://cook-agent.pages.dev`)

### 5. Mise à jour de l'URL (1 min)

```bash
# Mettre à jour SHOPIFY_APP_URL avec l'URL Cloudflare
wrangler secret put SHOPIFY_APP_URL

# Mettre à jour la configuration Shopify
shopify app config use
```

Mettez à jour:
- `application_url`: Votre URL Cloudflare
- `redirect_urls`: `["https://votre-url.pages.dev/api/auth"]`

## ✅ C'est fait!

Votre app est maintenant déployée sur Cloudflare.

Pour plus de détails, consultez [DEPLOYMENT.md](../DEPLOYMENT.md).

