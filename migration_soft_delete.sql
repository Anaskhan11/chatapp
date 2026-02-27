ALTER TABLE conversation_participants ADD COLUMN is_deleted TINYINT(1) DEFAULT 0; ALTER TABLE conversation_participants ADD COLUMN deleted_at DATETIME DEFAULT NULL;
