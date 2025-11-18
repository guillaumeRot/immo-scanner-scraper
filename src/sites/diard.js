import { PlaywrightCrawler, RequestQueue } from "crawlee";
import { chromium } from "playwright";
import { deleteMissingAnnonces, insertAnnonce, insertErreur } from "../db.js";

export const diardScraper = async () => {
  const requestQueue = await RequestQueue.open(`diard-${Date.now()}`);
  
  // On démarre par la première page des annonces
  await requestQueue.addRequest({
    url: "https://www.cabinet-diard-immobilier.fr/acheter-louer?maisons=1&immeubles=1&ref=&budget_min=&budget_max=400000&surface=&ville=vitr%C3%A9&op=Rechercher&geolocalisation_rayon_data=&latitude=&longitude=&form_build_id=form-BF7c8Zw2ucBnppSkmqJnGo0iQU8NRfhQ-_5uY2ldI9o&form_id=b2iimmo_realty_search",
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
        log.info(` Diard - Page de liste : ${request.url}`);

        await page.goto(request.url);
        log.info(" Diard - Page chargée.");

        // Attendre que les annonces soient chargées
        await page.waitForSelector(".node--type-realty", { timeout: 10000 });

        // Récupérer les liens des annonces de la page
        const links = await page.$$eval(
          "article.node--type-realty a.full-link[href]",
          (anchors) => anchors.map(a => {
            // Convertir les URLs relatives en absolues si nécessaire
            return a.href.startsWith('http') ? a.href : `https://www.cabinet-diard-immobilier.fr${a.href}`;
          })
        );

        // Filtrer les doublons
        const uniqueLinks = [...new Set(links)];
        log.info(`📌 Diard - ${uniqueLinks.length} annonces uniques trouvées sur cette page.`);

        // Ajouter chaque lien dans la file pour traitement détaillé
        for (const url of uniqueLinks) {
          await requestQueue.addRequest({ 
            url, 
            userData: { label: "DETAIL_PAGE" } 
          });
        }

        // Gestion de la pagination
        try {
          // Vérifier s'il y a un lien "page suivante" avec rel="next"
          const nextPageLink = await page.locator('a.page-link[rel="next"]').first();
          
          if (await nextPageLink.count() > 0) {
            const nextUrl = await nextPageLink.getAttribute("href");
            if (nextUrl) {
              // Construire l'URL complète si nécessaire
              const baseUrl = 'https://www.cabinet-diard-immobilier.fr';
              const fullNextUrl = nextUrl.startsWith('http') ? nextUrl : `${baseUrl}${nextUrl.startsWith('?') ? '/acheter-louer' : ''}${nextUrl}`;
              
              log.info(`➡️ Diard - Page suivante détectée: ${fullNextUrl}`);
              
              // Ajouter la page suivante à la file d'attente
              await requestQueue.addRequest({ 
                url: fullNextUrl,
                userData: { label: "LIST_PAGE" }
              });
            }
          } else {
            // Vérifier s'il y a une pagination active mais pas de bouton suivant (dernière page)
            const pagination = await page.locator('ul.pagination').count();
            if (pagination > 0) {
              log.info("✅ Diard - Dernière page de la pagination atteinte.");
            } else {
              log.info("ℹ️ Diard - Aucune pagination détectée.");
            }
          }
        } catch (error) {
          log.error(`❌ Diard - Erreur lors de la gestion de la pagination: ${error.message}`);
        }
      }

      // 🏡 Étape 2 — Pages de détail
      if (label === "DETAIL_PAGE") {
        try {
          log.info(`📄 Diard - Page détail : ${request.url}`);

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

            // Extraction DPE - prendre la lettre qui suit le path avec stroke
            let dpeLetter = '';
            const dpeElement = document.querySelector('#dpe svg');
            if (dpeElement) {
              const pathWithStroke = dpeElement.querySelector('path[stroke]');
              if (pathWithStroke) {
                // Chercher le texte qui suit ce path dans le SVG
                const pathIndex = Array.from(dpeElement.children).indexOf(pathWithStroke);
                
                // Prendre le premier texte après le path
                for (let i = pathIndex + 1; i < dpeElement.children.length; i++) {
                  const element = dpeElement.children[i];
                  if (element.tagName === 'text' && element.textContent.trim().match(/^[A-G]$/)) {
                    dpeLetter = element.textContent.trim();
                    break;
                  }
                }
              }
            }

            // Extraction GES - prendre la lettre qui suit le path avec stroke
            let gesLetter = '';
            const gesElement = document.querySelector('#ges svg');
            if (gesElement) {
              const pathWithStroke = gesElement.querySelector('path[stroke]');
              if (pathWithStroke) {
                // Chercher le texte qui suit ce path dans le SVG
                const pathIndex = Array.from(gesElement.children).indexOf(pathWithStroke);
                
                // Prendre le premier texte après le path
                for (let i = pathIndex + 1; i < gesElement.children.length; i++) {
                  const element = gesElement.children[i];
                  if (element.tagName === 'text' && element.textContent.trim().match(/^[A-G]$/)) {
                    gesLetter = element.textContent.trim();
                    break;
                  }
                }
              }
            }

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
              dpe: dpeLetter,
              ges: gesLetter,
              url: window.location.href,
              source: 'Diard Immobilier',
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
              dpe: property.dpe,
              ges: property.ges,
              agence: "Diard",
              lien: request.url,
            });
          } else {
            log.warning(`⚠️ Diard - Données incomplètes pour ${request.url}`);
            await insertErreur("Diard", request.url, "Données incomplètes");
          }
        } catch (err) {
          log.error(`❌ Diard - Erreur sur la page ${request.url}`, { error: String(err) });
          await insertErreur("Diard", request.url, String(err));
        }
      }
    },

    failedRequestHandler({ request, log }) {
      log.error(`🚨 Diard - Échec permanent pour ${request.url}`);
    },
  });

  await crawler.run();

  // Nettoyer les annonces manquantes
  await deleteMissingAnnonces("Diard", Array.from(new Set(liensActuels)));

  console.log("✅ Diard - Scraping Diard terminé !");
};
