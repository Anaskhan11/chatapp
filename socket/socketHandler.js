/**
 * ============================================
 * SOCKET.IO HANDLER
 * ============================================
 * Real-time messaging, typing indicators, and WebRTC signaling
 * WhatsApp Features: delivered status, read receipts
 * ============================================
 */

const db = require("../config/database");
const jwt = require("jsonwebtoken");
const { Expo } = require("expo-server-sdk");

// Create a new Expo SDK client
const expo = new Expo();

// Store connected users
const connectedUsers = new Map(); // userId -> socketId
const userSockets = new Map(); // socketId -> userId

module.exports = (io) => {
  // Authentication middleware
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth.token || socket.handshake.query.token;

      if (!token) {
        return next(new Error("Authentication error: Token required"));
      }

      const decoded = jwt.verify(token, process.env.JWT_SECRET);

      const users = await db.query(
        "SELECT id, username, email, full_name, avatar_url FROM users WHERE id = ?",
        [decoded.userId],
      );

      if (users.length === 0) {
        return next(new Error("Authentication error: User not found"));
      }

      socket.userId = decoded.userId;
      socket.user = users[0];
      next();
    } catch (error) {
      console.error("Socket auth error:", error.message);
      next(new Error("Authentication error: Invalid token"));
    }
  });

  io.on("connection", (socket) => {
    console.log(`User connected: ${socket.userId} (${socket.user.username})`);

    // Store connection
    connectedUsers.set(socket.userId, socket.id);
    userSockets.set(socket.id, socket.userId);

    // Update user online status
    updateUserOnlineStatus(socket.userId, true, socket.id);

    // Deliver any pending messages to this user
    deliverPendingMessages(socket.userId, io);

    // Join user's conversations
    joinUserConversations(socket);

    // ============================================
    // MESSAGE EVENTS
    // ============================================

    // Send message
    socket.on("send_message", async (data, callback) => {
      try {
        const {
          conversationId,
          type = "text",
          content,
          mediaUrl,
          mediaDuration,
          fileName,
          fileSize,
          replyToMessageId,
        } = data;

        // Validate
        if (!conversationId) {
          return callback?.({
            success: false,
            error: "Conversation ID required",
          });
        }

        // Check if user is participant
        const participant = await db.query(
          "SELECT 1 FROM conversation_participants WHERE conversation_id = ? AND user_id = ?",
          [conversationId, socket.userId],
        );

        if (participant.length === 0) {
          return callback?.({ success: false, error: "Not a participant" });
        }

        // Insert message
        const result = await db.query(
          `INSERT INTO messages 
           (conversation_id, sender_id, type, content, media_url, media_duration, file_name, file_size, reply_to_message_id, status) 
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'sent')`,
          [
            conversationId,
            socket.userId,
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

        // Get the created message with sender info and reply context
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

        // Determine initial delivered status for each recipient
        const otherParticipants = await db.query(
          `SELECT cp.user_id, u.push_token 
           FROM conversation_participants cp 
           JOIN users u ON cp.user_id = u.id 
           WHERE cp.conversation_id = ? AND cp.user_id != ?`,
          [conversationId, socket.userId],
        );

        // Check if any recipient is online → mark as delivered
        let anyOnline = false;
        for (const p of otherParticipants) {
          if (connectedUsers.has(p.user_id)) {
            anyOnline = true;
            break;
          }
        }

        let initialStatus = "sent";
        if (anyOnline) {
          initialStatus = "delivered";
          await db.query(
            `UPDATE messages SET status = 'delivered' WHERE id = ?`,
            [messageId],
          );
        }

        const messageData = {
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
          status: initialStatus,
          readCount: 0,
          createdAt: msg.created_at,
        };

        // Broadcast to conversation room
        io.to(`conversation_${conversationId}`).emit(
          "new_message",
          messageData,
        );

        // Update conversation last message
        await db.query(
          "UPDATE conversations SET last_message_id = ?, last_message_time = NOW() WHERE id = ?",
          [messageId, conversationId],
        );

        // Acknowledge sending immediately to frontend
        callback?.({ success: true, data: { message: messageData } });

        // Notify sender of delivered status if any recipient online
        if (anyOnline) {
          const senderSocketId = connectedUsers.get(socket.userId);
          if (senderSocketId) {
            io.to(senderSocketId).emit("message_status_update", {
              messageId,
              conversationId,
              status: "delivered",
            });
          }
        }

        // Send push notification to offline users
        let pushMessages = [];
        for (const participant of otherParticipants) {
          const participantSocketId = connectedUsers.get(participant.user_id);
          if (!participantSocketId && participant.push_token) {
            if (Expo.isExpoPushToken(participant.push_token)) {
              let bodyText = content;
              if (type === "image") bodyText = "📷 Photo";
              if (type === "voice") bodyText = "🎤 Voice message";
              if (type === "video") bodyText = "🎥 Video";
              if (type === "file") bodyText = "📎 File";

              pushMessages.push({
                to: participant.push_token,
                sound: "default",
                title: msg.sender_fullname || "New Message",
                body: bodyText,
                data: { conversationId },
              });
            }
          }
        }

        if (pushMessages.length > 0) {
          let chunks = expo.chunkPushNotifications(pushMessages);
          for (let chunk of chunks) {
            try {
              expo
                .sendPushNotificationsAsync(chunk)
                .catch((err) => console.error("Push Error:", err));
            } catch (error) {
              console.error("Error sending push notification:", error);
            }
          }
        }
      } catch (error) {
        console.error("Send message error:", error);
        callback?.({ success: false, error: "Failed to send message" });
      }
    });

    // Typing indicator
    socket.on("typing", async (data) => {
      try {
        const { conversationId, isTyping } = data;

        // Check if user is participant
        const participant = await db.query(
          "SELECT 1 FROM conversation_participants WHERE conversation_id = ? AND user_id = ?",
          [conversationId, socket.userId],
        );

        if (participant.length > 0) {
          socket.to(`conversation_${conversationId}`).emit("user_typing", {
            conversationId,
            userId: socket.userId,
            username: socket.user.username,
            isTyping,
          });
        }
      } catch (error) {
        console.error("Typing indicator error:", error);
      }
    });

    // Mark messages as read
    socket.on("mark_read", async (data, callback) => {
      try {
        const { conversationId, messageId } = data;

        // Update last read message
        await db.query(
          `UPDATE conversation_participants 
           SET last_read_message_id = ? 
           WHERE conversation_id = ? AND user_id = ?`,
          [messageId, conversationId, socket.userId],
        );

        // Add read receipt
        await db.query(
          `INSERT IGNORE INTO message_read_receipts (message_id, user_id) VALUES (?, ?)`,
          [messageId, socket.userId],
        );

        // Update status to 'read' for all messages in this conversation up to messageId sent by others
        await db.query(
          `UPDATE messages SET status = 'read' 
           WHERE conversation_id = ? AND id <= ? AND sender_id != ? AND status != 'read'`,
          [conversationId, messageId, socket.userId],
        );

        // Notify senders in this conversation
        const affectedSenders = await db.query(
          `SELECT DISTINCT sender_id FROM messages 
           WHERE conversation_id = ? AND id <= ? AND sender_id != ?`,
          [conversationId, messageId, socket.userId],
        );

        for (const row of affectedSenders) {
          const senderSocketId = connectedUsers.get(row.sender_id);
          if (senderSocketId) {
            io.to(senderSocketId).emit("message_status_update", {
              conversationId,
              messageId,
              status: "read",
              readBy: socket.userId,
            });
          }
        }

        callback?.({ success: true });
      } catch (error) {
        console.error("Mark read error:", error);
        callback?.({ success: false, error: "Failed to mark as read" });
      }
    });

    // ============================================
    // WEBRTC CALLING EVENTS
    // ============================================

    // Initiate call
    socket.on("call_initiate", async (data, callback) => {
      try {
        const { calleeId, type, conversationId } = data;

        // Create call record
        const result = await db.query(
          "INSERT INTO calls (caller_id, callee_id, conversation_id, type, status) VALUES (?, ?, ?, ?, ?)",
          [socket.userId, calleeId, conversationId || null, type, "ongoing"],
        );

        const callId = result.insertId;

        // Notify callee
        const calleeSocketId = connectedUsers.get(calleeId);
        if (calleeSocketId) {
          io.to(calleeSocketId).emit("incoming_call", {
            callId,
            caller: socket.user,
            type,
          });
        }

        callback?.({ success: true, data: { callId } });
      } catch (error) {
        console.error("Call initiate error:", error);
        callback?.({ success: false, error: "Failed to initiate call" });
      }
    });

    // Answer call
    socket.on("call_answer", async (data, callback) => {
      try {
        const { callId } = data;

        const calls = await db.query("SELECT * FROM calls WHERE id = ?", [
          callId,
        ]);

        if (calls.length === 0) {
          return callback?.({ success: false, error: "Call not found" });
        }

        const call = calls[0];

        await db.query('UPDATE calls SET status = "answered" WHERE id = ?', [
          callId,
        ]);

        const callerSocketId = connectedUsers.get(call.caller_id);
        if (callerSocketId) {
          io.to(callerSocketId).emit("call_answered", {
            callId,
            callee: socket.user,
          });
        }

        callback?.({ success: true });
      } catch (error) {
        console.error("Call answer error:", error);
        callback?.({ success: false, error: "Failed to answer call" });
      }
    });

    // Reject call
    socket.on("call_reject", async (data, callback) => {
      try {
        const { callId } = data;

        const calls = await db.query("SELECT * FROM calls WHERE id = ?", [
          callId,
        ]);

        if (calls.length === 0) {
          return callback?.({ success: false, error: "Call not found" });
        }

        const call = calls[0];

        await db.query(
          'UPDATE calls SET status = "rejected", ended_at = NOW() WHERE id = ?',
          [callId],
        );

        const callerSocketId = connectedUsers.get(call.caller_id);
        if (callerSocketId) {
          io.to(callerSocketId).emit("call_rejected", {
            callId,
            callee: socket.user,
          });
        }

        callback?.({ success: true });
      } catch (error) {
        console.error("Call reject error:", error);
        callback?.({ success: false, error: "Failed to reject call" });
      }
    });

    // End call
    socket.on("call_end", async (data, callback) => {
      try {
        const { callId } = data;

        const calls = await db.query("SELECT * FROM calls WHERE id = ?", [
          callId,
        ]);

        if (calls.length === 0) {
          return callback?.({ success: false, error: "Call not found" });
        }

        const call = calls[0];

        let durationSeconds = 0;
        if (call.status === "answered") {
          const startTime = new Date(call.started_at);
          const endTime = new Date();
          durationSeconds = Math.floor((endTime - startTime) / 1000);
        }

        await db.query(
          'UPDATE calls SET status = "ended", ended_at = NOW(), duration_seconds = ? WHERE id = ?',
          [durationSeconds, callId],
        );

        const otherUserId =
          call.caller_id === socket.userId ? call.callee_id : call.caller_id;
        const otherSocketId = connectedUsers.get(otherUserId);

        if (otherSocketId) {
          io.to(otherSocketId).emit("call_ended", {
            callId,
            duration: durationSeconds,
          });
        }

        callback?.({ success: true, data: { duration: durationSeconds } });
      } catch (error) {
        console.error("Call end error:", error);
        callback?.({ success: false, error: "Failed to end call" });
      }
    });

    // WebRTC signaling - ICE candidate
    socket.on("webrtc_ice_candidate", (data) => {
      const { targetUserId, candidate } = data;
      const targetSocketId = connectedUsers.get(targetUserId);

      if (targetSocketId) {
        io.to(targetSocketId).emit("webrtc_ice_candidate", {
          senderId: socket.userId,
          candidate,
        });
      }
    });

    // WebRTC signaling - offer
    socket.on("webrtc_offer", (data) => {
      const { targetUserId, offer } = data;
      const targetSocketId = connectedUsers.get(targetUserId);

      if (targetSocketId) {
        io.to(targetSocketId).emit("webrtc_offer", {
          senderId: socket.userId,
          offer,
        });
      }
    });

    // WebRTC signaling - answer
    socket.on("webrtc_answer", (data) => {
      const { targetUserId, answer } = data;
      const targetSocketId = connectedUsers.get(targetUserId);

      if (targetSocketId) {
        io.to(targetSocketId).emit("webrtc_answer", {
          senderId: socket.userId,
          answer,
        });
      }
    });

    // ============================================
    // USER PRESENCE EVENTS
    // ============================================

    // Get online users
    socket.on("get_online_users", async (callback) => {
      try {
        const onlineUserIds = Array.from(connectedUsers.keys());

        if (onlineUserIds.length === 0) {
          return callback?.({ success: true, data: { users: [] } });
        }

        const placeholders = onlineUserIds.map(() => "?").join(", ");
        const users = await db.query(
          `SELECT id, username, full_name, avatar_url, is_online, last_seen 
           FROM users 
           WHERE id IN (${placeholders})`,
          onlineUserIds,
        );

        callback?.({
          success: true,
          data: {
            users: users.map((u) => ({
              id: u.id,
              username: u.username,
              fullName: u.full_name,
              avatarUrl: u.avatar_url,
              isOnline: u.is_online,
              lastSeen: u.last_seen,
            })),
          },
        });
      } catch (error) {
        console.error("Get online users error:", error);
        callback?.({ success: false, error: "Failed to get online users" });
      }
    });

    // ============================================
    // DISCONNECT
    // ============================================

    socket.on("disconnect", async () => {
      console.log(
        `User disconnected: ${socket.userId} (${socket.user.username})`,
      );

      connectedUsers.delete(socket.userId);
      userSockets.delete(socket.id);

      await updateUserOnlineStatus(socket.userId, false, null);

      socket.broadcast.emit("user_offline", {
        userId: socket.userId,
        lastSeen: new Date().toISOString(),
      });
    });
  });

  // Helper: deliver pending messages to a newly connected user's SENDERS
  async function deliverPendingMessages(userId, io) {
    try {
      // Find messages sent TO this user that are still 'sent' (not yet delivered)
      const pendingMessages = await db.query(
        `SELECT DISTINCT m.id, m.sender_id, m.conversation_id
         FROM messages m
         JOIN conversation_participants cp ON m.conversation_id = cp.conversation_id
         WHERE cp.user_id = ? AND m.sender_id != ? AND m.status = 'sent' AND m.is_deleted = FALSE`,
        [userId, userId],
      );

      if (pendingMessages.length === 0) return;

      // Group by sender
      const bySender = {};
      for (const msg of pendingMessages) {
        if (!bySender[msg.sender_id]) bySender[msg.sender_id] = [];
        bySender[msg.sender_id].push(msg);
      }

      // Update all to delivered
      const msgIds = pendingMessages.map((m) => m.id);
      if (msgIds.length > 0) {
        const placeholders = msgIds.map(() => "?").join(",");
        await db.query(
          `UPDATE messages SET status = 'delivered' WHERE id IN (${placeholders})`,
          msgIds,
        );
      }

      // Notify each sender
      for (const [senderId, msgs] of Object.entries(bySender)) {
        const senderSocketId = connectedUsers.get(parseInt(senderId));
        if (senderSocketId) {
          // Send one update per conversation
          const byConv = {};
          for (const m of msgs) {
            if (!byConv[m.conversation_id]) byConv[m.conversation_id] = m.id;
            else
              byConv[m.conversation_id] = Math.max(
                byConv[m.conversation_id],
                m.id,
              );
          }
          for (const [convId, lastMsgId] of Object.entries(byConv)) {
            io.to(senderSocketId).emit("message_status_update", {
              messageId: lastMsgId,
              conversationId: parseInt(convId),
              status: "delivered",
            });
          }
        }
      }
    } catch (error) {
      console.error("Deliver pending messages error:", error);
    }
  }

  // Helper function to update user online status
  async function updateUserOnlineStatus(userId, isOnline, socketId) {
    try {
      await db.query(
        "UPDATE users SET is_online = ?, socket_id = ?, last_seen = NOW() WHERE id = ?",
        [isOnline, socketId, userId],
      );
    } catch (error) {
      console.error("Update online status error:", error);
    }
  }

  // Helper function to join user's conversations
  async function joinUserConversations(socket) {
    try {
      const conversations = await db.query(
        "SELECT conversation_id FROM conversation_participants WHERE user_id = ?",
        [socket.userId],
      );

      for (const conv of conversations) {
        socket.join(`conversation_${conv.conversation_id}`);
      }

      console.log(
        `User ${socket.userId} joined ${conversations.length} conversations`,
      );
    } catch (error) {
      console.error("Join conversations error:", error);
    }
  }
};
