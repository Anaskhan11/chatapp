/**
 * ============================================
 * DATABASE CONFIGURATION
 * ============================================
 * MySQL connection pool configuration
 * ============================================
 */

const mysql = require("mysql2/promise");

// Create connection pool
const pool = mysql.createPool({
  host: process.env.DB_HOST || "localhost",
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "" ,
  database: process.env.DB_NAME || "chatapp",
  port: process.env.DB_PORT || 3306,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 0,
});

// Test database connection
const testConnection = async () => {
  try {
    const connection = await pool.getConnection();
    console.log("Database connection test successful");
    connection.release();
    return true;
  } catch (error) {
    console.error("Database connection test failed:", error.message);
    throw error;
  }
};

// Execute query with parameters
const query = async (sql, params) => {
  try {
    const [results] = await pool.execute(sql, params);
    return results;
  } catch (error) {
    console.error("Database query error:", error.message);
    throw error;
  }
};

// Execute transaction
const transaction = async (callback) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await callback(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
};

// Close all connections
const closeConnection = async () => {
  try {
    await pool.end();
    console.log("Database connections closed");
  } catch (error) {
    console.error("Error closing database connections:", error.message);
  }
};

module.exports = {
  pool,
  testConnection,
  query,
  transaction,
  closeConnection,
};
