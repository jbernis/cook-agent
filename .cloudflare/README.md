# Déploiement sur Cloudflare

Ce guide explique comment déployer l'application Shopify sur Cloudflare Pages/Workers.

## Prérequis

1. Un compte Cloudflare
2. Wrangler CLI installé: `npm install -g wrangler`
3. Une base de données PostgreSQL (Cloudflare D1, Neon, Supabase, ou autre)

## Étapes de déploiement

### 1. Authentification Cloudflare

```bash
wrangler login
```

### 2. Configuration de la base de données

L'application utilise actuellement SQLite, mais Cloudflare nécessite PostgreSQL.

**Option A: Cloudflare D1 (recommandé pour Cloudflare)**
```bash
# Créer une base de données D1
wrangler d1 create cook-agent-db

# Appliquer les migrations
wrangler d1 execute cook-agent-db --file=./prisma/migrations/...
```

**Option B: Base de données PostgreSQL externe (Neon, Supabase, etc.)**
- Créer une base de données PostgreSQL
- Mettre à jour `DATABASE_URL` dans les variables d'environnement

### 3. Configuration des variables d'environnement

Définir les secrets dans Cloudflare:

```bash
# Secrets Shopify
wrangler secret put SHOPIFY_API_KEY
wrangler secret put SHOPIFY_API_SECRET
wrangler secret put SHOPIFY_APP_URL

# Base de données (si PostgreSQL externe)
wrangler secret put DATABASE_URL

# Autres variables
wrangler secret put SCOPES
wrangler secret put REDIRECT_URL
wrangler secret put SHOPIFY_ALLOWED_SHOPS  # Optionnel
```

Ou via le Cloudflare Dashboard:
- Workers & Pages > Votre app > Settings > Variables

### 4. Build et déploiement

```bash
# Build de l'application
npm run build

# Déploiement sur Cloudflare Pages
wrangler pages deploy build/client --project-name=cook-agent

# Ou pour Cloudflare Workers
wrangler deploy
```

### 5. Configuration du domaine personnalisé (optionnel)

Dans Cloudflare Dashboard:
1. Workers & Pages > Votre app > Custom domains
2. Ajouter votre domaine
3. Mettre à jour `SHOPIFY_APP_URL` avec le nouveau domaine

### 6. Mise à jour de l'URL dans Shopify

```bash
shopify app config use
# Mettre à jour application_url avec votre URL Cloudflare
```

## Migration de SQLite vers PostgreSQL

1. Mettre à jour `prisma/schema.prisma`:
```prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}
```

2. Générer le client Prisma:
```bash
npx prisma generate
```

3. Appliquer les migrations:
```bash
npx prisma migrate deploy
```

## Notes importantes

- Cloudflare Workers a des limites de CPU (50ms par défaut)
- Les fichiers système ne sont pas accessibles (pas de SQLite)
- Utiliser Cloudflare D1 ou une base de données externe
- Les variables d'environnement doivent être définies comme secrets
