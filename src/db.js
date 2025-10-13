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

    await ensureTableExists();
  } catch (err) {
    console.error("❌ Erreur de connexion à la base de données:", err);
    throw err;
  }
}

async function ensureTableExists() {
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
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      date_scraped TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_annonce_lien ON "Annonce"(lien);
    CREATE INDEX IF NOT EXISTS idx_annonce_agence ON "Annonce"(agence);
  `;

  await client.query(createTableQuery);
  console.log("✅ Table 'Annonce' vérifiée/créée");
}

/**
 * Insère ou met à jour une annonce.
 * @param {Object} annonce
 * @param {string=} annonce.type
 * @param {string=} annonce.prix
 * @param {string=} annonce.ville
 * @param {string=} annonce.pieces
 * @param {string=} annonce.surface
 * @param {string=} annonce.lien
 * @param {string} annonce.agence
 * @param {string=} annonce.description
 * @param {string[]=} annonce.photos
 */
export async function insertAnnonce(annonce) {
  if (!client) throw new Error("Client non initialisé");
  if (!annonce.lien) {
    console.error("Annonce sans lien:", annonce);
    return;
  }

  try {
    const upsertQuery = `
      INSERT INTO "Annonce" (type, prix, ville, pieces, surface, lien, agence, description, photos, created_at, date_scraped)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())
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
    ];

    await client.query(upsertQuery, values);
  } catch (err) {
    console.error("Erreur insertion annonce (pg):", err);
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
