-- ============================================
-- WhatsApp Features Migration
-- ============================================

-- 1. Add 'status' column to messages table (sent → delivered → read)
ALTER TABLE messages ADD COLUMN IF NOT EXISTS status ENUM('sent','delivered','read') DEFAULT 'sent';

-- 2. Create starred_messages table
CREATE TABLE IF NOT EXISTS starred_messages (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  message_id INT NOT NULL,
  starred_at DATETIME DEFAULT NOW(),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
  UNIQUE KEY unique_star (user_id, message_id)
);

-- 3. Update existing messages to 'read' if they have read receipts
UPDATE messages m
SET m.status = 'read'
WHERE EXISTS (
  SELECT 1 FROM message_read_receipts mrr WHERE mrr.message_id = m.id
);
