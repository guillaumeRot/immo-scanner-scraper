# Instructions — Migration des scrapers Playwright → fetch

## Contexte

Ce projet scrape des sites immobiliers français. Tous les scrapers utilisaient Playwright/Crawlee, ce qui consomme ~300MB RAM et ~30s de démarrage par scraper (instance Chromium).

L'objectif est de migrer chaque scraper vers `fetch` + `cheerio` quand c'est possible, et de garder Playwright uniquement pour les sites vraiment JS-heavy.

**Déjà migrés :** Kermarrec (fetch+cheerio), ERA (fetch+JSON ng-state)
**Playwright optimisé :** Blot (trop AJAX pour fetch, mais optimisé)

---

## Méthodologie d'analyse pour chaque scraper

### Étape 1 — Lire le scraper existant

Lire `src/sites/<nom>.js` pour identifier :
- L'URL de la page de liste
- Les sélecteurs CSS utilisés
- S'il y a une soumission de formulaire ou de l'interaction utilisateur
- Les sélecteurs de pagination

### Étape 2 — Tester si le site est SSR (Server-Side Rendered)

```bash
curl -s "<URL_LISTE>" -A "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" | grep -c "<selecteur_annonces>"
```

- **Résultat > 0** → SSR confirmé, migration possible vers fetch+cheerio
- **Résultat = 0** → contenu chargé en JS, approfondir l'analyse

### Étape 3a — Si SSR : migrer vers fetch+cheerio

Installer cheerio si pas déjà fait : `npm install cheerio --save`

Pattern de migration à suivre (voir `src/sites/kermarrec.js` comme référence) :

```js
import * as cheerio from "cheerio";

async function fetchHtml(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${url}`);
  return res.text();
}

// Page liste : extraire liens + URL page suivante
// Page détail : extraire tous les champs avec les sélecteurs cheerio

export const xyzScraper = async () => {
  const liensActuels = [];
  let currentUrl = LIST_URL;

  while (currentUrl) {
    const { links, nextUrl } = await scrapeListPage(currentUrl);
    for (const url of links) {
      try {
        const data = await scrapeDetailPage(url);
        if (data.ville && data.prix) {
          await insertAnnonce({ ...data, agence: "XYZ", lien: url });
          liensActuels.push(url);
        } else {
          await insertErreur("XYZ", url, "Données incomplètes");
        }
      } catch (err) {
        await insertErreur("XYZ", url, String(err));
      }
    }
    currentUrl = nextUrl;
  }

  await deleteMissingAnnonces("XYZ", [...new Set(liensActuels)]);
};
```

**Points d'attention cheerio :**
- Les images avec lazy loading ont leur URL dans `data-lazy-src`, pas `src` (qui contient un SVG placeholder). Toujours vérifier : `$(el).attr("data-lazy-src") || $(el).attr("src")`
- Utiliser `.not(".text-blue")` ou `.first()` pour cibler le bon élément quand un sélecteur matche plusieurs fois

### Étape 3b — Si JS-heavy : chercher une API JSON

Beaucoup de sites JS (React/Angular) font des appels API que l'on peut reproduire directement.

**Chercher dans le HTML une donnée JSON embarquée :**
```bash
curl -s "<URL_DETAIL>" -A "Mozilla/5.0..." | grep -c "ng-state\|__NEXT_DATA__\|window\.__"
```

- **`ng-state`** (Angular SSR) → extraire avec regex puis `JSON.parse` :
  ```js
  const match = html.match(/<script id="ng-state" type="application\/json">([^<]+)<\/script>/);
  const state = JSON.parse(match[1]);
  // Chercher la clé qui contient l'objet annonce (pas un tableau)
  for (const key of Object.keys(state)) {
    const val = state[key]?.b?.data;
    if (val && !Array.isArray(val) && val.surface_habitable !== undefined) { ... }
  }
  ```
  Voir `src/sites/era.js` comme référence.

- **`__NEXT_DATA__`** (Next.js) → `JSON.parse(document.getElementById('__NEXT_DATA__').textContent)`

**Chercher des appels API dans le JS du site :**
```bash
curl -s "<URL_JS>" | grep -oP '(fetch|ajax|XHR|url)[^;]{0,150}' | grep -i "api\|search\|annonce"
```

### Étape 4 — Tester avant d'écrire

Toujours valider l'extraction dans un script Node standalone avant de modifier le fichier :

```bash
node --input-type=module <<'EOF'
import * as cheerio from "cheerio";
// ... test de l'extraction sans DB
EOF
```

Vérifier que **tous les champs** sont bien extraits : prix, ville, surface, pièces, chambres, description, photos, dpe, ges.

### Étape 5 — Si le site est vraiment JS-only (pas d'API, AJAX complexe)

→ **Garder Playwright** mais optimiser le scraper existant.

---

## Optimisations Playwright à appliquer systématiquement

Quand Playwright est inévitable, appliquer ces 4 optimisations :

### 1. Bloquer les ressources inutiles

```js
preNavigationHooks: [
  async ({ blockRequests }) => {
    await blockRequests({
      urlPatterns: [
        ".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg",
        ".css", ".woff", ".woff2", ".ttf",
        "google-analytics", "googletagmanager", "hotjar",
        "mapbox", "facebook", "doubleclick",
      ],
    });
  },
],
```

### 2. Remplacer `waitForLoadState("networkidle")` par `waitForSelector`

```js
// ❌ Lent — attend que TOUTES les requêtes réseau cessent (analytics, maps...)
await page.waitForLoadState("networkidle", { timeout: 60000 });

// ✅ Rapide — attend juste l'élément utile
await page.waitForSelector('.ma-classe-annonce', { timeout: 15000 });
```

### 3. Corriger les `Promise.all` avec `await` à l'intérieur

```js
// ❌ Bug — le await avant Promise.all le rend séquentiel
await Promise.all([
  await page.waitForLoadState("networkidle"),
  nextButton.click()
]);

// ✅ Correct — les deux s'exécutent en parallèle
await Promise.all([
  page.waitForSelector('.annonce', { timeout: 10000 }),
  nextButton.click(),
]);
```

### 4. Supprimer les `waitForTimeout` fixes

```js
// ❌ Sleep arbitraire
await page.waitForTimeout(2000);

// ✅ Attendre un signal précis (si vraiment nécessaire pour un dropdown)
await page.waitForSelector('.ui-menu-item', { timeout: 5000 });
```

---

## Résultats de la migration

| Scraper | Avant | Après | Gain |
|---|---|---|---|
| Kermarrec | Playwright | fetch+cheerio | ~300MB RAM, ~30s |
| ERA | Playwright | fetch+JSON (ng-state) | ~300MB RAM, ~30s |
| Blot | Playwright | Playwright optimisé | ~2x plus rapide |
| Carnot | Playwright | fetch+cheerio | ~300MB RAM, ~30s |

---

## Commandes utiles

```bash
# Tester un scraper en local
curl "http://localhost:8080/run-scrapers?scraper=<nom>"

# Démarrer le serveur
npm start

# Vérifier si un site est SSR
curl -s "<URL>" -A "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" | grep -c "<selecteur>"

# Récupérer les URLs de la page liste
curl -s "<URL>" -A "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" | grep -oP 'href="([^"]*annonce[^"]*)"' | head -10
```

---

## Sites restants à analyser

Dans `src/sites/` : `boyer.js`, `bretilimmo.js`, `diard.js`, `penn.js`, `century.js`, `notaires-bretons.js`, `immobilier-notaires.js`, `immonot.js`, `fnaim.js`, `acheter-louer.js`, `bien-ici.js`, `logic-immo.js`, `ouest-france.js`, `immobilier-figaro.js`

Les petites agences locales (Boyer, Bretilimmo, Carnot, Diard, Penn) sont probablement des sites WordPress/SSR → bons candidats pour fetch+cheerio.

Les grandes plateformes (BienIci, Figaro, Logic-Immo, AcheterLouer) sont des SPAs React/Angular → chercher l'API JSON ou le ng-state/__NEXT_DATA__.
