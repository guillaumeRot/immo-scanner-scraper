import pg from 'pg';

const { Pool } = pg;

// Pool et client initialisés lors de initDb()
let pool = null;
let client = null;

export async function initDb() {
  try {
    const url = process.env.DATABASE_URL;
    if (!url || typeof url !== "string") {
      throw new Error("DATABASE_URL manquante ou invalide. Vérifiez votre fichier .env");
    }

    pool = new Pool({
      connectionString: url,
      ssl: { rejectUnauthorized: false },
    });

    client = await pool.connect();
    console.log("✅ Connexion à la base de données PostgreSQL établie");

    await ensureTablesExists();
  } catch (err) {
    console.error("❌ Erreur de connexion à la base de données:", err);
    throw err;
  }
}

async function ensureTablesExists() {
  if (!client) throw new Error("Client non initialisé");

  const createTableQuery = `
    CREATE TABLE IF NOT EXISTS "Annonce" (
      id SERIAL PRIMARY KEY,
      type VARCHAR(255),
      prix VARCHAR(100),
      ville VARCHAR(100),
      pieces VARCHAR(50),
      surface VARCHAR(50),
      lien VARCHAR UNIQUE NOT NULL,
      description TEXT,
      photos JSON,
      agence VARCHAR(100) NOT NULL,
      nb_t1 INTEGER DEFAULT 0,
      nb_t2 INTEGER DEFAULT 0,
      nb_t3 INTEGER DEFAULT 0,
      nb_t4 INTEGER DEFAULT 0,
      nb_t5 INTEGER DEFAULT 0,
      dpe VARCHAR(1),
      ges VARCHAR(1),
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      date_scraped TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_annonce_lien ON "Annonce"(lien);
    CREATE INDEX IF NOT EXISTS idx_annonce_agence ON "Annonce"(agence);
  `;

  const createErrorTableQuery = `
    CREATE TABLE IF NOT EXISTS "Erreur" (
      id SERIAL PRIMARY KEY,
      scraper VARCHAR(100) NOT NULL,
      url TEXT NOT NULL,
      message TEXT NOT NULL,
      date_erreur TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_erreur_scraper ON "Erreur"(scraper);
    CREATE INDEX IF NOT EXISTS idx_erreur_date ON "Erreur"(date_erreur);
  `;

  await client.query(createTableQuery);
  console.log("✅ Table 'Annonce' vérifiée/créée");

  await client.query(createErrorTableQuery);
  console.log("✅ Table 'Erreur' vérifiée/créée");

  const createScanTableQuery = `
    CREATE TABLE IF NOT EXISTS "Scan" (
      id SERIAL PRIMARY KEY,
      scraper VARCHAR(100) NOT NULL,
      date_scan TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      status VARCHAR(50) DEFAULT 'completed',
      annonces_count INTEGER DEFAULT 0,
      erreurs_count INTEGER DEFAULT 0,
      duree_ms INTEGER,
      UNIQUE(scraper)
    );

    CREATE INDEX IF NOT EXISTS idx_scan_scraper ON "Scan"(scraper);
    CREATE INDEX IF NOT EXISTS idx_scan_date ON "Scan"(date_scan);
  `;

  await client.query(createScanTableQuery);
  console.log("✅ Table 'Scan' vérifiée/créée");
}

// Villes supportées avec leurs variantes
export const VILLES = {
  VITRE: {
    nom: 'Vitré',
    variantes: ['vitre', 'Vitré', 'VITRE']
  },
  CHATEAUGIRON: {
    nom: 'Châteaugiron',
    variantes: ['chateaugiron', 'Chateaugiron', 'CHATEAUGIRON', 'châteaugiron', 'Châteaugiron', 'CHÂTEAUGIRON']
  }
};

// Types de biens supportés avec leurs variantes
export const TYPES = {
  MAISON: {
    nom: 'Maison',
    variantes: ['maison', 'Maison', 'MAISON', 'Villa', 'VILLA', 'villa', 'propriété', 'Propriété', ' propriéte', 'Propriéte']
  },
  IMMEUBLE: {
    nom: 'Immeuble',
    variantes: ['immeuble', 'Immeuble', 'IMMEUBLE']
  }
};

/**
 * Formate le nom de la ville si elle contient une des variantes supportées
 * @param {string} ville - Le nom de la ville à formater (peut contenir d'autres informations comme le code postal)
 * @returns {string} Le nom de la ville formaté ou la chaîne d'origine
 */
function formaterVille(ville) {
  if (!ville) return ville;
  
  // Convertit la ville en minuscules pour une comparaison insensible à la casse
  const villeNormalisee = ville.toLowerCase();
  
  // Vérifie chaque ville supportée
  for (const [_, villeData] of Object.entries(VILLES)) {
    // Vérifie si une des variantes est incluse dans la chaîne de la ville
    const varianteTrouvee = villeData.variantes.some(variante => 
      villeNormalisee.includes(variante.toLowerCase())
    );
    
    if (varianteTrouvee) {
      return villeData.nom;
    }
  }
  return ville; // Retourne la ville inchangée si non reconnue
}

/**
 * Formate le type du bien s'il contient une des variantes supportées
 * @param {string} type - Le type du bien à formater
 * @returns {string} Le type formaté ou la chaîne d'origine
 */
function formaterType(type) {
  if (!type) return type;
  
  // Convertit le type en minuscules pour une comparaison insensible à la casse
  const typeNormalise = type.toLowerCase();
  
  // Vérifie chaque type supporté
  for (const [_, typeData] of Object.entries(TYPES)) {
    // Vérifie si une des variantes est incluse dans la chaîne du type
    const varianteTrouvee = typeData.variantes.some(variante => 
      typeNormalise.includes(variante.toLowerCase())
    );
    
    if (varianteTrouvee) {
      return typeData.nom;
    }
  }
  return type; // Retourne le type inchangé si non reconnu
}

function extractMultipleUnits(description) {
  const text = description.toLowerCase();

  // Conversion des nombres écrits en lettres → entiers
  const numberWords = {
    "un": 1, "une": 1,
    "deux": 2,
    "trois": 3,
    "quatre": 4,
    "cinq": 5,
    "six": 6,
    "sept": 7,
    "huit": 8,
    "neuf": 9,
    "dix": 10
  };

  const results = {};

  // Regex améliorée pour capturer différentes formulations
  // - (1, 2, trois, etc.) suivi de types divers
  // - Supporte "appartement T2", "T3", "2 pièces", "studio", "F2", etc.
  // - Capture aussi les formulations comme "comprendant un appartement de type T3"
  const regex = /\b(\d+|un|une|deux|trois|quatre|cinq|six|sept|huit|neuf|dix)\s*(appartements?\s*)?(studio|t\s*1|t\s*2|t\s*3|t\s*4|t\s*5|t\s*6|f\s*1|f\s*2|f\s*3|f\s*4|f\s*5|f\s*6|\d+\s*pi[eè]ces?|type\s*t\s*[1-6]|duplex)\b/g;

  let match;
  while ((match = regex.exec(text)) !== null) {
    let quantity = match[1];
    let typeRaw = match[3]; // Le type est dans match[3]

    // Convertir le nombre
    if (isNaN(quantity)) {
      quantity = numberWords[quantity] || 1;
    } else {
      quantity = parseInt(quantity, 10);
    }

    // Normaliser le type
    let type = typeRaw
      .replace(/\s+/g, "")   // enlever espaces (t 2 → t2)
      .replace(/f/i, "t")    // f2 → t2
      .replace(/type/i, ""); // type t2 → t2

    if (type.includes("pièce")) {
      // "2 pièces" → T2
      const n = parseInt(type, 10);
      type = `t${n}`;
    }

    if (type === "studio" || type === "duplex") type = "T1";
    else type = type.toUpperCase(); // T2, T3...

    // Stocker
    results[type] = (results[type] || 0) + quantity;
  }

  // Deuxième passe: chercher les appartements sans nombre explicite (ex: "un appartement T3")
  const singleUnitRegex = /\b(appartement|logement|studio)\s*(de\s*type\s*)?(t\s*[1-6]|f\s*[1-6]|duplex)\b/g;
  while ((match = singleUnitRegex.exec(text)) !== null) {
    let typeRaw = match[3] || match[2]; // T3 ou F2
    let type = typeRaw
      .replace(/\s+/g, "")
      .replace(/f/i, "t");
    
    if (type === "studio" || type === "duplex") type = "Studio";
    else type = type.toUpperCase();

    results[type] = (results[type] || 0) + 1;
  }

  // Troisième passe: chercher "T2", "T3" etc. seuls (sans nombre)
  const simpleTypeRegex = /\b(t\s*[1-6]|f\s*[1-6]|studio|duplex)\b/g;
  while ((match = simpleTypeRegex.exec(text)) !== null) {
    let typeRaw = match[1];
    let type = typeRaw
      .replace(/\s+/g, "")
      .replace(/f/i, "t");
    
    if (type === "studio" || type === "duplex") type = "Studio";
    else type = type.toUpperCase();

    results[type] = (results[type] || 0) + 1;
  }

  return results;
}

function extractHouseRooms(description) {
  const text = description.toLowerCase();

  // 1. Détection "X pièces"
  const matchPieces = text.match(/(\d+)\s*(pi[eè]ces?)/);
  if (matchPieces) {
    return parseInt(matchPieces[1], 10);
  }

  // 2. Détection Tn / Fn
  const matchT = text.match(/\b[tf]\s*([1-9])\b/);
  if (matchT) {
    return parseInt(matchT[1], 10);
  }

  // 3. Déduction : "X chambres" + 1 pièce de vie
  const matchBedrooms = text.match(/(\d+)\s*chambres?/);
  if (matchBedrooms) {
    const bedrooms = parseInt(matchBedrooms[1], 10);
    // Hypothèse standard : 1 salon/séjour
    return bedrooms + 1;
  }

  // 4. Détection qualitative (ex: "maison familiale 6 pièces")
  const matchAfterMaison = text.match(/maison[^0-9]*?(\d+)\s*pi[eè]ces/);
  if (matchAfterMaison) {
    return parseInt(matchAfterMaison[1], 10);
  }

  // Si rien trouvé
  return null; // inconnu
}

export async function insertAnnonce(annonce) {
  if (!client) throw new Error("Client non initialisé");
  if (!annonce.lien) {
    console.error("Annonce sans lien:", annonce);
    return;
  }
  
  // Formate la ville si elle est présente
  if (annonce.ville) {
    annonce.ville = formaterVille(annonce.ville);
  }

  // Formate le type s'il est présent
  if (annonce.type) {
    annonce.type = formaterType(annonce.type);
  }

  // Vérifie si la ville est une des villes supportées
  const villesSupportees = Object.values(VILLES).map(v => v.nom);
  if (annonce.ville && !villesSupportees.includes(annonce.ville)) {
    console.log(`Annonce ignorée - ville non supportée: ${annonce.ville}`);
    return;
  }

  // Vérifie si le type est un des types supportés
  const typesSupportes = Object.values(TYPES).map(t => t.nom);
  if (annonce.type && !typesSupportes.includes(annonce.type)) {
    console.log(`Annonce ignorée - type non supporté: ${annonce.type}`);
    return;
  }

  // Extraire les informations sur les pièces selon le type de bien
  if (annonce.type && annonce.description) {
    if (annonce.type === 'Immeuble') {
      // Pour les immeubles, utiliser extractMultipleUnits
      const units = extractMultipleUnits(annonce.description);
      annonce.nb_t1 = units.T1 || 0;
      annonce.nb_t2 = units.T2 || 0;
      annonce.nb_t3 = units.T3 || 0;
      annonce.nb_t4 = units.T4 || 0;
      annonce.nb_t5 = units.T5 || 0;
      annonce.nb_pieces = 0; // Pour les immeubles, nb_pieces reste à 0
    } else if (annonce.type === 'Maison' && annonce.pieces == 0) {
      // Pour les maisons, utiliser extractHouseRooms
      const rooms = extractHouseRooms(annonce.description);
      annonce.pieces = rooms || 0;
    }
  }

  try {
    const upsertQuery = `
      INSERT INTO "Annonce" (type, prix, ville, pieces, surface, lien, agence, description, photos, nb_t1, nb_t2, nb_t3, nb_t4, nb_t5, dpe, ges, created_at, date_scraped)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, NOW(), NOW())
      ON CONFLICT (lien)
      DO UPDATE SET
        type = EXCLUDED.type,
        prix = EXCLUDED.prix,
        ville = EXCLUDED.ville,
        pieces = EXCLUDED.pieces,
        surface = EXCLUDED.surface,
        agence = EXCLUDED.agence,
        description = EXCLUDED.description,
        photos = EXCLUDED.photos,
        nb_t1 = EXCLUDED.nb_t1,
        nb_t2 = EXCLUDED.nb_t2,
        nb_t3 = EXCLUDED.nb_t3,
        nb_t4 = EXCLUDED.nb_t4,
        nb_t5 = EXCLUDED.nb_t5,
        dpe = EXCLUDED.dpe,
        ges = EXCLUDED.ges,
        date_scraped = NOW()
    `;

    const values = [
      annonce.type || null,
      annonce.prix || null,
      annonce.ville || null,
      annonce.pieces || null,
      annonce.surface || null,
      annonce.lien,
      annonce.agence,
      annonce.description || null,
      annonce.photos ? JSON.stringify(annonce.photos) : null,
      annonce.nb_t1,
      annonce.nb_t2,
      annonce.nb_t3,
      annonce.nb_t4,
      annonce.nb_t5,
      annonce.dpe || null,
      annonce.ges || null
    ];

    await client.query(upsertQuery, values);
  } catch (err) {
    console.error("Erreur insertion annonce (pg):", err);
  }
}

export async function insertErreur(scraper, url, message) {
  if (!client) throw new Error("Client non initialisé");

  try {
    const insertQuery = `
      INSERT INTO "Erreur" (scraper, url, message, date_erreur)
      VALUES ($1, $2, $3, NOW());
    `;

    const values = [scraper, url, message];
    await client.query(insertQuery, values);

    console.log(`⚠️ Erreur enregistrée pour ${scraper}: ${message}`);
  } catch (err) {
    console.error("Erreur lors de l'insertion dans la table Erreur:", err);
  }
}

/**
 * Supprime les annonces manquantes par rapport à la source.
 * @param {string} agence
 * @param {string[]} liensActuels
 */
export async function deleteMissingAnnonces(agence, liensActuels) {
  if (liensActuels.length === 0 || !client) return;

  try {
    const deleteQuery = `
      DELETE FROM "Annonce"
      WHERE agence = $1 AND lien NOT IN (${liensActuels.map((_, i) => `$${i + 2}`).join(", ")})
    `;
    const values = [agence, ...liensActuels];
    await client.query(deleteQuery, values);
  } catch (err) {
    console.error("Erreur suppression annonces (pg):", err);
  }
}

export async function updateScanTable(scraper, startTime) {
  if (!client) throw new Error("Client non initialisé");

  try {
    const endTime = Date.now();
    const duration = endTime - startTime;

    // Compter le nombre d'annonces et d'erreurs pour ce scraper
    const annoncesResult = await client.query(
      'SELECT COUNT(*) as count FROM "Annonce" WHERE agence = $1 AND date_scraped >= $2',
      [scraper, new Date(startTime).toISOString()]
    );
    const erreursResult = await client.query(
      'SELECT COUNT(*) as count FROM "Erreur" WHERE scraper = $1 AND date_erreur >= $2',
      [scraper, new Date(startTime).toISOString()]
    );

    const annoncesCount = parseInt(annoncesResult.rows[0].count);
    const erreursCount = parseInt(erreursResult.rows[0].count);

    // Upsert : insérer ou mettre à jour la ligne du scraper
    const upsertQuery = `
      INSERT INTO "Scan" (scraper, date_scan, status, annonces_count, erreurs_count, duree_ms)
      VALUES ($1, NOW(), 'completed', $2, $3, $4)
      ON CONFLICT (scraper) 
      DO UPDATE SET 
        date_scan = NOW(),
        status = 'completed',
        annonces_count = $2,
        erreurs_count = $3,
        duree_ms = $4
    `;

    await client.query(upsertQuery, [scraper, annoncesCount, erreursCount, duration]);
    console.log(`✅ Table 'Scan' mise à jour pour ${scraper}: ${annoncesCount} annonces, ${erreursCount} erreurs, ${duration}ms`);

  } catch (err) {
    console.error(`❌ Erreur mise à jour table Scan pour ${scraper}:`, err);
    throw err;
  }
}

export async function closeDb() {
  if (client) {
    client.release();
    client = null;
  }
  if (pool) {
    await pool.end();
    pool = null;
  }
  console.log("✅ Connexion à la base de données fermée");
}
