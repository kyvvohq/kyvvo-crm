const path = require('path');
const { Pool } = require('pg');
const { migrar: migrarBase } = require('@kyvvohq/db-migrate');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false,
});

function migrar() {
  return migrarBase({ pool, dir: path.join(__dirname, '..', 'db') });
}

module.exports = { pool, migrar };
