import { useLoaderData } from "react-router";

const I18N = {
  en: {
    titleBar: "Shop chat agent",
    heading: "Storefront chat agent for your French store",
    intro:
      "This app adds a chat bubble to your storefront. The agent can answer questions, recommend products, and (optionally) use Shopify MCP tools depending on your setup.",
    nextStepHeading: "Next step",
    nextStepTitle: "Enable the theme extension in your theme editor",
    nextStepBody:
      "In Shopify admin: Online Store → Themes → Customize → App embeds (or App blocks) → enable the chat bubble, then Save.",
    goToSettings: "Open Settings",
    goToDocs: "Theme editor instructions",
    themeHelpHref: "https://help.shopify.com/en/manual/online-store/themes",
    whatYouGetHeading: "What this app does",
    whatYouGetPoints: [
      "Shows a branded chat bubble on your storefront",
      "Streams responses from your configured LLM provider",
      "Can connect to Shopify MCP tools (catalog search, product details, etc.)",
    ],
    quickStartHeading: "Quick start",
    quickStartSteps: [
      "Enable the theme extension in the theme editor",
      "Add the block to your theme (or enable the app embed), then Save",
      "Open your storefront and test the chat bubble end-to-end",
    ],
    resourcesHeading: "Resources",
    resources: [
      { label: "Polaris web components", href: "https://shopify.dev/docs/api/app-home/using-polaris-components" },
      { label: "Admin GraphQL API", href: "https://shopify.dev/docs/api/admin-graphql" },
      { label: "Theme editor (help)", href: "https://help.shopify.com/en/manual/online-store/themes" },
    ],
  },
  fr: {
    titleBar: "Agent de chat boutique",
    heading: "Un agent de chat sur votre boutique en ligne",
    intro:
      "Cette application ajoute une bulle de chat sur votre boutique. L’agent peut répondre aux questions, recommander des produits et (optionnellement) utiliser des outils Shopify MCP selon votre configuration.",
    nextStepHeading: "Étape suivante",
    nextStepTitle: "Activez l’extension de thème dans l’éditeur de thème",
    nextStepBody:
      "Dans l’admin Shopify : Boutique en ligne → Thèmes → Personnaliser → Intégrations d’app (ou Blocs d’app) → activez la bulle de chat, puis Enregistrer.",
    goToSettings: "Ouvrir les réglages",
    goToDocs: "Instructions (éditeur de thème)",
    themeHelpHref: "https://help.shopify.com/fr/manual/online-store/themes",
    whatYouGetHeading: "À quoi sert l’app",
    whatYouGetPoints: [
      "Affiche une bulle de chat sur votre boutique",
      "Diffuse les réponses depuis votre fournisseur LLM configuré",
      "Peut se connecter à des outils Shopify MCP (recherche catalogue, détails produit, etc.)",
    ],
    quickStartHeading: "Démarrage rapide",
    quickStartSteps: [
      "Activez l’extension de thème dans l’éditeur de thème",
      "Ajoutez le bloc à votre thème (ou activez l’intégration), puis Enregistrer",
      "Ouvrez votre boutique et testez la bulle de chat de bout en bout",
    ],
    resourcesHeading: "Ressources",
    resources: [
      { label: "Composants web Polaris", href: "https://shopify.dev/docs/api/app-home/using-polaris-components" },
      { label: "API Admin GraphQL", href: "https://shopify.dev/docs/api/admin-graphql" },
      { label: "Aide : éditeur de thème", href: "https://help.shopify.com/fr/manual/online-store/themes" },
    ],
  },
};

function detectLocaleFromRequest(request) {
  const header = String(request?.headers?.get?.("Accept-Language") || "").toLowerCase();
  if (header.includes("fr")) return "fr";
  return "en";
}

export const loader = async ({ request }) => {
  const { authenticate } = await import("../shopify.server");
  await authenticate.admin(request);

  const locale = detectLocaleFromRequest(request);
  return { locale };
};

export default function Index() {
  const { locale } = useLoaderData();
  const t = I18N[locale] || I18N.fr;

  const embeddedSearch =
    (typeof window !== "undefined" && typeof window.location?.search === "string")
      ? window.location.search
      : "";

  return (
    <s-page>
      <ui-title-bar title={t.titleBar} />

      <s-section>
        <s-stack gap="base">
          <s-heading>{t.heading}</s-heading>
          <s-paragraph>{t.intro}</s-paragraph>

          <div
            style={{
              border: "1px solid var(--p-color-border, #e5e7eb)",
              borderRadius: 12,
              padding: 14,
              background: "var(--p-color-bg-surface, #ffffff)",
              display: "grid",
              gap: 10,
              maxWidth: 760,
            }}
          >
            <div style={{ fontWeight: 650 }}>{t.nextStepTitle}</div>
            <div style={{ opacity: 0.9 }}>{t.nextStepBody}</div>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <s-link href={`/app/settings${embeddedSearch}`}>{t.goToSettings}</s-link>
              <s-link
                href={t.themeHelpHref}
                target="_blank"
              >
                {t.goToDocs}
              </s-link>
            </div>
          </div>

          <div style={{ display: "grid", gap: 10, maxWidth: 760 }}>
            <div style={{ fontWeight: 650 }}>{t.whatYouGetHeading}</div>
            <ul style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 6 }}>
              {t.whatYouGetPoints.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </div>
        </s-stack>
      </s-section>

      <s-section heading={t.quickStartHeading} slot="aside">
        <div style={{ display: "grid", gap: 10 }}>
          <div style={{ fontWeight: 650 }}>{t.nextStepHeading}</div>
          <ol style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 8 }}>
            {t.quickStartSteps.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
        </div>
      </s-section>

      <s-section heading={t.resourcesHeading} slot="aside">
        <div style={{ display: "grid", gap: 8 }}>
          {t.resources.map((r) => (
            <s-paragraph key={r.href}>
              <s-link href={r.href} target="_blank">
                {r.label}
              </s-link>
            </s-paragraph>
          ))}
        </div>
      </s-section>
    </s-page>
  );
}
