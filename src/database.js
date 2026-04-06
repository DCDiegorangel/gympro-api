// backend/src/database.js
const { Pool } = require('pg');
require('dotenv').config();

console.log('📡 Conectando ao banco...');
console.log('   Usuário:', process.env.DB_USER);
console.log('   Banco:', process.env.DB_NAME);
console.log('   Host:', process.env.DB_HOST);

const pool = new Pool({
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    database: process.env.DB_NAME,
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