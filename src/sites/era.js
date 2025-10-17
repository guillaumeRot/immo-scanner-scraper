import { PlaywrightCrawler, RequestQueue } from "crawlee";
import { chromium } from "playwright";
import { deleteMissingAnnonces, insertAnnonce, insertErreur } from "../db.js";

export const eraScraper = async () => {
  const requestQueue = await RequestQueue.open(`era-${Date.now()}`);
  
  await requestQueue.addRequest({
    url: "https://www.eraimmobilier.com/acheter/Chateaugiron-c15629,Vitre-c27606?page=1&prix_to=400000&type_bien=maison,immeuble&display=list",
    userData: { label: "LIST_PAGE" },
  });

  const liensActuels = [];

  const crawler = new PlaywrightCrawler({
    requestQueue,
    maxConcurrency: 1, // équilibre vitesse / RAM
    requestHandlerTimeoutSecs: 180,
    navigationTimeoutSecs: 30,
    maxRequestRetries: 1,
    launchContext: {
      launcher: chromium,
      launchOptions: {
        headless: true,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-gpu",
          "--single-process",
          "--no-zygote",
        ],
      },
    },
    async requestHandler({ page, request, log }) {
      const { label } = request.userData;

      // 🧭 Étape 1 — Pages de liste
      if (label === "LIST_PAGE") {
        log.info(`🔎 ERA - Page de liste : ${request.url}`);

        await page.goto(request.url);
        log.info("✅ ERA - Page chargée.");
        
        // Gestion des cookies
        try {
          await page.click('button#didomi-notice-agree-button, button#tarteaucitronAllDenied2', { timeout: 5000 });
          log.info("✅ ERA - Gestion des cookies effectuée.");
        } catch (e) {
          log.info("ℹ️ ERA - Pas de bannière de cookies trouvée.");
        }

        // Attendre que les annonces soient chargées
        await page.waitForSelector("app-annonce-card", { timeout: 10000 });

        // Récupérer les liens des annonces de la page
        const links = await page.$$eval(
          "app-annonce-card a[href^='/annonces/']", 
          (els) => els.map(a => a.href)
        );

        // Filtrer les doublons
        const uniqueLinks = [...new Set(links)];
        log.info(`  ERA - ${uniqueLinks.length} annonces uniques trouvées sur cette page.`);

        // Ajouter chaque lien dans la file pour traitement détaillé
        for (const url of uniqueLinks) {
          await requestQueue.addRequest({ 
            url, 
            userData: { label: "DETAIL_PAGE" } 
          });
        }

        // Gestion pagination
        const nextButton = page.locator('a.nav:has(.icon-arrow-right)');
        if ((await nextButton.count()) > 0) {
          const nextUrl = await nextButton.getAttribute("href");
          if (nextUrl) {
            const fullNextUrl = nextUrl.startsWith('http') ? nextUrl : `https://www.eraimmobilier.com${nextUrl}`;
            log.info(" ERA - Page suivante détectée, ajout dans la file...");
            await requestQueue.addRequest({ 
              url: fullNextUrl, 
              userData: { label: "LIST_PAGE" } 
            });
          }
        } else {
          log.info(" ERA - Fin de la pagination détectée.");
        }
      }

      // Étape 2 — Pages de détail
      if (label === "DETAIL_PAGE") {
        try {
          log.info(`🔍 ERA - Page détail : ${request.url}`);
          await page.goto(request.url, { waitUntil: "domcontentloaded" });

          // Attendre que les éléments principaux soient chargés
          await page.waitForSelector('app-annonce-title', { timeout: 10000 });

          // Extraire les informations principales
          const property = await page.evaluate(() => {
            // Titre et type de bien
            const title = document.querySelector('h1 .display-h1')?.textContent.trim() || '';
            const type = title.replace('Vente', '').trim();
            
            // Prix (nettoyé des espaces insécables et symboles)
            const priceText = document.querySelector('.title-price-number')?.textContent || '';
            const price = parseInt(priceText.replace(/\s+/g, '').replace('€*', '').trim(), 10) || null;
            
            // Surface et caractéristiques
            const features = Array.from(document.querySelectorAll('.display-text-18px span:not(.icon-location)'))
              .map(el => el.textContent.trim())
              .filter(text => text && !text.includes('€') && !text.includes('*'));
            
            let surface = null;
            let rooms = null;
            let bedrooms = null;
            
            features.forEach(feature => {
              if (feature.includes('m²')) {
                surface = parseInt(feature.replace('m²', '').trim(), 10) || null;
              } else if (feature.includes('Pièces')) {
                rooms = parseInt(feature.replace('Pièces', '').trim(), 10) || null;
              } else if (feature.includes('chambres')) {
                bedrooms = parseInt(feature.replace('chambres', '').trim(), 10) || null;
              }
            });
            
            // Localisation
            const location = document.querySelector('.city')?.textContent.trim() || '';
            
            // Description
            const description = document.querySelector('.description p.whitespace-pre-wrap')?.textContent.trim() || '';
            
            // Caractéristiques
            const amenities = Array.from(document.querySelectorAll('.description-container-pictos-item p.display-text-16px'))
              .map(el => el.textContent.trim().toLowerCase());
            
            // Images
            const images = Array.from(document.querySelectorAll('.block-image-item-img:not([src*="logo"]):not([src*="icon"])'))
              .map(img => img.src)
              .filter(Boolean);
            
            // Référence
            const refMatch = document.querySelector('.reference span')?.textContent.trim();
            const reference = refMatch ? `ERA-${refMatch}` : null;
            
            // Coordonnées de l'agence
            const agency = {
              name: document.querySelector('.block-contact-agency-presentation h1')?.textContent.trim() || '',
              address: Array.from(document.querySelectorAll('.block-contact-agency-presentation-address p:not(.display-text-16px)'))
                .map(p => p.textContent.trim())
                .filter(Boolean)
                .join(' ')
            };

            return {
              title,
              type,
              price,
              surface,
              rooms,
              bedrooms,
              location,
              description,
              amenities,
              images,
              reference,
              agency,
              url: window.location.href,
              source: 'ERA Immobilier',
              dateScraped: new Date().toISOString()
            };
          });

          log.info(`✅ Détails extraits pour ${property.reference || 'annonce sans référence'}`);
          log.debug('Détails complets:', property);

          // Sauvegarder les données dans la base de données
          if (property && property.title) {
            try {
              await insertAnnonce({
                type: property.type,
                prix: property.price,
                ville: property.location,
                pieces: property.rooms,
                surface: property.surface,
                chambres: property.bedrooms,
                description: property.description,
                photos: property.images,
                agence: "ERA",
                lien: request.url,
                reference: property.reference
              });

              liensActuels.push(request.url);
              log.info(`✅ ERA - Annonce insérée : ${property.reference || 'sans référence'}`);
            } catch (error) {
              log.error(`❌ ERA - Erreur lors de l'insertion de l'annonce: ${error.message}`);
              await insertErreur("ERA", request.url, `Erreur insertion: ${error.message}`);
            }
          } else {
            log.warning(`⚠️ ERA - Données incomplètes pour ${request.url}`);
            await insertErreur("ERA", request.url, "Données incomplètes pour l'annonce");
          }
        } catch (err) {
          log.error(` ERA - Erreur sur la page ${request.url}`, { error: String(err) });
          await insertErreur("ERA", request.url, String(err));
        }
      }
    },

    failedRequestHandler({ request, log }) {
      log.error(` ERA - Échec permanent pour ${request.url}`);
    },
  });

  await crawler.run();

  // Nettoyer les annonces manquantes
  await deleteMissingAnnonces("ERA", Array.from(new Set(liensActuels)));

  console.log(" ERA - Scraping ERA Immobilier terminé !");
};