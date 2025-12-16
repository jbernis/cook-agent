# Estimation du stockage et des coûts pour les conversations

## 📊 Situation actuelle (SQLite)

- **Taille totale** : ~2 MB (1.7 MB sur disque)
- **Conversations** : 56
- **Messages** : 580
- **Sessions** : 1

### Métriques moyennes

- **Taille par conversation** : ~35 KB
- **Taille par message** : ~3.4 KB
- **Messages par conversation** : ~10.4 messages

## 📈 Projections de croissance

### Scénario 1 : Petite utilisation (100 conversations/mois)
- **100 conversations/mois** × 10 messages = **1,000 messages/mois**
- **Croissance** : ~35 KB × 100 = **3.5 MB/mois**
- **Après 1 an** : ~42 MB
- **Après 5 ans** : ~210 MB

### Scénario 2 : Utilisation moyenne (1,000 conversations/mois)
- **1,000 conversations/mois** × 10 messages = **10,000 messages/mois**
- **Croissance** : ~35 KB × 1,000 = **35 MB/mois**
- **Après 1 an** : ~420 MB
- **Après 5 ans** : ~2.1 GB

### Scénario 3 : Grande utilisation (10,000 conversations/mois)
- **10,000 conversations/mois** × 10 messages = **100,000 messages/mois**
- **Croissance** : ~35 KB × 10,000 = **350 MB/mois**
- **Après 1 an** : ~4.2 GB
- **Après 5 ans** : ~21 GB

## 💰 Coûts estimés par plateforme PostgreSQL

### Neon (recommandé pour Cloudflare)

**Plan Free** :
- **Stockage gratuit** : 3 GB
- **Coût après** : $0.10/GB/mois
- **Scénario 1** (42 MB/an) : **Gratuit** ✅
- **Scénario 2** (420 MB/an) : **Gratuit** ✅
- **Scénario 3** (4.2 GB/an) : **~$0.12/mois** après la limite gratuite

**Plan Launch** ($19/mois) :
- **Stockage inclus** : 10 GB
- **Scénario 1-2** : Inclus dans le plan
- **Scénario 3** : Inclus dans le plan

### Supabase

**Plan Free** :
- **Stockage gratuit** : 500 MB
- **Coût après** : $0.125/GB/mois
- **Scénario 1** (42 MB/an) : **Gratuit** ✅
- **Scénario 2** (420 MB/an) : **Gratuit** ✅
- **Scénario 3** (4.2 GB/an) : **~$0.46/mois** après la limite gratuite

**Plan Pro** ($25/mois) :
- **Stockage inclus** : 8 GB
- **Scénario 1-2** : Inclus dans le plan
- **Scénario 3** : Inclus dans le plan

### Railway

**Plan Hobby** ($5/mois) :
- **Stockage inclus** : 5 GB
- **Coût après** : $0.25/GB/mois
- **Scénario 1-2** : Inclus dans le plan
- **Scénario 3** : **~$0.55/mois** supplémentaire après 5 GB

### Vercel Postgres

**Plan Hobby** ($20/mois) :
- **Stockage inclus** : 256 GB
- **Scénario 1-3** : Inclus dans le plan ✅

## 🎯 Recommandations

### Pour démarrer (petite/moyenne utilisation)
1. **Neon Free** : Parfait pour commencer, 3 GB gratuits
2. **Supabase Free** : Alternative solide, 500 MB gratuits

### Pour une utilisation importante
1. **Neon Launch** ($19/mois) : 10 GB inclus, excellent rapport qualité/prix
2. **Vercel Postgres** ($20/mois) : 256 GB inclus, idéal si vous utilisez déjà Vercel

### Optimisations possibles

#### 1. Archivage automatique
```sql
-- Supprimer les conversations de plus de 2 ans
DELETE FROM Conversation 
WHERE updatedAt < NOW() - INTERVAL '2 years';
```

#### 2. Compression des messages
Les messages sont stockés en JSON. Vous pourriez compresser les anciens messages.

#### 3. Limite de messages par conversation
Limiter à 50-100 messages par conversation, archiver les anciennes.

#### 4. Nettoyage périodique
```sql
-- Supprimer les conversations inactives depuis 6 mois
DELETE FROM Conversation 
WHERE updatedAt < NOW() - INTERVAL '6 months'
AND id NOT IN (
  SELECT DISTINCT conversationId 
  FROM CustomerToken 
  WHERE expiresAt > NOW()
);
```

## 📝 Notes importantes

1. **Les messages peuvent être plus volumineux** si vous stockez :
   - Des réponses longues de l'IA
   - Des données de produits (JSON)
   - Des états de recettes complexes

2. **PostgreSQL est plus efficace** que SQLite pour :
   - Les grandes quantités de données
   - Les requêtes complexes
   - La compression automatique

3. **Les index** prennent aussi de l'espace (~10-20% de la taille des données)

## 🔍 Monitoring recommandé

Surveillez la taille de votre base :
```sql
-- Taille totale de la base
SELECT pg_size_pretty(pg_database_size('votre_db'));

-- Taille par table
SELECT 
  schemaname,
  tablename,
  pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) AS size
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC;
```

## ✅ Conclusion

Pour la plupart des cas d'usage :
- **Démarrage** : Plan gratuit (Neon/Supabase) suffit largement
- **Croissance** : Plans à $19-25/mois couvrent facilement plusieurs années
- **Coûts** : Très raisonnables même avec beaucoup de conversations

Les conversations sont relativement légères (~35 KB chacune), donc même avec des milliers de conversations, les coûts restent très bas.

