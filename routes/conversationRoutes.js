/**
 * ============================================
 * CONVERSATION ROUTES
 * ============================================
 * Chat conversations and participants management
 * ============================================
 */

const express = require("express");
const db = require("../config/database");
const { verifyToken } = require("../middleware/auth");

const router = express.Router();

// ============================================
// GET /api/conversations
// Get all conversations for current user
// ============================================
router.get("/", verifyToken, async (req, res) => {
  try {
    const { limit = 20, offset = 0 } = req.query;
    const limitNum = parseInt(limit);
    const offsetNum = parseInt(offset);

    // Get conversations with last message and unread count
    // Exclude soft-deleted conversations
    const conversations = await db.query(
      `SELECT 
        c.id as conversation_id,
        c.type,
        c.name,
        c.avatar_url as conversation_avatar,
        c.last_message_time,
        m.id as last_message_id,
        m.content as last_message_content,
        m.type as last_message_type,
        m.sender_id as last_message_sender_id,
        sender.username as last_message_sender_username,
        sender.full_name as last_message_sender_name,
        sender.avatar_url as last_message_sender_avatar,
        u.id as other_user_id,
        u.username as other_user_username,
        u.full_name as other_user_fullname,
        u.avatar_url as other_user_avatar,
        u.is_online as other_user_online,
        u.last_seen as other_user_last_seen,
        cp.last_read_message_id,
        (SELECT COUNT(*) FROM messages 
         WHERE conversation_id = c.id 
         AND id > COALESCE(cp.last_read_message_id, 0)
         AND sender_id != ?) as unread_count
      FROM conversations c
      JOIN conversation_participants cp ON c.id = cp.conversation_id
      LEFT JOIN messages m ON c.last_message_id = m.id
      LEFT JOIN users sender ON m.sender_id = sender.id
      LEFT JOIN conversation_participants cp2 ON c.id = cp2.conversation_id AND cp2.user_id != ?
      LEFT JOIN users u ON cp2.user_id = u.id
      WHERE cp.user_id = ? AND (cp.is_deleted = 0 OR cp.is_deleted IS NULL)
      ORDER BY c.last_message_time DESC
      LIMIT ? OFFSET ?`,
      [req.userId, req.userId, req.userId, limitNum, offsetNum],
    );

    // Format response
    const formattedConversations = conversations.map((conv) => ({
      id: conv.conversation_id,
      type: conv.type,
      name: conv.type === "private" ? conv.other_user_fullname : conv.name,
      avatar:
        conv.type === "private"
          ? conv.other_user_avatar
          : conv.conversation_avatar,
      otherUser:
        conv.type === "private"
          ? {
              id: conv.other_user_id,
              username: conv.other_user_username,
              fullName: conv.other_user_fullname,
              avatarUrl: conv.other_user_avatar,
              isOnline: conv.other_user_online,
              lastSeen: conv.other_user_last_seen,
            }
          : null,
      lastMessage: conv.last_message_id
        ? {
            id: conv.last_message_id,
            content: conv.last_message_content,
            type: conv.last_message_type,
            sender: {
              id: conv.last_message_sender_id,
              username: conv.last_message_sender_username,
              fullName: conv.last_message_sender_name,
              avatarUrl: conv.last_message_sender_avatar,
            },
            createdAt: conv.last_message_time,
          }
        : null,
      unreadCount: conv.unread_count,
      lastMessageTime: conv.last_message_time,
    }));

    res.json({
      success: true,
      data: {
        conversations: formattedConversations,
        pagination: {
          limit: limitNum,
          offset: offsetNum,
        },
      },
    });
  } catch (error) {
    console.error("Get conversations error:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
});

// ============================================
// POST /api/conversations
// Create a new conversation (private or group)
// ============================================
router.post("/", verifyToken, async (req, res) => {
  try {
    const { type = "private", participantIds, name } = req.body;

    if (
      !participantIds ||
      !Array.isArray(participantIds) ||
      participantIds.length === 0
    ) {
      return res.status(400).json({
        success: false,
        message: "Please provide participant IDs",
      });
    }

    // Add current user to participants
    const allParticipants = [...new Set([req.userId, ...participantIds])];

    // For private conversations, check if already exists
    if (type === "private" && allParticipants.length === 2) {
      const otherUserId = allParticipants.find((id) => id !== req.userId);

      const existingConv = await db.query(
        `SELECT c.id 
         FROM conversations c
         JOIN conversation_participants cp1 ON c.id = cp1.conversation_id
         JOIN conversation_participants cp2 ON c.id = cp2.conversation_id
         WHERE c.type = 'private'
         AND cp1.user_id = ?
         AND cp2.user_id = ?`,
        [req.userId, otherUserId],
      );

      if (existingConv.length > 0) {
        // Return existing conversation
        const conv = await getConversationById(existingConv[0].id, req.userId);
        return res.json({
          success: true,
          message: "Conversation already exists",
          data: { conversation: conv },
        });
      }
    }

    // Create conversation
    const convResult = await db.query(
      "INSERT INTO conversations (type, name, created_by) VALUES (?, ?, ?)",
      [type, name || null, req.userId],
    );

    const conversationId = convResult.insertId;

    // Add participants
    for (const userId of allParticipants) {
      await db.query(
        "INSERT INTO conversation_participants (conversation_id, user_id, is_admin) VALUES (?, ?, ?)",
        [conversationId, userId, userId === req.userId],
      );
    }

    // Get created conversation
    const conversation = await getConversationById(conversationId, req.userId);

    res.status(201).json({
      success: true,
      message: "Conversation created successfully",
      data: { conversation },
    });
  } catch (error) {
    console.error("Create conversation error:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
});

// ============================================
// GET /api/conversations/:id
// Get conversation by ID
// ============================================
router.get("/:id", verifyToken, async (req, res) => {
  try {
    const conversationId = parseInt(req.params.id);

    if (isNaN(conversationId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid conversation ID",
      });
    }

    // Check if user is participant
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

    const conversation = await getConversationById(conversationId, req.userId);

    res.json({
      success: true,
      data: { conversation },
    });
  } catch (error) {
    console.error("Get conversation error:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
});

// ============================================
// GET /api/conversations/:id/participants
// Get conversation participants
// ============================================
router.get("/:id/participants", verifyToken, async (req, res) => {
  try {
    const conversationId = parseInt(req.params.id);

    if (isNaN(conversationId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid conversation ID",
      });
    }

    // Check if user is participant
    const isParticipant = await db.query(
      "SELECT 1 FROM conversation_participants WHERE conversation_id = ? AND user_id = ?",
      [conversationId, req.userId],
    );

    if (isParticipant.length === 0) {
      return res.status(403).json({
        success: false,
        message: "You are not a participant in this conversation",
      });
    }

    const participants = await db.query(
      `SELECT 
        u.id,
        u.username,
        u.full_name,
        u.avatar_url,
        u.is_online,
        u.last_seen,
        cp.is_admin,
        cp.joined_at
      FROM conversation_participants cp
      JOIN users u ON cp.user_id = u.id
      WHERE cp.conversation_id = ?
      ORDER BY cp.joined_at ASC`,
      [conversationId],
    );

    res.json({
      success: true,
      data: {
        participants: participants.map((p) => ({
          id: p.id,
          username: p.username,
          fullName: p.full_name,
          avatarUrl: p.avatar_url,
          isOnline: p.is_online,
          lastSeen: p.last_seen,
          isAdmin: p.is_admin,
          joinedAt: p.joined_at,
        })),
      },
    });
  } catch (error) {
    console.error("Get participants error:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
});

// ============================================
// POST /api/conversations/:id/participants
// Add participant to group conversation
// ============================================
router.post("/:id/participants", verifyToken, async (req, res) => {
  try {
    const conversationId = parseInt(req.params.id);
    const { userId } = req.body;

    if (isNaN(conversationId) || !userId) {
      return res.status(400).json({
        success: false,
        message: "Invalid conversation ID or user ID",
      });
    }

    // Check if conversation is a group
    const conversation = await db.query(
      "SELECT type FROM conversations WHERE id = ?",
      [conversationId],
    );

    if (conversation.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Conversation not found",
      });
    }

    if (conversation[0].type !== "group") {
      return res.status(400).json({
        success: false,
        message: "Can only add participants to group conversations",
      });
    }

    // Check if current user is admin
    const isAdmin = await db.query(
      "SELECT is_admin FROM conversation_participants WHERE conversation_id = ? AND user_id = ?",
      [conversationId, req.userId],
    );

    if (isAdmin.length === 0 || !isAdmin[0].is_admin) {
      return res.status(403).json({
        success: false,
        message: "Only admins can add participants",
      });
    }

    // Check if user is already a participant
    const existingParticipant = await db.query(
      "SELECT 1 FROM conversation_participants WHERE conversation_id = ? AND user_id = ?",
      [conversationId, userId],
    );

    if (existingParticipant.length > 0) {
      return res.status(409).json({
        success: false,
        message: "User is already a participant",
      });
    }

    // Add participant
    await db.query(
      "INSERT INTO conversation_participants (conversation_id, user_id) VALUES (?, ?)",
      [conversationId, userId],
    );

    res.json({
      success: true,
      message: "Participant added successfully",
    });
  } catch (error) {
    console.error("Add participant error:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
});

// ============================================
// DELETE /api/conversations/:id/participants/:userId
// Remove participant from group
// ============================================
router.delete("/:id/participants/:userId", verifyToken, async (req, res) => {
  try {
    const conversationId = parseInt(req.params.id);
    const userIdToRemove = parseInt(req.params.userId);

    if (isNaN(conversationId) || isNaN(userIdToRemove)) {
      return res.status(400).json({
        success: false,
        message: "Invalid conversation ID or user ID",
      });
    }

    // Check if current user is admin or removing themselves
    const isAdmin = await db.query(
      "SELECT is_admin FROM conversation_participants WHERE conversation_id = ? AND user_id = ?",
      [conversationId, req.userId],
    );

    if (isAdmin.length === 0) {
      return res.status(403).json({
        success: false,
        message: "You are not a participant in this conversation",
      });
    }

    // Allow self-removal or admin removal
    if (req.userId !== userIdToRemove && !isAdmin[0].is_admin) {
      return res.status(403).json({
        success: false,
        message: "Only admins can remove other participants",
      });
    }

    // Remove participant
    await db.query(
      "DELETE FROM conversation_participants WHERE conversation_id = ? AND user_id = ?",
      [conversationId, userIdToRemove],
    );

    res.json({
      success: true,
      message: "Participant removed successfully",
    });
  } catch (error) {
    console.error("Remove participant error:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
});

// ============================================
// PUT /api/conversations/:id/read
// Mark conversation as read
// ============================================
router.put("/:id/read", verifyToken, async (req, res) => {
  try {
    const conversationId = parseInt(req.params.id);

    if (isNaN(conversationId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid conversation ID",
      });
    }

    // Get last message ID
    const lastMessage = await db.query(
      "SELECT id FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1",
      [conversationId],
    );

    if (lastMessage.length > 0) {
      // Update last read message
      await db.query(
        `UPDATE conversation_participants 
         SET last_read_message_id = ? 
         WHERE conversation_id = ? AND user_id = ?`,
        [lastMessage[0].id, conversationId, req.userId],
      );

      // Add read receipts
      await db.query(
        `INSERT IGNORE INTO message_read_receipts (message_id, user_id)
         SELECT id, ? FROM messages 
         WHERE conversation_id = ? AND sender_id != ?`,
        [req.userId, conversationId, req.userId],
      );
    }

    res.json({
      success: true,
      message: "Conversation marked as read",
    });
  } catch (error) {
    console.error("Mark as read error:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
});

// ============================================
// DELETE /api/conversations/delete
// Soft delete conversations for current user (batch delete)
// ============================================
router.post("/delete", verifyToken, async (req, res) => {
  try {
    const { conversationIds } = req.body;

    if (
      !conversationIds ||
      !Array.isArray(conversationIds) ||
      conversationIds.length === 0
    ) {
      return res.status(400).json({
        success: false,
        message: "Please provide conversation IDs to delete",
      });
    }

    // Soft delete - mark as deleted for this user only
    // Other users will still see the conversation
    for (const convId of conversationIds) {
      await db.query(
        `UPDATE conversation_participants 
         SET is_deleted = 1, deleted_at = NOW() 
         WHERE conversation_id = ? AND user_id = ?`,
        [convId, req.userId],
      );
    }

    res.json({
      success: true,
      message: `${conversationIds.length} conversation(s) deleted successfully`,
    });
  } catch (error) {
    console.error("Delete conversations error:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
});

// ============================================
// Helper function to get conversation by ID
// ============================================
async function getConversationById(conversationId, currentUserId) {
  const conversations = await db.query(
    `SELECT 
      c.id as conversation_id,
      c.type,
      c.name,
      c.avatar_url as conversation_avatar,
      c.last_message_time,
      m.id as last_message_id,
      m.content as last_message_content,
      m.type as last_message_type,
      m.sender_id as last_message_sender_id,
      sender.username as last_message_sender_username,
      sender.full_name as last_message_sender_name,
      sender.avatar_url as last_message_sender_avatar,
      u.id as other_user_id,
      u.username as other_user_username,
      u.full_name as other_user_fullname,
      u.avatar_url as other_user_avatar,
      u.is_online as other_user_online,
      u.last_seen as other_user_last_seen,
      cp.last_read_message_id,
      (SELECT COUNT(*) FROM messages 
       WHERE conversation_id = c.id 
       AND id > COALESCE(cp.last_read_message_id, 0)
       AND sender_id != ?) as unread_count
    FROM conversations c
    JOIN conversation_participants cp ON c.id = cp.conversation_id
    LEFT JOIN messages m ON c.last_message_id = m.id
    LEFT JOIN users sender ON m.sender_id = sender.id
    LEFT JOIN conversation_participants cp2 ON c.id = cp2.conversation_id AND cp2.user_id != ?
    LEFT JOIN users u ON cp2.user_id = u.id
    WHERE c.id = ? AND cp.user_id = ?`,
    [currentUserId, currentUserId, conversationId, currentUserId],
  );

  if (conversations.length === 0) {
    return null;
  }

  const conv = conversations[0];

  return {
    id: conv.conversation_id,
    type: conv.type,
    name: conv.type === "private" ? conv.other_user_fullname : conv.name,
    avatar:
      conv.type === "private"
        ? conv.other_user_avatar
        : conv.conversation_avatar,
    otherUser:
      conv.type === "private"
        ? {
            id: conv.other_user_id,
            username: conv.other_user_username,
            fullName: conv.other_user_fullname,
            avatarUrl: conv.other_user_avatar,
            isOnline: conv.other_user_online,
            lastSeen: conv.other_user_last_seen,
          }
        : null,
    lastMessage: conv.last_message_id
      ? {
          id: conv.last_message_id,
          content: conv.last_message_content,
          type: conv.last_message_type,
          sender: {
            id: conv.last_message_sender_id,
            username: conv.last_message_sender_username,
            fullName: conv.last_message_sender_name,
            avatarUrl: conv.last_message_sender_avatar,
          },
          createdAt: conv.last_message_time,
        }
      : null,
    unreadCount: conv.unread_count,
    lastMessageTime: conv.last_message_time,
  };
}

module.exports = router;
