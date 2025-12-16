/**
 * Point d'entrée Cloudflare Worker pour React Router
 * 
 * Ce fichier est utilisé pour déployer l'application sur Cloudflare Workers.
 * Pour Cloudflare Pages, React Router génère automatiquement le worker.
 */

import { createRequestHandler } from "@react-router/node";

// Import du build React Router
// Note: Ce fichier sera généré lors du build
// import * as build from "./build/server/index.js";

// Pour Cloudflare Pages, le worker est généré automatiquement.
// Pour Cloudflare Workers uniquement, décommentez et adaptez:

/*
export default {
  async fetch(request, env, ctx) {
    const handler = createRequestHandler(build, "production");
    return handler(request);
  },
};
*/

// Note: Cloudflare Pages génère automatiquement le worker à partir du build React Router.
// Ce fichier est fourni à titre d'exemple pour un déploiement Workers personnalisé.

