import { PlaywrightCrawler, RequestQueue } from "crawlee";
import { chromium } from "playwright";
import { deleteMissingAnnonces, insertAnnonce, insertErreur } from "../db.js";

export const acheterLouerScraper = async () => {
  const requestQueue = await RequestQueue.open(`acheter-louer-${Date.now()}`);
  
  // On démarre par la première page des annonces
  await requestQueue.addRequest({
    url: "https://acheter-louer.fr/recherche?categorie=achat&loc=vitre,chateaugiron&prix-min=0&prix-max=400000&type=maison,immeuble&surface-global-min=0&surface-globale-max=100000&cityZip=35500,35410&sort=Date",
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
        log.info(` Acheter-louer - Page de liste : ${request.url}`);

        await page.goto(request.url);
        log.info(" Acheter-louer - Page chargée.");

        // Attendre que les annonces soient chargées
        await page.waitForSelector(".CardSearchResult", { timeout: 10000 });

        // Faire défiler pour charger toutes les annonces (scroll infini)
        log.info(" Acheter-louer - Chargement des annonces supplémentaires...");
        let previousHeight = 0;
        let currentHeight = await page.evaluate('document.body.scrollHeight');
        const maxScrolls = 10; // Nombre maximum de défilements pour éviter les boucles infinies
        let scrollCount = 0;

        while (previousHeight !== currentHeight && scrollCount < maxScrolls) {
          previousHeight = currentHeight;
          await page.evaluate('window.scrollTo(0, document.body.scrollHeight)');
          await page.waitForTimeout(1000); // Attendre le chargement
          currentHeight = await page.evaluate('document.body.scrollHeight');
          scrollCount++;
          log.info(` Acheter-louer - Défilement ${scrollCount}/${maxScrolls} - Hauteur: ${currentHeight}px`);
        }

        // Récupérer les liens des annonces de la page
        const links = await page.$$eval(
          ".CardSearchResult .h3-like[href]",
          (anchors) => anchors.map(a => {
            // Convertir les URLs relatives en absolues si nécessaire
            return a.href.startsWith('http') ? a.href : `https://www.acheter-louer.fr${a.href}`;
          })
        );

        // Filtrer les doublons
        const uniqueLinks = [...new Set(links)];
        log.info(`📌 Acheter-louer - ${uniqueLinks.length} annonces uniques trouvées sur cette page.`);

        // Ajouter chaque lien dans la file pour traitement détaillé
        for (const url of uniqueLinks) {
          await requestQueue.addRequest({ 
            url, 
            userData: { label: "DETAIL_PAGE" } 
          });
        }

        // Pas de pagination sur ce site
      }

      // 🏡 Étape 2 — Pages de détail
      if (label === "DETAIL_PAGE") {
        try {
          log.info(`📄 Acheter-louer - Page détail : ${request.url}`);

          await page.goto(request.url, { waitUntil: "domcontentloaded" });

          // Extraction des informations principales
          const property = await page.evaluate(() => {
            // Fonction pour nettoyer le texte
            const cleanText = (selector) => 
              document.querySelector(selector)?.textContent.trim() || '';
            
            // Titre et type de bien
            const type = cleanText('.field--name-field-realty-type');
            const title = type ? `${type} à ${cleanText('.content-container p strong').substring(6)}` : 'Bien non spécifié';
            
            // Prix
            const priceText = cleanText('.container-price .price');
            const price = parseInt(priceText.replace(/[^0-9]/g, '')) || 0;
            
            // Surface habitable
            const surfaceText = Array.from(document.querySelectorAll('.list-container .item .name'))
              .find(el => el.textContent.trim() === 'Surface')
              ?.closest('.item')
              ?.querySelector('.value')
              ?.textContent
              .replace(/[^0-9]/g, '') || '0';
            const surface = parseInt(surfaceText) || 0;
            
            // Pièces et chambres
            const roomsText = cleanText('.field--name-field-realty-rooms .field__item');
            const bedrooms = parseInt(roomsText) || 0;
            
            // Description
            const descriptionElement = document.querySelector('.field--name-field-realty-comment');
            const description = descriptionElement ? descriptionElement.textContent.trim() : '';
            
            // Localisation (on prend le texte du premier strong et on enlève les 6 premiers caractères)
            const location = cleanText('.content-container p strong')?.substring(6) || '';
            
            // Référence
            const reference = cleanText('.field--name-field-realty-reference .field__item');
            
            // Photos
            const photos = Array.from(document.querySelectorAll('.popup-galerie a.image-galerie[href*="/sites/default/files/"]'))
              .map(a => {
                const href = a.getAttribute('href');
                return href.startsWith('http') ? href : `https://www.cabinet-diard-immobilier.fr${href}`;
              })
              .filter(Boolean);

            // Extraction des détails supplémentaires
            const details = {};
            document.querySelectorAll('.field--name-field-realty-features .field__item').forEach(item => {
              const text = item.textContent.trim();
              if (text.includes('Pièce(s)')) details.pieces = parseInt(text) || 0;
              if (text.includes('Chambre(s)')) details.chambres = parseInt(text) || 0;
              if (text.includes('Salle(s) de bain')) details.sdb = parseInt(text) || 0;
              if (text.includes('Surface terrain')) {
                const landSurface = parseInt(text.replace(/[^0-9]/g, ''));
                if (!isNaN(landSurface)) details.landSurface = landSurface;
              }
            });

            return {
              title,
              price,
              surface,
              landSurface: details.landSurface || null,
              bedrooms: details.chambres || bedrooms,
              pieces: details.pieces || bedrooms + 1, // On suppose que le nombre de pièces = chambres + séjour
              sdb: details.sdb || 0,
              description,
              location,
              reference,
              photos,
              url: window.location.href,
              source: 'Acheter-louer',
              timestamp: new Date().toISOString()
            };
          });
          
          // Vérifier les données et insérer dans la base de données
          if (property.title && property.price) {
            await insertAnnonce({
              type: property.title.split(' ')[0] || 'Non spécifié',
              prix: property.price,
              ville: property.location,
              pieces: property.pieces,
              chambres: property.bedrooms,
              surface: property.surface,
              description: property.description,
              photos: property.photos,
              agence: "Acheter-louer",
              lien: request.url,
            });
          } else {
            log.warning(`⚠️ Acheter-louer - Données incomplètes pour ${request.url}`);
            await insertErreur("Acheter-louer", request.url, "Données incomplètes");
          }
        } catch (err) {
          log.error(`❌ Acheter-louer - Erreur sur la page ${request.url}`, { error: String(err) });
          await insertErreur("Acheter-louer", request.url, String(err));
        }
      }
    },

    failedRequestHandler({ request, log }) {
      log.error(`🚨 Acheter-louer - Échec permanent pour ${request.url}`);
    },
  });

  await crawler.run();

  // Supprimer les annonces qui ne sont plus présentes
  await deleteMissingAnnonces("Acheter-louer", liensActuels);

  console.log(" Acheter-louer - Scraping Acheter-louer terminé !");
};
