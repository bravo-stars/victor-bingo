const { Pool } = require("pg");
const fs = require("fs");
const path = require("path");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

async function testDbConnection() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is missing!");
    return false;
  }
  try {
    await pool.query("SELECT 1");
    console.log("Neon Database connected successfully.");
    return true;
  } catch (error) {
    console.error("Neon Database connection failed:", error.message);
    return false;
  }
}

async function migrateDatabase() {
  const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  await pool.query(schema);
  console.log("Victor Bingo database schema is ready.");
}

module.exports = { pool, testDbConnection, migrateDatabase };
