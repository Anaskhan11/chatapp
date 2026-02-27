/**
 * ============================================
 * CALL ROUTES
 * ============================================
 * Audio and video call management
 * ============================================
 */

const express = require('express');
const db = require('../config/database');
const { verifyToken } = require('../middleware/auth');

const router = express.Router();

// ============================================
// POST /api/calls/initiate
// Initiate a new call
// ============================================
router.post('/initiate', verifyToken, async (req, res) => {
  try {
    const { calleeId, type, conversationId } = req.body;

    if (!calleeId || !type) {
      return res.status(400).json({
        success: false,
        message: 'Callee ID and call type are required'
      });
    }

    if (!['audio', 'video'].includes(type)) {
      return res.status(400).json({
        success: false,
        message: 'Call type must be audio or video'
      });
    }

    // Check if callee exists
    const callee = await db.query(
      'SELECT id, username, full_name, avatar_url, is_online FROM users WHERE id = ?',
      [calleeId]
    );

    if (callee.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Callee not found'
      });
    }

    // Create call record
    const result = await db.query(
      'INSERT INTO calls (caller_id, callee_id, conversation_id, type, status) VALUES (?, ?, ?, ?, ?)',
      [req.userId, calleeId, conversationId || null, type, 'ongoing']
    );

    const callId = result.insertId;

    // Get caller info
    const caller = await db.query(
      'SELECT id, username, full_name, avatar_url FROM users WHERE id = ?',
      [req.userId]
    );

    res.status(201).json({
      success: true,
      message: 'Call initiated',
      data: {
        call: {
          id: callId,
          caller: caller[0],
          callee: callee[0],
          type,
          status: 'ongoing',
          startedAt: new Date().toISOString()
        }
      }
    });
  } catch (error) {
    console.error('Initiate call error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});

// ============================================
// PUT /api/calls/:callId/answer
// Answer a call
// ============================================
router.put('/:callId/answer', verifyToken, async (req, res) => {
  try {
    const callId = parseInt(req.params.callId);

    if (isNaN(callId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid call ID'
      });
    }

    // Check if call exists and user is callee
    const calls = await db.query(
      'SELECT * FROM calls WHERE id = ? AND callee_id = ? AND status = "ongoing"',
      [callId, req.userId]
    );

    if (calls.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Call not found or already ended'
      });
    }

    // Update call status
    await db.query(
      'UPDATE calls SET status = "answered" WHERE id = ?',
      [callId]
    );

    res.json({
      success: true,
      message: 'Call answered'
    });
  } catch (error) {
    console.error('Answer call error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});

// ============================================
// PUT /api/calls/:callId/reject
// Reject a call
// ============================================
router.put('/:callId/reject', verifyToken, async (req, res) => {
  try {
    const callId = parseInt(req.params.callId);

    if (isNaN(callId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid call ID'
      });
    }

    // Check if call exists and user is callee
    const calls = await db.query(
      'SELECT * FROM calls WHERE id = ? AND callee_id = ? AND status = "ongoing"',
      [callId, req.userId]
    );

    if (calls.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Call not found or already ended'
      });
    }

    // Update call status
    await db.query(
      'UPDATE calls SET status = "rejected", ended_at = NOW() WHERE id = ?',
      [callId]
    );

    res.json({
      success: true,
      message: 'Call rejected'
    });
  } catch (error) {
    console.error('Reject call error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});

// ============================================
// PUT /api/calls/:callId/end
// End a call
// ============================================
router.put('/:callId/end', verifyToken, async (req, res) => {
  try {
    const callId = parseInt(req.params.callId);

    if (isNaN(callId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid call ID'
      });
    }

    // Check if call exists and user is participant
    const calls = await db.query(
      'SELECT * FROM calls WHERE id = ? AND (caller_id = ? OR callee_id = ?) AND status IN ("ongoing", "answered")',
      [callId, req.userId, req.userId]
    );

    if (calls.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Call not found or already ended'
      });
    }

    const call = calls[0];

    // Calculate duration
    let durationSeconds = 0;
    if (call.status === 'answered') {
      const startTime = new Date(call.started_at);
      const endTime = new Date();
      durationSeconds = Math.floor((endTime - startTime) / 1000);
    }

    // Update call status
    await db.query(
      'UPDATE calls SET status = "ended", ended_at = NOW(), duration_seconds = ? WHERE id = ?',
      [durationSeconds, callId]
    );

    res.json({
      success: true,
      message: 'Call ended',
      data: {
        duration: durationSeconds
      }
    });
  } catch (error) {
    console.error('End call error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});

// ============================================
// PUT /api/calls/:callId/miss
// Mark call as missed
// ============================================
router.put('/:callId/miss', verifyToken, async (req, res) => {
  try {
    const callId = parseInt(req.params.callId);

    if (isNaN(callId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid call ID'
      });
    }

    // Check if call exists and user is callee
    const calls = await db.query(
      'SELECT * FROM calls WHERE id = ? AND callee_id = ? AND status = "ongoing"',
      [callId, req.userId]
    );

    if (calls.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Call not found or already ended'
      });
    }

    // Update call status
    await db.query(
      'UPDATE calls SET status = "missed", ended_at = NOW() WHERE id = ?',
      [callId]
    );

    res.json({
      success: true,
      message: 'Call marked as missed'
    });
  } catch (error) {
    console.error('Miss call error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});

// ============================================
// GET /api/calls/history
// Get call history for current user
// ============================================
router.get('/history', verifyToken, async (req, res) => {
  try {
    const { limit = 20, offset = 0 } = req.query;
    const limitNum = parseInt(limit);
    const offsetNum = parseInt(offset);

    // Get calls where user is caller or callee
    const calls = await db.query(
      `SELECT 
        c.id,
        c.caller_id,
        c.callee_id,
        c.type,
        c.status,
        c.started_at,
        c.ended_at,
        c.duration_seconds,
        caller.username as caller_username,
        caller.full_name as caller_fullname,
        caller.avatar_url as caller_avatar,
        callee.username as callee_username,
        callee.full_name as callee_fullname,
        callee.avatar_url as callee_avatar
      FROM calls c
      JOIN users caller ON c.caller_id = caller.id
      JOIN users callee ON c.callee_id = callee.id
      WHERE c.caller_id = ? OR c.callee_id = ?
      ORDER BY c.started_at DESC
      LIMIT ${limitNum} OFFSET ${offsetNum}`,
      [req.userId, req.userId]
    );

    // Get total count
    const countResult = await db.query(
      'SELECT COUNT(*) as total FROM calls WHERE caller_id = ? OR callee_id = ?',
      [req.userId, req.userId]
    );

    // Format calls
    const formattedCalls = calls.map(call => ({
      id: call.id,
      type: call.type,
      status: call.status,
      startedAt: call.started_at,
      endedAt: call.ended_at,
      duration: call.duration_seconds,
      isOutgoing: call.caller_id === req.userId,
      otherUser: call.caller_id === req.userId ? {
        id: call.callee_id,
        username: call.callee_username,
        fullName: call.callee_fullname,
        avatarUrl: call.callee_avatar
      } : {
        id: call.caller_id,
        username: call.caller_username,
        fullName: call.caller_fullname,
        avatarUrl: call.caller_avatar
      }
    }));

    res.json({
      success: true,
      data: {
        calls: formattedCalls,
        pagination: {
          total: countResult[0].total,
          limit: limitNum,
          offset: offsetNum,
          hasMore: offsetNum + calls.length < countResult[0].total
        }
      }
    });
  } catch (error) {
    console.error('Get call history error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});

// ============================================
// GET /api/calls/:callId
// Get call details
// ============================================
router.get('/:callId', verifyToken, async (req, res) => {
  try {
    const callId = parseInt(req.params.callId);

    if (isNaN(callId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid call ID'
      });
    }

    // Get call details
    const calls = await db.query(
      `SELECT 
        c.*,
        caller.username as caller_username,
        caller.full_name as caller_fullname,
        caller.avatar_url as caller_avatar,
        callee.username as callee_username,
        callee.full_name as callee_fullname,
        callee.avatar_url as callee_avatar
      FROM calls c
      JOIN users caller ON c.caller_id = caller.id
      JOIN users callee ON c.callee_id = callee.id
      WHERE c.id = ? AND (c.caller_id = ? OR c.callee_id = ?)`,
      [callId, req.userId, req.userId]
    );

    if (calls.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Call not found'
      });
    }

    const call = calls[0];

    res.json({
      success: true,
      data: {
        call: {
          id: call.id,
          type: call.type,
          status: call.status,
          startedAt: call.started_at,
          endedAt: call.ended_at,
          duration: call.duration_seconds,
          isOutgoing: call.caller_id === req.userId,
          caller: {
            id: call.caller_id,
            username: call.caller_username,
            fullName: call.caller_fullname,
            avatarUrl: call.caller_avatar
          },
          callee: {
            id: call.callee_id,
            username: call.callee_username,
            fullName: call.callee_fullname,
            avatarUrl: call.callee_avatar
          }
        }
      }
    });
  } catch (error) {
    console.error('Get call details error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});

module.exports = router;