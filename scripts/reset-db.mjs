#!/usr/bin/env node
/**
 * Script pour tronquer/réinitialiser la base de données SQLite
 * Usage: node scripts/reset-db.mjs
 */

import { PrismaClient } from "@prisma/client";
import { existsSync, unlinkSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const dbPath = join(__dirname, "..", "prisma", "dev.sqlite");

const prisma = new PrismaClient();

async function resetDatabase() {
  try {
    console.log("🔄 Réinitialisation de la base de données...");

    // Méthode 1: Supprimer toutes les données avec Prisma (recommandé)
    console.log("📝 Suppression des données de toutes les tables...");
    
    // Supprimer dans l'ordre pour respecter les contraintes de clés étrangères
    await prisma.message.deleteMany({});
    console.log("  ✓ Messages supprimés");
    
    await prisma.conversation.deleteMany({});
    console.log("  ✓ Conversations supprimées");
    
    await prisma.customerToken.deleteMany({});
    console.log("  ✓ Customer tokens supprimés");
    
    await prisma.codeVerifier.deleteMany({});
    console.log("  ✓ Code verifiers supprimés");
    
    await prisma.customerAccountUrls.deleteMany({});
    console.log("  ✓ Customer account URLs supprimées");
    
    // Note: ShopLlmSettings et Session peuvent être conservés selon vos besoins
    // Décommentez les lignes suivantes si vous voulez aussi les supprimer :
    // await prisma.shopLlmSettings.deleteMany({});
    // console.log("  ✓ Shop LLM settings supprimés");
    // await prisma.session.deleteMany({});
    // console.log("  ✓ Sessions supprimées");

    console.log("\n✅ Base de données réinitialisée avec succès !");
    
    // Méthode 2 alternative: Supprimer complètement le fichier SQLite
    // Décommentez les lignes suivantes si vous préférez cette méthode :
    /*
    if (existsSync(dbPath)) {
      unlinkSync(dbPath);
      console.log("  ✓ Fichier SQLite supprimé");
      console.log("\n⚠️  Vous devrez exécuter 'npm run setup' ou 'npx prisma migrate deploy' pour recréer la base");
    }
    */
    
  } catch (error) {
    console.error("❌ Erreur lors de la réinitialisation:", error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

resetDatabase();
