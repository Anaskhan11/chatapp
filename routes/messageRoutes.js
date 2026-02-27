/**
 * ============================================
 * MESSAGE ROUTES
 * ============================================
 * Messages CRUD operations
 * WhatsApp Features: star, forward, delete-for-everyone
 * ============================================
 */

const express = require("express");
const db = require("../config/database");
const { verifyToken } = require("../middleware/auth");

const router = express.Router();

// ============================================
// GET /api/messages/starred
// Get all starred messages for current user
// ============================================
router.get("/starred", verifyToken, async (req, res) => {
  try {
    const messages = await db.query(
      `SELECT 
        m.id,
        m.conversation_id,
        m.sender_id,
        m.type,
        m.content,
        m.media_url,
        m.media_duration,
        m.file_name,
        m.file_size,
        m.reply_to_message_id,
        m.status,
        m.created_at,
        u.username as sender_username,
        u.full_name as sender_fullname,
        u.avatar_url as sender_avatar,
        sm.starred_at,
        c.name as conversation_name,
        c.type as conversation_type,
        other_u.full_name as other_user_name
      FROM starred_messages sm
      JOIN messages m ON sm.message_id = m.id
      JOIN users u ON m.sender_id = u.id
      JOIN conversations c ON m.conversation_id = c.id
      LEFT JOIN conversation_participants cp2 ON c.id = cp2.conversation_id AND cp2.user_id != ? AND c.type = 'private'
      LEFT JOIN users other_u ON cp2.user_id = other_u.id
      WHERE sm.user_id = ? AND m.is_deleted = FALSE
      ORDER BY sm.starred_at DESC`,
      [req.userId, req.userId],
    );

    const formatted = messages.map((msg) => ({
      id: msg.id,
      conversationId: msg.conversation_id,
      conversationName:
        msg.conversation_type === "private"
          ? msg.other_user_name
          : msg.conversation_name,
      sender: {
        id: msg.sender_id,
        username: msg.sender_username,
        fullName: msg.sender_fullname,
        avatarUrl: msg.sender_avatar,
      },
      type: msg.type,
      content: msg.content,
      mediaUrl: msg.media_url,
      mediaDuration: msg.media_duration,
      fileName: msg.file_name,
      fileSize: msg.file_size,
      status: msg.status,
      starredAt: msg.starred_at,
      createdAt: msg.created_at,
    }));

    res.json({ success: true, data: { messages: formatted } });
  } catch (error) {
    console.error("Get starred messages error:", error);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// ============================================
// POST /api/messages/delete-for-me
// Delete messages for current user only
// ============================================
router.post("/delete-for-me", verifyToken, async (req, res) => {
  try {
    const { messageIds } = req.body;

    if (!messageIds || !Array.isArray(messageIds) || messageIds.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Please provide message IDs to delete",
      });
    }

    for (const messageId of messageIds) {
      await db.query(
        `INSERT IGNORE INTO message_deletions (message_id, user_id) VALUES (?, ?)`,
        [messageId, req.userId],
      );
    }

    res.json({
      success: true,
      message: `${messageIds.length} message(s) deleted for you`,
      data: { deletedIds: messageIds },
    });
  } catch (error) {
    console.error("Delete for me error:", error);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// ============================================
// POST /api/messages/delete-batch
// Delete multiple messages (soft delete - for everyone)
// ============================================
router.post("/delete-batch", verifyToken, async (req, res) => {
  try {
    const { messageIds } = req.body;

    if (!messageIds || !Array.isArray(messageIds) || messageIds.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Please provide message IDs to delete",
      });
    }

    const messages = await db.query(
      `SELECT id, sender_id FROM messages WHERE id IN (${messageIds.map(() => "?").join(",")}) AND is_deleted = FALSE`,
      messageIds,
    );

    const notOwnedMessages = messages.filter((m) => m.sender_id !== req.userId);
    const ownMessageIds = messages
      .filter((m) => m.sender_id === req.userId)
      .map((m) => m.id);

    if (ownMessageIds.length === 0) {
      return res.status(403).json({
        success: false,
        message: "You can only delete your own messages",
      });
    }

    await db.query(
      `UPDATE messages SET is_deleted = TRUE, content = 'This message was deleted' WHERE id IN (${ownMessageIds.map(() => "?").join(",")})`,
      ownMessageIds,
    );

    res.json({
      success: true,
      message: `${ownMessageIds.length} message(s) deleted successfully`,
      data: {
        deletedIds: ownMessageIds,
        skippedCount: notOwnedMessages.length,
      },
    });
  } catch (error) {
    console.error("Batch delete messages error:", error);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// ============================================
// POST /api/messages/forward
// Forward a message to one or more conversations
// ============================================
router.post("/forward", verifyToken, async (req, res) => {
  try {
    const { messageId, messageIds, conversationIds } = req.body;
    const idsToForward = messageIds || (messageId ? [messageId] : []);

    if (
      idsToForward.length === 0 ||
      !conversationIds ||
      !Array.isArray(conversationIds) ||
      conversationIds.length === 0
    ) {
      return res.status(400).json({
        success: false,
        message: "Please provide messageIds and conversationIds",
      });
    }

    const forwarded = [];

    for (const id of idsToForward) {
      // Get the original message
      const origMessages = await db.query(
        `SELECT * FROM messages WHERE id = ? AND is_deleted = FALSE`,
        [id],
      );

      if (origMessages.length === 0) continue;

      const orig = origMessages[0];

      for (const conversationId of conversationIds) {
        // Verify user is participant in target conversation
        const participant = await db.query(
          "SELECT 1 FROM conversation_participants WHERE conversation_id = ? AND user_id = ?",
          [conversationId, req.userId],
        );

        if (participant.length === 0) continue;

        // Insert forwarded message
        const result = await db.query(
          `INSERT INTO messages 
           (conversation_id, sender_id, type, content, media_url, media_duration, file_name, file_size, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'sent')`,
          [
            conversationId,
            req.userId,
            orig.type,
            orig.content,
            orig.media_url,
            orig.media_duration,
            orig.file_name,
            orig.file_size,
          ],
        );

        // Update conversation last message
        await db.query(
          "UPDATE conversations SET last_message_id = ?, last_message_time = NOW() WHERE id = ?",
          [result.insertId, conversationId],
        );

        forwarded.push({
          conversationId,
          messageId: result.insertId,
          originalId: id,
        });
      }
    }

    res.json({
      success: true,
      message: `Message forwarded to ${forwarded.length} conversation(s)`,
      data: { forwarded },
    });
  } catch (error) {
    console.error("Forward message error:", error);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// ============================================
// GET /api/messages/:conversationId
// Get messages for a conversation
// ============================================
router.get("/:conversationId", verifyToken, async (req, res) => {
  try {
    const conversationId = parseInt(req.params.conversationId);
    const { limit = 50, offset = 0 } = req.query;
    const limitNum = parseInt(limit);
    const offsetNum = parseInt(offset);

    if (isNaN(conversationId)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid conversation ID" });
    }

    const participant = await db.query(
      "SELECT 1 FROM conversation_participants WHERE conversation_id = ? AND user_id = ?",
      [conversationId, req.userId],
    );

    if (participant.length === 0) {
      return res.status(403).json({
        success: false,
        message: "You are not a participant in this conversation",
      });
    }

    // Get messages with sender info, read receipts, reply context, and star status
    const messages = await db.query(
      `SELECT 
        m.id,
        m.conversation_id,
        m.sender_id,
        m.type,
        m.content,
        m.media_url,
        m.media_duration,
        m.file_name,
        m.file_size,
        m.reply_to_message_id,
        m.status,
        m.created_at,
        m.updated_at,
        u.username as sender_username,
        u.full_name as sender_fullname,
        u.avatar_url as sender_avatar,
        (SELECT COUNT(*) FROM message_read_receipts WHERE message_id = m.id) as read_count,
        rm.content as reply_content,
        rm.type as reply_type,
        ru.full_name as reply_sender_name,
        (SELECT COUNT(*) FROM starred_messages sm WHERE sm.message_id = m.id AND sm.user_id = ?) as is_starred
      FROM messages m
      JOIN users u ON m.sender_id = u.id
      LEFT JOIN message_deletions md ON m.id = md.message_id AND md.user_id = ?
      LEFT JOIN messages rm ON m.reply_to_message_id = rm.id
      LEFT JOIN users ru ON rm.sender_id = ru.id
      WHERE m.conversation_id = ? AND m.is_deleted = FALSE AND md.id IS NULL
      ORDER BY m.created_at DESC
      LIMIT ? OFFSET ?`,
      [req.userId, req.userId, conversationId, limitNum, offsetNum],
    );

    const countResult = await db.query(
      `SELECT COUNT(*) as total FROM messages m
       LEFT JOIN message_deletions md ON m.id = md.message_id AND md.user_id = ?
       WHERE m.conversation_id = ? AND m.is_deleted = FALSE AND md.id IS NULL`,
      [req.userId, conversationId],
    );

    const formattedMessages = messages.map((msg) => ({
      id: msg.id,
      conversationId: msg.conversation_id,
      sender: {
        id: msg.sender_id,
        username: msg.sender_username,
        fullName: msg.sender_fullname,
        avatarUrl: msg.sender_avatar,
      },
      type: msg.type,
      content: msg.content,
      mediaUrl: msg.media_url,
      mediaDuration: msg.media_duration,
      fileName: msg.file_name,
      fileSize: msg.file_size,
      replyToMessageId: msg.reply_to_message_id,
      replyTo: msg.reply_to_message_id
        ? {
            id: msg.reply_to_message_id,
            content: msg.reply_content,
            type: msg.reply_type,
            senderName: msg.reply_sender_name,
          }
        : null,
      status: msg.status || "sent",
      readCount: msg.read_count,
      isStarred: msg.is_starred > 0,
      createdAt: msg.created_at,
      updatedAt: msg.updated_at,
    }));

    res.json({
      success: true,
      data: {
        messages: formattedMessages.reverse(),
        pagination: {
          total: countResult[0].total,
          limit: limitNum,
          offset: offsetNum,
          hasMore: offsetNum + messages.length < countResult[0].total,
        },
      },
    });
  } catch (error) {
    console.error("Get messages error:", error);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// ============================================
// POST /api/messages/:conversationId
// Send a new message
// ============================================
router.post("/:conversationId", verifyToken, async (req, res) => {
  try {
    const conversationId = parseInt(req.params.conversationId);
    const {
      type = "text",
      content,
      mediaUrl,
      mediaDuration,
      fileName,
      fileSize,
      replyToMessageId,
    } = req.body;

    if (isNaN(conversationId)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid conversation ID" });
    }

    const validTypes = ["text", "image", "voice", "video", "file", "call"];
    if (!validTypes.includes(type)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid message type" });
    }

    if (type === "text" && (!content || content.trim().length === 0)) {
      return res
        .status(400)
        .json({ success: false, message: "Text message cannot be empty" });
    }

    if (
      (type === "image" ||
        type === "voice" ||
        type === "video" ||
        type === "file") &&
      !mediaUrl
    ) {
      return res.status(400).json({
        success: false,
        message: "Media URL is required for this message type",
      });
    }

    const participant = await db.query(
      "SELECT 1 FROM conversation_participants WHERE conversation_id = ? AND user_id = ?",
      [conversationId, req.userId],
    );

    if (participant.length === 0) {
      return res.status(403).json({
        success: false,
        message: "You are not a participant in this conversation",
      });
    }

    const result = await db.query(
      `INSERT INTO messages 
       (conversation_id, sender_id, type, content, media_url, media_duration, file_name, file_size, reply_to_message_id, status) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'sent')`,
      [
        conversationId,
        req.userId,
        type,
        content || null,
        mediaUrl || null,
        mediaDuration || null,
        fileName || null,
        fileSize || null,
        replyToMessageId || null,
      ],
    );

    const messageId = result.insertId;

    const messages = await db.query(
      `SELECT 
        m.*,
        u.username as sender_username,
        u.full_name as sender_fullname,
        u.avatar_url as sender_avatar,
        rm.content as reply_content,
        rm.type as reply_type,
        ru.full_name as reply_sender_name
      FROM messages m
      JOIN users u ON m.sender_id = u.id
      LEFT JOIN messages rm ON m.reply_to_message_id = rm.id
      LEFT JOIN users ru ON rm.sender_id = ru.id
      WHERE m.id = ?`,
      [messageId],
    );

    const msg = messages[0];

    const formattedMessage = {
      id: msg.id,
      conversationId: msg.conversation_id,
      sender: {
        id: msg.sender_id,
        username: msg.sender_username,
        fullName: msg.sender_fullname,
        avatarUrl: msg.sender_avatar,
      },
      type: msg.type,
      content: msg.content,
      mediaUrl: msg.media_url,
      mediaDuration: msg.media_duration,
      fileName: msg.file_name,
      fileSize: msg.file_size,
      replyToMessageId: msg.reply_to_message_id,
      replyTo: msg.reply_to_message_id
        ? {
            id: msg.reply_to_message_id,
            content: msg.reply_content,
            type: msg.reply_type,
            senderName: msg.reply_sender_name,
          }
        : null,
      status: "sent",
      readCount: 0,
      isStarred: false,
      createdAt: msg.created_at,
      updatedAt: msg.updated_at,
    };

    res.status(201).json({
      success: true,
      message: "Message sent successfully",
      data: { message: formattedMessage },
    });
  } catch (error) {
    console.error("Send message error:", error);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// ============================================
// POST /api/messages/:messageId/star
// Star a message
// ============================================
router.post("/:messageId/star", verifyToken, async (req, res) => {
  try {
    const messageId = parseInt(req.params.messageId);

    if (isNaN(messageId)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid message ID" });
    }

    // Verify user can access this message (is a conversation participant)
    const msg = await db.query(
      `SELECT m.conversation_id FROM messages m
       JOIN conversation_participants cp ON m.conversation_id = cp.conversation_id
       WHERE m.id = ? AND cp.user_id = ? AND m.is_deleted = FALSE`,
      [messageId, req.userId],
    );

    if (msg.length === 0) {
      return res
        .status(404)
        .json({ success: false, message: "Message not found" });
    }

    await db.query(
      `INSERT IGNORE INTO starred_messages (user_id, message_id) VALUES (?, ?)`,
      [req.userId, messageId],
    );

    res.json({ success: true, message: "Message starred" });
  } catch (error) {
    console.error("Star message error:", error);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// ============================================
// DELETE /api/messages/:messageId/star
// Unstar a message
// ============================================
router.delete("/:messageId/star", verifyToken, async (req, res) => {
  try {
    const messageId = parseInt(req.params.messageId);

    if (isNaN(messageId)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid message ID" });
    }

    await db.query(
      `DELETE FROM starred_messages WHERE user_id = ? AND message_id = ?`,
      [req.userId, messageId],
    );

    res.json({ success: true, message: "Message unstarred" });
  } catch (error) {
    console.error("Unstar message error:", error);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// ============================================
// DELETE /api/messages/:messageId/everyone
// Delete for everyone (sender only, within 60 min)
// ============================================
router.delete("/:messageId/everyone", verifyToken, async (req, res) => {
  try {
    const messageId = parseInt(req.params.messageId);

    if (isNaN(messageId)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid message ID" });
    }

    const messages = await db.query(
      "SELECT sender_id, created_at, conversation_id FROM messages WHERE id = ? AND is_deleted = FALSE",
      [messageId],
    );

    if (messages.length === 0) {
      return res
        .status(404)
        .json({ success: false, message: "Message not found" });
    }

    const msg = messages[0];

    if (msg.sender_id !== req.userId) {
      return res.status(403).json({
        success: false,
        message: "You can only delete your own messages for everyone",
      });
    }

    // Check 60 minute window
    const minutesOld =
      (Date.now() - new Date(msg.created_at).getTime()) / 60000;
    if (minutesOld > 60) {
      return res.status(400).json({
        success: false,
        message: "You can only delete messages within 60 minutes of sending",
      });
    }

    await db.query(
      `UPDATE messages SET is_deleted = TRUE, content = 'This message was deleted' WHERE id = ?`,
      [messageId],
    );

    res.json({
      success: true,
      message: "Message deleted for everyone",
      data: { messageId, conversationId: msg.conversation_id },
    });
  } catch (error) {
    console.error("Delete for everyone error:", error);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// ============================================
// PUT /api/messages/:messageId
// Edit a message
// ============================================
router.put("/:messageId", verifyToken, async (req, res) => {
  try {
    const messageId = parseInt(req.params.messageId);
    const { content } = req.body;

    if (isNaN(messageId)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid message ID" });
    }

    if (!content || content.trim().length === 0) {
      return res
        .status(400)
        .json({ success: false, message: "Message content cannot be empty" });
    }

    const messages = await db.query(
      "SELECT sender_id, type FROM messages WHERE id = ? AND is_deleted = FALSE",
      [messageId],
    );

    if (messages.length === 0) {
      return res
        .status(404)
        .json({ success: false, message: "Message not found" });
    }

    if (messages[0].sender_id !== req.userId) {
      return res.status(403).json({
        success: false,
        message: "You can only edit your own messages",
      });
    }

    if (messages[0].type !== "text") {
      return res
        .status(400)
        .json({ success: false, message: "Only text messages can be edited" });
    }

    await db.query("UPDATE messages SET content = ? WHERE id = ?", [
      content.trim(),
      messageId,
    ]);

    const updatedMessages = await db.query(
      `SELECT m.*, u.username as sender_username, u.full_name as sender_fullname, u.avatar_url as sender_avatar
      FROM messages m JOIN users u ON m.sender_id = u.id WHERE m.id = ?`,
      [messageId],
    );

    const msg = updatedMessages[0];

    res.json({
      success: true,
      message: "Message updated successfully",
      data: {
        message: {
          id: msg.id,
          conversationId: msg.conversation_id,
          sender: {
            id: msg.sender_id,
            username: msg.sender_username,
            fullName: msg.sender_fullname,
            avatarUrl: msg.sender_avatar,
          },
          type: msg.type,
          content: msg.content,
          mediaUrl: msg.media_url,
          status: msg.status,
          createdAt: msg.created_at,
          updatedAt: msg.updated_at,
        },
      },
    });
  } catch (error) {
    console.error("Edit message error:", error);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// ============================================
// DELETE /api/messages/:messageId
// Delete a message (soft delete - for everyone)
// ============================================
router.delete("/:messageId", verifyToken, async (req, res) => {
  try {
    const messageId = parseInt(req.params.messageId);

    if (isNaN(messageId)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid message ID" });
    }

    const messages = await db.query(
      "SELECT sender_id FROM messages WHERE id = ? AND is_deleted = FALSE",
      [messageId],
    );

    if (messages.length === 0) {
      return res
        .status(404)
        .json({ success: false, message: "Message not found" });
    }

    if (messages[0].sender_id !== req.userId) {
      return res.status(403).json({
        success: false,
        message: "You can only delete your own messages",
      });
    }

    await db.query(
      'UPDATE messages SET is_deleted = TRUE, content = "This message was deleted" WHERE id = ?',
      [messageId],
    );

    res.json({ success: true, message: "Message deleted successfully" });
  } catch (error) {
    console.error("Delete message error:", error);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// ============================================
// POST /api/messages/:messageId/read
// Mark message as read
// ============================================
router.post("/:messageId/read", verifyToken, async (req, res) => {
  try {
    const messageId = parseInt(req.params.messageId);

    if (isNaN(messageId)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid message ID" });
    }

    const messages = await db.query(
      "SELECT conversation_id, sender_id FROM messages WHERE id = ?",
      [messageId],
    );

    if (messages.length === 0) {
      return res
        .status(404)
        .json({ success: false, message: "Message not found" });
    }

    const message = messages[0];

    if (message.sender_id === req.userId) {
      return res.json({
        success: true,
        message: "Cannot mark own message as read",
      });
    }

    const participant = await db.query(
      "SELECT 1 FROM conversation_participants WHERE conversation_id = ? AND user_id = ?",
      [message.conversation_id, req.userId],
    );

    if (participant.length === 0) {
      return res.status(403).json({
        success: false,
        message: "You are not a participant in this conversation",
      });
    }

    await db.query(
      "INSERT IGNORE INTO message_read_receipts (message_id, user_id) VALUES (?, ?)",
      [messageId, req.userId],
    );

    await db.query(
      `UPDATE conversation_participants SET last_read_message_id = ? WHERE conversation_id = ? AND user_id = ?`,
      [messageId, message.conversation_id, req.userId],
    );

    // Update message status to read
    await db.query(
      `UPDATE messages SET status = 'read' WHERE id = ? AND sender_id != ?`,
      [messageId, req.userId],
    );

    res.json({ success: true, message: "Message marked as read" });
  } catch (error) {
    console.error("Mark as read error:", error);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// ============================================
// GET /api/messages/:messageId/read-receipts
// Get read receipts for a message
// ============================================
router.get("/:messageId/read-receipts", verifyToken, async (req, res) => {
  try {
    const messageId = parseInt(req.params.messageId);

    if (isNaN(messageId)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid message ID" });
    }

    const messages = await db.query(
      "SELECT conversation_id, sender_id FROM messages WHERE id = ?",
      [messageId],
    );

    if (messages.length === 0) {
      return res
        .status(404)
        .json({ success: false, message: "Message not found" });
    }

    if (messages[0].sender_id !== req.userId) {
      return res.status(403).json({
        success: false,
        message: "Only the sender can see read receipts",
      });
    }

    const receipts = await db.query(
      `SELECT mrr.user_id, mrr.read_at, u.username, u.full_name, u.avatar_url
      FROM message_read_receipts mrr
      JOIN users u ON mrr.user_id = u.id
      WHERE mrr.message_id = ?
      ORDER BY mrr.read_at ASC`,
      [messageId],
    );

    res.json({
      success: true,
      data: {
        readReceipts: receipts.map((r) => ({
          userId: r.user_id,
          username: r.username,
          fullName: r.full_name,
          avatarUrl: r.avatar_url,
          readAt: r.read_at,
        })),
      },
    });
  } catch (error) {
    console.error("Get read receipts error:", error);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// ============================================
// POST /api/messages/star-batch
// Star/Unstar multiple messages
// ============================================
router.post("/star-batch", verifyToken, async (req, res) => {
  try {
    const { messageIds, action } = req.body; // action: 'star' or 'unstar'

    if (!messageIds || !Array.isArray(messageIds) || messageIds.length === 0) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid message IDs" });
    }

    if (action === "star") {
      for (const id of messageIds) {
        await db.query(
          "INSERT IGNORE INTO starred_messages (user_id, message_id) SELECT ?, id FROM messages WHERE id = ? AND is_deleted = FALSE",
          [req.userId, id],
        );
      }
    } else {
      await db.query(
        `DELETE FROM starred_messages WHERE user_id = ? AND message_id IN (${messageIds.map(() => "?").join(",")})`,
        [req.userId, ...messageIds],
      );
    }

    res.json({ success: true, message: `Messages ${action}red` });
  } catch (error) {
    console.error("Batch star error:", error);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

module.exports = router;
