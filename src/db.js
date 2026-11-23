
{
  "name": "victor-bingo",
  "version": "1.0.0",
  "private": true,
  "description": "Victor Bingo Telegram Game",
  "main": "src/index.js",
  "scripts": {
    "start": "node src/index.js"
  },
  "engines": {
    "node": ">=20"
  },
  "dependencies": {
    "dotenv": "^16.4.7",
    "express": "^4.21.2",
    "grammy": "^1.35.0",
    "pg": "^8.13.1"
  }
}

const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  },
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
    const result = await pool.query(
      "SELECT NOW() AS current_time"
    );

    console.log(
      "Neon Database connected successfully:",
      result.rows[0].current_time
    );

    return true;
  } catch (error) {
    console.error("Neon Database connection failed:", error.message);
    return false;
  }
}

module.exports = {
  pool,
  testDbConnection
};
