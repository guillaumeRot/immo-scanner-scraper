# Liste des villes à cibler

🏙 Vitré
🏙 Chateaugiron

💰 Budget maximum: 400 000 €

🏠 Type bien: Maison et Immeuble

# Liste des agences immobilières

✅ Kermarrec: Vitré / Chateaugiron
⌛ Laforet (pas de résultats pour l'instant)
✅ ERA
✅ Blot
✅ Carnot
✅ Penn immobilier
✅ Diard
✅ Century 21
✅ Bretil'immo
✅ Boyer
✅ FNAIM
⌛ Square habitat (pas de résultats pour l'instant)

# Liste des sites de notaires

✅ Immonot: Vitré / Chateaugiron (prend toutes villes lors du scrap complet)
✅ Notaires et bretons
✅ immobilier.notaires.fr

# Liste des sites d'annonces

⌛ Leboncoin(trop complexe de bypass les 403)
⌛ SeLoger(trop complexe de bypass les 403)
⛔ OuestFranceImmo (désactivé — nécessite Playwright + stealth, incompatible Vercel)
✅ BienIci
⌛ PAP (résultat des annonces bizarre)

⛔ LogicImmo (désactivé — DataDome, incompatible Vercel)
✅ acheter-louer.fr
⌛ proprietes-privees.com (pas de résultats pour l'instant)
⛔ immobilier.lefigaro.com (désactivé — Cloudflare Bot Management, incompatible Vercel)

---

# Méthodes de scraping


| Scraper                 | Méthode                   | Détail                                                                                |
| ----------------------- | -------------------------- | -------------------------------------------------------------------------------------- |
| **Kermarrec**           | fetch + cheerio            | Site SSR WordPress                                                                     |
| **ERA**                 | fetch + cheerio + ng-state | Liste SSR, détail via JSON embarqué Angular (`ng-state`)                             |
| **Acheter-louer**       | fetch + cheerio + API JSON | Liste SSR cheerio, détail via`api-v5.acheter-louer.fr` (FeathersJS)                   |
| **Bien-ici**            | fetch + API JSON           | Pagination via`realEstateAds.json` (API publique)                                      |
| **Immobilier-notaires** | fetch + API JSON           | API REST`ws.immobilier.notaires.fr`                                                    |
| **Carnot**              | fetch + cheerio            | Site SSR                                                                               |
| **Diard**               | fetch + cheerio            | Site SSR                                                                               |
| **Boyer**               | fetch + cheerio            | Site SSR                                                                               |
| **Bretil'immo**         | fetch + cheerio            | Site SSR                                                                               |
| **Century 21**          | fetch + cheerio            | Site SSR                                                                               |
| **Penn**                | fetch + cheerio            | Site SSR                                                                               |
| **Notaires-bretons**    | fetch + cheerio            | Site SSR                                                                               |
| **Blot**                | fetch + API AJAX interne   | Rejoue les appels `admin-ajax.php` du plugin `blot-search` (town_search → search_form_validate → search_form_get_results → clean_vendus → view_result), aucun navigateur nécessaire |
| **Immonot**             | fetch + cheerio + JSON-LD  | Site SSR, données structurées `BuyAction` + libellés `.props-realty__item`             |
| **FNAIM**               | fetch + cheerio            | Site SSR — URL de recherche directe avec paramètres encodés                         |

## Scrapers désactivés (Playwright requis)

Ces 3 scrapers ne tournent plus dans le déploiement Vercel : ils nécessitent un vrai navigateur
(protection anti-bot avec challenge JS), incompatible avec une fonction serverless. Le code reste
dans `src/sites/` pour référence mais n'est plus importé par `src/app.js`.

| Site                  | Protection                    | Détail                                                                 |
| ---------------------- | ------------------------------ | ----------------------------------------------------------------------- |
| **Logic-immo**         | DataDome                       | Challenge JS, aucun contournement fiable trouvé                        |
| **Immobilier-Figaro**  | Cloudflare Bot Management      | Challenge JS (`__cf_bm`), aucun contournement fiable trouvé            |
| **Ouest-France Immo**  | Challenge maison (détection headless) | Un vrai Chrome headless est bloqué ; seul un navigateur headless "stealth" (`playwright-extra` + plugin stealth) passe — jugé trop fragile pour un scraper automatisé sans surveillance |

## Sites bloqués (non scrapables)


| Site      | Protection           | Raison                                                   |
| --------- | -------------------- | -------------------------------------------------------- |
| LeBonCoin | DataDome             | Tous les endpoints bloqués (site, API interne, RSS)     |
| SeLoger   | DataDome             | Tous les endpoints bloqués (même stack que Logic-Immo) |
| PAP       | Cloudflare Turnstile | Challenge JS non contournable sans browser réel         |
