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
⌛ FNAIM (instable)
⌛ Square habitat (pas de résultats pour l'instant)  

# Liste des sites de notaires

✅ Immonot: Vitré / Chateaugiron (prend toutes villes lors du scrap complet)  
✅ Notaires et bretons  
✅ immobilier.notaires.fr

# Liste des sites d'annonces

⌛ Leboncoin(trop complexe de bypass les 403)  
⌛ SeLoger(trop complexe de bypass les 403)  
⌛ OuestFranceImmo (assez long...)  
✅ BienIci  
⌛ PAP (résultat des annonces bizarre)  

✅ LogicImmo(a fonctionné mais retourne des 403 maintenant. Essayer en headful ?)  
✅ acheter-louer.fr  
⌛ proprietes-privees.com (pas de résultats pour l'instant)  
✅ immobilier.lefigaro.com  

---

# Méthodes de scraping

| Scraper | Méthode | Détail |
|---|---|---|
| **Kermarrec** | fetch + cheerio | Site SSR WordPress |
| **ERA** | fetch + cheerio + ng-state | Liste SSR, détail via JSON embarqué Angular (`ng-state`) |
| **Acheter-louer** | fetch + cheerio + API JSON | Liste SSR cheerio, détail via `api-v5.acheter-louer.fr` (FeathersJS) |
| **Bien-ici** | fetch + API JSON | Pagination via `realEstateAds.json` (API publique) |
| **Immobilier-notaires** | fetch + API JSON | API REST `ws.immobilier.notaires.fr` |
| **Carnot** | fetch + cheerio | Site SSR |
| **Diard** | fetch + cheerio | Site SSR |
| **Boyer** | fetch + cheerio | Site SSR |
| **Bretil'immo** | fetch + cheerio | Site SSR |
| **Century 21** | fetch + cheerio | Site SSR |
| **Penn** | fetch + cheerio | Site SSR |
| **Notaires-bretons** | fetch + cheerio | Site SSR |
| **Blot** | Playwright (optimisé) | SPA AJAX — ressources bloquées, `waitForSelector` au lieu de `networkidle` |
| **Logic-immo** | Playwright | DataDome présent, Playwright headless fonctionne parfois |
| **Immonot** | fetch + cheerio | Site SSR, URLs directes par ville/type |
| **FNAIM** | Playwright | JS-heavy (instable) |
| **Ouest-France** | Playwright | JS-heavy |
| **Immobilier-Figaro** | Playwright | JS-heavy |

## Sites bloqués (non scrapables)

| Site | Protection | Raison |
|---|---|---|
| LeBonCoin | DataDome | Tous les endpoints bloqués (site, API interne, RSS) |
| SeLoger | DataDome | Tous les endpoints bloqués (même stack que Logic-Immo) |
| PAP | Cloudflare Turnstile | Challenge JS non contournable sans browser réel |
