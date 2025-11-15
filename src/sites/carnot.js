import { PlaywrightCrawler, RequestQueue } from "crawlee";
import { chromium } from "playwright";
import { deleteMissingAnnonces, insertAnnonce, insertErreur } from "../db.js";

export const carnotScraper = async () => {
  const requestQueue = await RequestQueue.open(`carnot-${Date.now()}`);
  
  // On démarre par la première page des annonces
  await requestQueue.addRequest({
    url: "https://www.carnotimmo.com/recherche-de-bien/?status=vente&type%5B%5D=maison&location=vitre-35500",
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
        log.info(`🔎 Carnot - Page de liste : ${request.url}`);

        await page.goto(request.url);
        log.info("✅ Carnot - Page chargée.");
        
        // Popup cookies
        const cookiePopup = page.locator("#didomi-popup");
        if (await cookiePopup.isVisible({ timeout: 5000 }).catch(() => false)) {
            await page.click("button#didomi-notice-agree-button");
        }

        // Attendre que les annonces soient chargées
        await page.waitForSelector(".rh_page__listing .rh_list_card", { timeout: 10000 });

        // Récupérer les liens des annonces de la page
        const links = await page.$$eval(
          ".rh_list_card__wrap h3 a[href]",
          (anchors) => anchors.map(a => a.href)
        );

        log.info(`📌 Carnot - ${links.length} annonces trouvées sur cette page.`);

        // Ajouter chaque lien dans la file pour traitement détaillé
        for (const url of links) {
          await requestQueue.addRequest({ 
            url, 
            userData: { label: "DETAIL_PAGE" } 
          });
        }

        // Gestion pagination
        const nextButton = page.locator("a.rh_pagination__next");
        if ((await nextButton.count()) > 0) {
          const nextUrl = await nextButton.getAttribute("href");
          if (nextUrl) {
            log.info("➡️ Carnot - Page suivante détectée, ajout dans la file...");
            await requestQueue.addRequest({ 
              url: nextUrl, 
              userData: { label: "LIST_PAGE" } 
            });
          }
        } else {
          log.info("✅ Carnot - Fin de la pagination détectée.");
        }
      }

      // 🏡 Étape 2 — Pages de détail
      if (label === "DETAIL_PAGE") {
        try {
          log.info(`📄 Carnot - Page détail : ${request.url}`);

          await page.goto(request.url, { waitUntil: "domcontentloaded" });

          // Gérer la popup cookies si elle apparaît
          const cookiePopup = page.locator("#didomi-popup");
          if (await cookiePopup.isVisible({ timeout: 5000 }).catch(() => false)) {
              await page.click("button#didomi-notice-agree-button");
          }

          // Extraction des informations principales
          const property = await page.evaluate(() => {
            // Titre et type de bien
            const title = document.querySelector('.rh_page__title')?.textContent.trim() || '';
            
            // Prix
            const priceText = document.querySelector('.rh_page__property_price .price')?.textContent.trim() || '';
            const price = parseInt(priceText.replace(/[^0-9]/g, '')) || 0;
            
            // Surface habitable
            const surfaceText = Array.from(document.querySelectorAll('.rh_property__meta_wrap .rh_meta_titles'))
              .find(el => el.textContent.includes('Surface'))
              ?.parentElement?.querySelector('.figure')?.textContent.trim() || '0';
            const surface = parseInt(surfaceText) || 0;
            
            // Surface terrain
            const landSurfaceText = Array.from(document.querySelectorAll('.property-content-section-additional-details .title'))
              .find(el => el.textContent.includes('Surface terrain'))
              ?.parentElement?.querySelector('.value')?.textContent.trim() || '0';
            const landSurface = parseInt(landSurfaceText) || 0;
            
            // Pièces et chambres
            const roomsText = document.querySelector('.prop_bedrooms .figure')?.textContent.trim() || '0';
            const bedrooms = parseInt(roomsText) || 0;
            
            // Salles de bain
            const bathroomsText = document.querySelector('.prop_bathrooms .figure')?.textContent.trim() || '0';
            const bathrooms = parseInt(bathroomsText) || 0;
            
            // Stationnement
            const parkingText = document.querySelector('.prop_garages .figure')?.textContent.trim() || '0';
            const parking = parseInt(parkingText) || 0;
            
            // Description
            const description = document.querySelector('.rh_property__content .rh_content')?.textContent.trim() || '';
            
            // Localisation
            const location = document.querySelector('.rh_page__property_address')?.textContent.trim() || '';
            
            // Référence
            const reference = document.querySelector('.rh_property__id .id')?.textContent.trim() || '';
            
            // Prix net vendeur
            const netPriceText = Array.from(document.querySelectorAll('.property-content-section-additional-details .title'))
              .find(el => el.textContent.includes('Prix net vendeur'))
              ?.parentElement?.querySelector('.value')?.textContent.trim() || '0';
            const netPrice = parseInt(netPriceText) || 0;
            
            // Honoraires
            const feesText = Array.from(document.querySelectorAll('.property-content-section-additional-details .title'))
              .find(el => el.textContent.includes('Honoraires'))
              ?.parentElement?.querySelector('.value')?.textContent.trim() || '0';
            const fees = parseFloat(feesText) || 0;

            // DPE
            const dpeText = document.querySelector('#bloc-energies #dpe .details-dpe .detail-infos strong')?.textContent.trim() || '';
            const dpe = dpeText ? parseInt(dpeText) : null;
            
            // GES
            const gesText = document.querySelector('#bloc-energies #ges .details-ges .detail-infos strong')?.textContent.trim() || '';
            const ges = gesText ? parseInt(gesText) : null;

            // Photos
            const photos = Array.from(document.querySelectorAll('.inspiry_property_masonry_style a[data-fancybox="gallery"]'))
              .map(img => img.getAttribute('href') || '')
              .filter(Boolean);

            return {
              title,
              price,
              surface,
              landSurface: landSurface || null,
              bedrooms,
              bathrooms,
              parking,
              description,
              location,
              reference,
              netPrice: netPrice || null,
              fees: fees || null,
              dpe,
              ges,
              photos,
              url: window.location.href,
              source: 'Carnot Immobilier',
              timestamp: new Date().toISOString()
            };
          });

          // Extraire le type du premier mot du premier paragraphe de la description
          const propertyType = property.description.split('\n')[0]?.trim().split(' ')[0] || 'Non spécifié';
          
          // Vérifier les données et insérer dans la base de données
          if (property.title && property.price) {
            await insertAnnonce({
              type: propertyType,
              prix: property.price,
              ville: property.location,
              pieces: property.bedrooms + 1, // On suppose que le nombre de pièces = chambres + séjour
              chambres: property.bedrooms,
              surface: property.surface,
              description: property.description,
              photos: property.photos,
              agence: "Carnot",
              lien: request.url,
            });
            liensActuels.push(request.url);
          } else {
            log.warning(`⚠️ Carnot - Données incomplètes pour ${request.url}`);
            await insertErreur("Carnot", request.url, "Données incomplètes");
          }
        } catch (err) {
          log.error(`❌ Carnot - Erreur sur la page ${request.url}`, { error: String(err) });
          await insertErreur("Carnot", request.url, String(err));
        }
      }
    },

    failedRequestHandler({ request, log }) {
      log.error(`🚨 Carnot - Échec permanent pour ${request.url}`);
    },
  });

  await crawler.run();

  // Nettoyer les annonces manquantes
  await deleteMissingAnnonces("Carnot", Array.from(new Set(liensActuels)));

  console.log("✅ Carnot - Scraping Carnot terminé !");
};
