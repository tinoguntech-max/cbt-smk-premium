const mysql = require('mysql2/promise');
require('dotenv').config();

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 50, // Increased from 10 to 50 for peak load
  queueLimit: 0, // Unlimited queue
  maxIdle: 10, // Maximum idle connections
  idleTimeout: 60000, // 60 seconds
  enableKeepAlive: true,
  keepAliveInitialDelay: 0,
  namedPlaceholders: true,
  timezone: '+07:00' // Asia/Jakarta (WIB)
});

module.exports = pool;
