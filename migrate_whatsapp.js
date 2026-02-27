/**
 * WhatsApp Features Migration Script
 * Run with: node migrate_whatsapp.js
 */
require("dotenv").config();
const mysql = require("mysql2/promise");

async function migrate() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || "localhost",
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || "",
    database: process.env.DB_NAME || "chatapp",
    port: process.env.DB_PORT || 3306,
    multipleStatements: true,
  });

  console.log("Connected to database");

  // 1. Add status column to messages
  try {
    await conn.execute(
      `ALTER TABLE messages ADD COLUMN status ENUM('sent','delivered','read') DEFAULT 'sent'`,
    );
    console.log("✅ Added status column to messages");
  } catch (e) {
    if (e.code === "ER_DUP_FIELDNAME")
      console.log("⚠️  status column already exists");
    else throw e;
  }

  // 2. Create starred_messages table
  await conn.execute(`
    CREATE TABLE IF NOT EXISTS starred_messages (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      message_id INT NOT NULL,
      starred_at DATETIME DEFAULT NOW(),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
      UNIQUE KEY unique_star (user_id, message_id)
    )
  `);
  console.log("✅ Created starred_messages table");

  // 3. Backfill read status for messages that have read receipts
  const [result] = await conn.execute(`
    UPDATE messages m
    SET m.status = 'read'
    WHERE EXISTS (
      SELECT 1 FROM message_read_receipts mrr WHERE mrr.message_id = m.id
    ) AND m.status = 'sent'
  `);
  console.log(`✅ Backfilled ${result.affectedRows} messages to 'read'`);

  await conn.end();
  console.log("Migration complete!");
}

migrate().catch((err) => {
  console.error("Migration failed:", err.message);
  process.exit(1);
});
