import { PlaywrightCrawler, RequestQueue } from "crawlee";
import { chromium } from "playwright";
import { deleteMissingAnnonces, insertAnnonce, insertErreur } from "../db.js";

export const ouestFranceScraper = async () => {
  const requestQueue = await RequestQueue.open(`ouest-france-${Date.now()}`);
  
  // On démarre par la première page des annonces
  await requestQueue.addRequest({
    url: "https://www.ouestfrance-immo.com/acheter/?prix=0_400000&types=maison,immeuble&lieux=15942,15645",
    userData: { label: "LIST_PAGE" },
  });

  const liensActuels = [];

  const crawler = new PlaywrightCrawler({
    requestQueue,
    maxConcurrency: 1, // équilibre vitesse / RAM
    requestHandlerTimeoutSecs: 180,
    navigationTimeoutSecs: 30,
    maxRequestRetries: 1,
    // Activer les logs détaillés de Playwright
    // Ajouter cette ligne au début du fichier si elle n'existe pas
    // process.env.DEBUG = 'pw:api';
    
    launchContext: {
      launcher: chromium,
      launchOptions: {
        headless: true, // On garde le mode headless pour la production
        // headless: false, // À décommenter pour le débogage
        // devtools: true, // Décommenter pour ouvrir les outils de développement
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-gpu",
          "--window-size=1920,1080",
          "--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
          "--no-zygote",
        ],
      },
    },
    async requestHandler({ page, request, log }) {
      const { label } = request.userData;

      // Gestion de la popup de cookies
      try {
        // Attendre que la popup apparaisse avec un timeout court
        const acceptButton = await page.waitForSelector('#didomi-notice-agree-button, .didomi-popup-view', { timeout: 5000 }).catch(() => null);
        
        if (acceptButton) {
          log.info('🔔 Popup de cookies détectée, tentative de fermeture...');
          
          // Essayer de cliquer sur le bouton d'acceptation
          try {
            await page.click('#didomi-notice-agree-button');
            log.info('✅ Popup de cookies fermée avec succès');
          } catch (error) {
            // Si le clic échoue, essayer avec JavaScript
            log.warn('Échec du clic direct, tentative avec JavaScript...');
            await page.evaluate(() => {
              const button = document.querySelector('#didomi-notice-agree-button');
              if (button) button.click();
            });
          }
          // Attendre que la popup disparaisse
          await page.waitForSelector('.didomi-popup-view', { state: 'hidden', timeout: 3000 }).catch(() => {});
        }
      } catch (error) {
        log.warn(`⚠️ Erreur lors de la gestion des cookies: ${error.message}`);
      }

      // 🧭 Étape 1 — Pages de liste
      if (label === "LIST_PAGE") {
        log.info(` Ouest-France Immo - Page de liste : ${request.url}`);

        await page.goto(request.url);
        log.info(" Ouest-France Immo - Page chargée.");

        // Debug: Afficher des informations sur la page
        log.info(`📄 URL actuelle: ${page.url()}`);
        log.info(`🏷️  Titre de la page: ${await page.title()}`);

        // Attendre que les annonces soient chargées avec gestion d'erreur améliorée
        try {
          // Prendre une capture d'écran avant l'attente
          // await page.screenshot({ path: 'before-wait.png' });
          
          // Attendre le sélecteur avec un timeout plus court
          await page.waitForSelector("article.card-annonce", { 
            timeout: 10000,
            state: 'visible' 
          });
          log.info('✅ Sélecteur article.card-annonce trouvé avec succès');
        } catch (error) {
          // Prendre une capture d'écran en cas d'erreur
          // const screenshotPath = `error-${Date.now()}.png`;
          // await page.screenshot({ path: screenshotPath, fullPage: true });
          
          // Récupérer le contenu de la page pour le débogage
          const pageContent = await page.content();
          log.error(`❌ Erreur: ${error.message}`);
          log.error(`📸 Capture d'écran sauvegardée dans ${screenshotPath}`);
          log.error(`📄 Début du contenu HTML: ${pageContent.substring(0, 500)}...`);
          
          // Vérifier si la page contient un message d'erreur
          const errorMessage = await page.evaluate(() => document.body.innerText);
          log.error(`📝 Texte de la page: ${errorMessage.substring(0, 500)}...`);
          
          throw new Error(`Impossible de trouver les annonces: ${error.message}`);
        }

        // Récupérer les liens des annonces de la page
        log.info('🔍 Récupération des liens des annonces...');
        const links = await page.$$eval(
          "article.card-annonce a[href*='/immobilier/vente/'], article.card-annonce a[href*='/vente-maison/']",
          (anchors) => {
            const uniqueLinks = new Set();
            anchors.forEach(a => {
              // Nettoyer l'URL et s'assurer qu'elle est complète
              let url = a.href.split('?')[0]; // Enlever les paramètres d'URL
              if (!url.startsWith('http')) {
                url = `https://www.ouestfrance-immo.com${url}`;
              }
              uniqueLinks.add(url);
            });
            return Array.from(uniqueLinks);
          }
        );

        // Filtrer les doublons
        const uniqueLinks = [...new Set(links)];
        log.info(`📌 Ouest-France Immo - ${uniqueLinks.length} annonces uniques trouvées sur cette page.`);

        // Ajouter chaque lien dans la file pour traitement détaillé
        for (const url of uniqueLinks) {
          await requestQueue.addRequest({ 
            url, 
            userData: { label: "DETAIL_PAGE" } 
          });
        }

        // Gestion de la pagination
        try {
          // Vérifier s'il y a un lien "page suivante"
          const nextPageLink = await page.$('a[data-t="page-suivante"]:not([disabled])');
          
          if (nextPageLink) {
            const nextUrl = await page.evaluate(link => {
              // Si c'est un lien relatif, on construit l'URL complète
              const href = link.getAttribute('href');
              return href.startsWith('http') ? href : `https://www.ouestfrance-immo.com${href}`;
            }, nextPageLink);

            if (nextUrl) {
              log.info(`➡️ Ouest-France Immo - Page suivante détectée: ${nextUrl}`);
              
              // Ajouter la page suivante à la file d'attente
              await requestQueue.addRequest({ 
                url: nextUrl,
                userData: { label: "LIST_PAGE" }
              });
            }
          } else {
            // Vérifier s'il y a une pagination active
            const pagination = await page.$('.pagination');
            if (pagination) {
              // Vérifier si on est sur la dernière page
              const isLastPage = await page.evaluate(() => {
                const nextButton = document.querySelector('a[data-t="page-suivante"][disabled]');
                return nextButton !== null;
              });
              
              if (isLastPage) {
                log.info("✅ Ouest-France Immo - Dernière page de la pagination atteinte.");
              } else {
                // Essayer de récupérer la prochaine page via les numéros de page
                const currentPage = await page.evaluate(() => {
                  const activeLink = document.querySelector('.pagination__center__nb-link--active');
                  return activeLink ? parseInt(activeLink.textContent.trim()) : 1;
                });
                
                if (currentPage) {
                  const nextPageUrl = request.url.includes('page=') 
                    ? request.url.replace(/page=\d+/, `page=${currentPage + 1}`)
                    : `${request.url}${request.url.includes('?') ? '&' : '?'}page=2`;
                  
                  log.info(`🔍 Ouest-France Immo - Page suivante construite: ${nextPageUrl}`);
                  
                  await requestQueue.addRequest({ 
                    url: nextPageUrl,
                    userData: { label: "LIST_PAGE" }
                  });
                }
              }
            } else {
              log.info("ℹ️ Ouest-France Immo - Aucune pagination détectée.");
            }
          }
        } catch (error) {
          log.error(`❌ Ouest-France Immo - Erreur lors de la gestion de la pagination: ${error.message}`);
        }
      }

      // 🏡 Étape 2 — Pages de détail
      if (label === "DETAIL_PAGE") {
        try {
          log.info(`📄 Ouest-France Immo - Page détail : ${request.url}`);

          await page.goto(request.url, { waitUntil: "domcontentloaded" });

          // Extraction des informations principales
          const property = await page.evaluate(() => {
            // Fonction pour nettoyer le texte
            const cleanText = (selector) => 
              document.querySelector(selector)?.textContent.trim() || '';
            
            // Titre et ville de l'annonce (format: "Type Ville")
            const titleElement = document.querySelector('h2.detail-page__title');
            let title = 'Bien non spécifié';
            let location = '';
            
            if (titleElement) {
              const titleText = titleElement.textContent.trim();
              const [type, ...villeParts] = titleText.split(' ');
              title = type || 'Bien non spécifié';
              location = villeParts.join(' ').trim();
            }
            
            // Fonction pour extraire une valeur à partir du libellé
            const getInfoValue = (labelText) => {
              const labelElement = Array.from(document.querySelectorAll('.detail-info__label span'))
                .find(el => el.textContent.trim().includes(labelText));
              
              if (labelElement) {
                const valueElement = labelElement.closest('.detail-info')
                  ?.querySelector('.detail-info__value');
                return valueElement?.textContent.trim() || '';
              }
              return '';
            };

            // Extraction des informations
            const surfaceText = getInfoValue('Surface habitable');
            const surface = parseInt(surfaceText.replace(/[^0-9]/g, '')) || 0;
            
            const surfaceTerrainText = getInfoValue('Surface terrain');
            const surfaceTerrain = parseInt(surfaceTerrainText.replace(/[^0-9]/g, '')) || 0;
            
            const piecesText = getInfoValue('Pièces');
            const pieces = parseInt(piecesText) || 0;
            
            const chambresText = getInfoValue('Chambres');
            const chambres = parseInt(chambresText) || 0;
            
            // Prix (mise à jour pour utiliser la même méthode)
            const priceText = getInfoValue('Prix').split('€')[0];
            const price = parseInt(priceText.replace(/[^0-9]/g, '')) || 0;

            // Description - Concaténation de tous les paragraphes
            const description = Array.from(document.querySelectorAll('.detail-description .detail-description__text-part'))
              .map(p => p.textContent.trim())
              .filter(text => !text.includes('www.georisques.gouv.fr')) // Exclure le texte du bouton
              .filter(text => !text.match(/^R[ée]f\.?\s*[A-Z0-9-]+/i)) // Exclure la référence
              .join('\n\n') // Sépare les paragraphes par des lignes vides
              .replace(/\s+/g, ' ') // Remplacer les espaces multiples par un seul espace
              .trim() || 'Aucune description disponible';
            
            // Photos - Nouvelle méthode avec sélecteurs multiples
            const photos = Array.from(document.querySelectorAll('.detail-slider-annonce__photo img[srcset]'))
              .map(img => {
                // Prendre la plus grande image disponible (768px)
                const srcset = img.getAttribute('srcset');
                if (!srcset) return null;
                
                const largestImage = srcset
                  .split(',')
                  .map(s => s.trim().split(' '))
                  .filter(parts => parts.length >= 2) // S'assurer qu'on a bien [url, size]
                  .reduce((largest, current) => {
                    const currentSize = parseInt(current[1]);
                    const largestSize = parseInt(largest[1] || '0');
                    return currentSize > largestSize ? current : largest;
                  }, ['', '0'])[0].trim();
                
                return largestImage || null;
              })
              .filter(Boolean) // Enlever les valeurs null/undefined
              .filter(src => !src.includes('map-') && !src.includes('logo')); // Exclure cartes et logos

            return {
              title,
              location,
              price,
              surface,
              surfaceTerrain,
              pieces,
              chambres,
              description,
              photos,
              url: window.location.href.split('?')[0], // Nettoyer l'URL
              source: 'Ouest-France Immo',
              timestamp: new Date().toISOString()
            };
          });

          // Vérifier que les données essentielles sont présentes
          if (property.title && property.price > 0) {
            // Ajouter l'URL aux liens actuels pour le nettoyage final
            liensActuels.push(property.url);

            // Insérer l'annonce dans la base de données
            await insertAnnonce({
              type: property.title.split(' ')[0] || 'Non spécifié',
              prix: property.price,
              ville: property.location || 'Non spécifié',
              pieces: property.pieces,
              chambres: property.bedrooms,
              surface: property.surface,
              description: property.description,
              photos: property.photos,
              agence: "Ouest-France Immo",
              lien: request.url,
            });
          } else {
            log.warning(` Ouest-France Immo - Données incomplètes pour ${request.url}`);
            await insertErreur("Ouest-France Immo", request.url, "Données incomplètes");
          }
        } catch (err) {
          log.error(`❌ Ouest-France Immo - Erreur sur la page ${request.url}`, { error: String(err) });
          await insertErreur("Ouest-France Immo", request.url, String(err));
        }
      }
    },

    failedRequestHandler({ request, log }) {
      log.error(`🚨 Ouest-France Immo - Échec permanent pour ${request.url}`);
    },
  });

  await crawler.run();

  // Nettoyer les annonces manquantes
  await deleteMissingAnnonces("Ouest-France Immo", Array.from(new Set(liensActuels)));

  console.log("✅ Ouest-France Immo - Scraping Ouest-France Immo terminé !");
};
