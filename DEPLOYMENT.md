# Guide de déploiement sur Cloudflare

Ce guide vous accompagne pour déployer votre application Shopify sur Cloudflare Pages/Workers.

## 📋 Prérequis

- Compte Cloudflare
- Node.js >= 20.10
- Wrangler CLI installé globalement: `npm install -g wrangler`
- Base de données PostgreSQL (Cloudflare D1, Neon, Supabase, Railway, etc.)

## 🚀 Étapes de déploiement

### 1. Installation de Wrangler

```bash
npm install -g wrangler
```

### 2. Authentification Cloudflare

```bash
wrangler login
```

Cela ouvrira votre navigateur pour vous connecter à Cloudflare.

### 3. Migration de la base de données

⚠️ **Important**: L'application utilise actuellement SQLite, mais Cloudflare nécessite PostgreSQL.

#### Option A: Cloudflare D1 (recommandé)

Cloudflare D1 est une base de données SQLite distribuée, mais pour Prisma, il vaut mieux utiliser PostgreSQL.

#### Option B: Base de données PostgreSQL externe (recommandé)

**Services recommandés:**
- **Neon** (gratuit): https://neon.tech
- **Supabase** (gratuit): https://supabase.com
- **Railway** (gratuit): https://railway.app
- **Vercel Postgres**: https://vercel.com/storage/postgres

**Étapes:**

1. Créer une base de données PostgreSQL sur l'un de ces services
2. Récupérer l'URL de connexion (DATABASE_URL)
3. Mettre à jour le schéma Prisma:

```bash
# Copier le schéma PostgreSQL
cp prisma/schema.postgresql.prisma prisma/schema.prisma

# Ou éditer manuellement prisma/schema.prisma et changer:
# datasource db {
#   provider = "postgresql"
#   url      = env("DATABASE_URL")
# }
```

4. Générer le client Prisma:
```bash
npx prisma generate
```

5. Appliquer les migrations:
```bash
npx prisma migrate deploy
```

### 4. Configuration des variables d'environnement

Définir les secrets dans Cloudflare via Wrangler:

```bash
# Secrets Shopify (obligatoires)
wrangler secret put SHOPIFY_API_KEY
wrangler secret put SHOPIFY_API_SECRET
wrangler secret put SHOPIFY_APP_URL

# Base de données PostgreSQL
wrangler secret put DATABASE_URL

# Autres variables Shopify
wrangler secret put SCOPES
wrangler secret put REDIRECT_URL

# Optionnel: Liste des magasins autorisés
wrangler secret put SHOPIFY_ALLOWED_SHOPS
```

**Ou via le Cloudflare Dashboard:**
1. Aller sur https://dash.cloudflare.com
2. Workers & Pages > Votre app > Settings > Variables
3. Ajouter les variables d'environnement

### 5. Configuration de l'URL de l'application

Avant le premier déploiement, vous devez connaître l'URL de votre application Cloudflare.

**Pour Cloudflare Pages:**
- L'URL sera: `https://cook-agent.pages.dev` (ou votre domaine personnalisé)

**Pour Cloudflare Workers:**
- L'URL sera: `https://cook-agent.<votre-account-id>.workers.dev`

Mettez à jour `SHOPIFY_APP_URL` avec cette URL.

### 6. Build et déploiement

#### Option A: Cloudflare Pages (recommandé)

```bash
# Build
npm run build

# Déploiement
npm run deploy:cloudflare
# ou
wrangler pages deploy build/client --project-name=cook-agent
```

#### Option B: Cloudflare Workers

```bash
# Build
npm run build

# Déploiement
npm run deploy:cloudflare:workers
# ou
wrangler deploy
```

### 7. Configuration dans Shopify

Après le déploiement, mettez à jour la configuration Shopify:

```bash
shopify app config use
```

Mettez à jour:
- `application_url`: Votre URL Cloudflare (ex: `https://cook-agent.pages.dev`)
- `redirect_urls`: `["https://cook-agent.pages.dev/api/auth"]`

### 8. Configuration du domaine personnalisé (optionnel)

1. Dans Cloudflare Dashboard > Workers & Pages > Votre app
2. Aller dans l'onglet "Custom domains"
3. Cliquer sur "Set up a custom domain"
4. Ajouter votre domaine
5. Mettre à jour `SHOPIFY_APP_URL` avec le nouveau domaine
6. Mettre à jour la configuration Shopify

## 🔧 Configuration continue (CI/CD)

### GitHub Actions

Créez `.github/workflows/deploy-cloudflare.yml`:

```yaml
name: Deploy to Cloudflare

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - uses: actions/setup-node@v3
        with:
          node-version: '20'
          
      - name: Install dependencies
        run: npm ci
        
      - name: Build
        run: npm run build
        
      - name: Deploy to Cloudflare Pages
        uses: cloudflare/pages-action@v1
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          projectName: cook-agent
          directory: build/client
```

### Variables GitHub Secrets

Ajoutez dans GitHub > Settings > Secrets:
- `CLOUDFLARE_API_TOKEN`: Token API Cloudflare
- `CLOUDFLARE_ACCOUNT_ID`: ID de votre compte Cloudflare

## 📝 Variables d'environnement requises

| Variable | Description | Exemple |
|----------|-------------|---------|
| `SHOPIFY_API_KEY` | Clé API Shopify | `79c632d155fb4dffd9fb5faa9a0ed236` |
| `SHOPIFY_API_SECRET` | Secret API Shopify | `shpss_...` |
| `SHOPIFY_APP_URL` | URL de l'application | `https://cook-agent.pages.dev` |
| `DATABASE_URL` | URL PostgreSQL | `postgresql://user:pass@host:5432/db` |
| `SCOPES` | Scopes Shopify | `customer_read_customers,...` |
| `REDIRECT_URL` | URL de redirection OAuth | `https://cook-agent.pages.dev/api/auth` |
| `SHOPIFY_ALLOWED_SHOPS` | Magasins autorisés (optionnel) | `shop1.myshopify.com,shop2.myshopify.com` |

## ⚠️ Limitations Cloudflare

- **CPU Time**: 50ms par défaut (configurable dans `wrangler.toml`)
- **Memory**: 128 MB par défaut
- **Request Timeout**: 30 secondes pour Workers, 100 secondes pour Pages
- **File System**: Non accessible (pas de SQLite local)
- **Node.js APIs**: Certaines APIs Node.js ne sont pas disponibles

## 🐛 Dépannage

### Erreur: "Database connection failed"

- Vérifiez que `DATABASE_URL` est correctement configuré
- Vérifiez que la base de données PostgreSQL est accessible depuis Internet
- Vérifiez les migrations Prisma: `npx prisma migrate deploy`

### Erreur: "SHOPIFY_API_KEY is not defined"

- Vérifiez que tous les secrets sont définis: `wrangler secret list`
- Redéployez après avoir ajouté des secrets

### Erreur: "Build failed"

- Vérifiez que toutes les dépendances sont installées
- Vérifiez les logs de build: `npm run build`

## 📚 Ressources

- [Documentation Cloudflare Pages](https://developers.cloudflare.com/pages/)
- [Documentation Cloudflare Workers](https://developers.cloudflare.com/workers/)
- [Documentation Wrangler](https://developers.cloudflare.com/workers/wrangler/)
- [Documentation React Router](https://reactrouter.com/)
- [Documentation Shopify Apps](https://shopify.dev/docs/apps)

## 🆘 Support

Si vous rencontrez des problèmes:
1. Vérifiez les logs dans Cloudflare Dashboard
2. Vérifiez les logs de build localement
3. Consultez la documentation Cloudflare
4. Vérifiez les issues GitHub du projet

