// backend/src/database.js
const { Pool } = require('pg');
require('dotenv').config();

console.log('📡 Conectando ao banco...');

// Usa DATABASE_URL no Render ou variáveis separadas no local
const pool = new Pool({
    connectionString: process.env.DATABASE_URL || `postgresql://${process.env.DB_USER}:${process.env.DB_PASSWORD}@${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME}`,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Testar conexão
pool.query('SELECT NOW()', (err, res) => {
    if (err) {
        console.error('❌ Erro ao conectar:', err.message);
    } else {
        console.log('✅ Conectado ao PostgreSQL com sucesso!');
        console.log('   Hora do servidor:', res.rows[0].now);
    }
});

module.exports = pool;