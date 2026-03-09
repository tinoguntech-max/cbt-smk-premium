const { Server } = require('socket.io');
const pool = require('../db/pool');

let io = null;

function initializeSocket(server) {
  io = new Server(server, {
    cors: {
      origin: process.env.CLIENT_URL || 'http://localhost:3000',
      methods: ['GET', 'POST'],
      credentials: true
    }
  });

  // Middleware untuk autentikasi
  io.use(async (socket, next) => {
    const session = socket.handshake.auth.session;
    if (session && session.user) {
      socket.user = session.user;
      next();
    } else {
      next(new Error('Authentication error'));
    }
  });

  io.on('connection', (socket) => {
    console.log(`User connected: ${socket.user.full_name} (${socket.user.role})`);

    // Join user's personal room
    socket.join(`user:${socket.user.id}`);

    // Join class room if student
    if (socket.user.role === 'STUDENT' && socket.user.class_id) {
      socket.join(`class:${socket.user.class_id}`);
    }

    // ===== CHAT EVENTS =====
    
    // Join chat room
    socket.on('chat:join', async (data) => {
      const { roomType, roomId } = data;
      const roomName = `${roomType}:${roomId}`;
      socket.join(roomName);
      console.log(`${socket.user.full_name} joined ${roomName}`);
      
      // Send recent messages
      try {
        const [messages] = await pool.query(
          `SELECT cm.*, u.full_name, u.role
           FROM chat_messages cm
           JOIN users u ON u.id = cm.sender_id
           WHERE cm.room_type = :roomType AND cm.room_id = :roomId
           ORDER BY cm.created_at DESC
           LIMIT 50`,
          { roomType, roomId }
        );
        socket.emit('chat:history', messages.reverse());
      } catch (error) {
        console.error('Error loading chat history:', error);
      }
    });

    // Send message
    socket.on('chat:message', async (data) => {
      const { roomType, roomId, message, receiverId } = data;
      
      try {
        const [result] = await pool.query(
          `INSERT INTO chat_messages (room_type, room_id, sender_id, receiver_id, message)
           VALUES (:roomType, :roomId, :senderId, :receiverId, :message)`,
          {
            roomType,
            roomId,
            senderId: socket.user.id,
            receiverId: receiverId || null,
            message
          }
        );

        const messageData = {
          id: result.insertId,
          room_type: roomType,
          room_id: roomId,
          sender_id: socket.user.id,
          sender_name: socket.user.full_name,
          sender_role: socket.user.role,
          receiver_id: receiverId,
          message,
          created_at: new Date()
        };

        // Broadcast to room
        const roomName = `${roomType}:${roomId}`;
        io.to(roomName).emit('chat:message', messageData);

        // If private message, also send to receiver
        if (receiverId) {
          io.to(`user:${receiverId}`).emit('chat:message', messageData);
        }
      } catch (error) {
        console.error('Error sending message:', error);
        socket.emit('chat:error', { message: 'Failed to send message' });
      }
    });

    // Typing indicator
    socket.on('chat:typing', (data) => {
      const { roomType, roomId } = data;
      const roomName = `${roomType}:${roomId}`;
      socket.to(roomName).emit('chat:typing', {
        userId: socket.user.id,
        userName: socket.user.full_name
      });
    });

    // ===== LIVE CLASS EVENTS =====
    
    // Join live class
    socket.on('live:join', async (data) => {
      const { liveClassId } = data;
      const roomName = `live:${liveClassId}`;
      socket.join(roomName);

      try {
        // Record participant
        await pool.query(
          `INSERT INTO live_class_participants (live_class_id, user_id, joined_at)
           VALUES (:liveClassId, :userId, NOW())
           ON DUPLICATE KEY UPDATE joined_at = NOW(), left_at = NULL`,
          { liveClassId, userId: socket.user.id }
        );

        // Get participant count
        const [[{ count }]] = await pool.query(
          `SELECT COUNT(*) as count FROM live_class_participants
           WHERE live_class_id = :liveClassId AND left_at IS NULL`,
          { liveClassId }
        );

        // Notify room
        io.to(roomName).emit('live:participant-joined', {
          userId: socket.user.id,
          userName: socket.user.full_name,
          userRole: socket.user.role,
          participantCount: count
        });

        console.log(`${socket.user.full_name} joined live class ${liveClassId}`);
      } catch (error) {
        console.error('Error joining live class:', error);
      }
    });

    // Leave live class
    socket.on('live:leave', async (data) => {
      const { liveClassId } = data;
      const roomName = `live:${liveClassId}`;

      try {
        // Update participant
        await pool.query(
          `UPDATE live_class_participants
           SET left_at = NOW(),
               duration_minutes = TIMESTAMPDIFF(MINUTE, joined_at, NOW())
           WHERE live_class_id = :liveClassId AND user_id = :userId`,
          { liveClassId, userId: socket.user.id }
        );

        // Get participant count
        const [[{ count }]] = await pool.query(
          `SELECT COUNT(*) as count FROM live_class_participants
           WHERE live_class_id = :liveClassId AND left_at IS NULL`,
          { liveClassId }
        );

        // Notify room
        io.to(roomName).emit('live:participant-left', {
          userId: socket.user.id,
          userName: socket.user.full_name,
          participantCount: count
        });

        socket.leave(roomName);
        console.log(`${socket.user.full_name} left live class ${liveClassId}`);
      } catch (error) {
        console.error('Error leaving live class:', error);
      }
    });

    // Raise hand
    socket.on('live:raise-hand', (data) => {
      const { liveClassId } = data;
      const roomName = `live:${liveClassId}`;
      io.to(roomName).emit('live:hand-raised', {
        userId: socket.user.id,
        userName: socket.user.full_name
      });
    });

    // Lower hand
    socket.on('live:lower-hand', (data) => {
      const { liveClassId } = data;
      const roomName = `live:${liveClassId}`;
      io.to(roomName).emit('live:hand-lowered', {
        userId: socket.user.id
      });
    });

    // ===== LIVE QUIZ EVENTS =====
    
    // Start quiz
    socket.on('quiz:start', async (data) => {
      const { quizId, liveClassId } = data;
      
      if (socket.user.role !== 'TEACHER') {
        return socket.emit('quiz:error', { message: 'Only teachers can start quiz' });
      }

      try {
        // Update quiz status
        await pool.query(
          `UPDATE live_quizzes SET status = 'ACTIVE', started_at = NOW()
           WHERE id = :quizId`,
          { quizId }
        );

        // Get quiz data
        const [[quiz]] = await pool.query(
          `SELECT * FROM live_quizzes WHERE id = :quizId`,
          { quizId }
        );

        // Broadcast to live class
        const roomName = `live:${liveClassId}`;
        io.to(roomName).emit('quiz:started', {
          quizId: quiz.id,
          question: quiz.question,
          options: JSON.parse(quiz.options),
          durationSeconds: quiz.duration_seconds,
          points: quiz.points
        });

        // Auto-end quiz after duration
        setTimeout(async () => {
          await pool.query(
            `UPDATE live_quizzes SET status = 'ENDED', ended_at = NOW()
             WHERE id = :quizId`,
            { quizId }
          );

          // Get results
          const [results] = await pool.query(
            `SELECT u.full_name, lqa.answer, lqa.is_correct, lqa.points_earned, lqa.response_time_ms
             FROM live_quiz_answers lqa
             JOIN users u ON u.id = lqa.user_id
             WHERE lqa.quiz_id = :quizId
             ORDER BY lqa.points_earned DESC, lqa.response_time_ms ASC`,
            { quizId }
          );

          io.to(roomName).emit('quiz:ended', {
            quizId,
            correctAnswer: quiz.correct_answer,
            results
          });
        }, quiz.duration_seconds * 1000);
      } catch (error) {
        console.error('Error starting quiz:', error);
        socket.emit('quiz:error', { message: 'Failed to start quiz' });
      }
    });

    // Submit quiz answer
    socket.on('quiz:answer', async (data) => {
      const { quizId, answer, responseTimeMs } = data;

      try {
        // Get quiz
        const [[quiz]] = await pool.query(
          `SELECT * FROM live_quizzes WHERE id = :quizId AND status = 'ACTIVE'`,
          { quizId }
        );

        if (!quiz) {
          return socket.emit('quiz:error', { message: 'Quiz not active' });
        }

        const isCorrect = answer === quiz.correct_answer;
        const pointsEarned = isCorrect ? quiz.points : 0;

        // Save answer
        await pool.query(
          `INSERT INTO live_quiz_answers (quiz_id, user_id, answer, is_correct, answered_at, response_time_ms, points_earned)
           VALUES (:quizId, :userId, :answer, :isCorrect, NOW(), :responseTimeMs, :pointsEarned)`,
          {
            quizId,
            userId: socket.user.id,
            answer,
            isCorrect: isCorrect ? 1 : 0,
            responseTimeMs,
            pointsEarned
          }
        );

        socket.emit('quiz:submitted', {
          isCorrect,
          pointsEarned
        });

        // Update leaderboard
        const [[liveClass]] = await pool.query(
          `SELECT live_class_id FROM live_quizzes WHERE id = :quizId`,
          { quizId }
        );

        const [leaderboard] = await pool.query(
          `SELECT u.full_name, SUM(lqa.points_earned) as total_points
           FROM live_quiz_answers lqa
           JOIN users u ON u.id = lqa.user_id
           JOIN live_quizzes lq ON lq.id = lqa.quiz_id
           WHERE lq.live_class_id = :liveClassId
           GROUP BY lqa.user_id
           ORDER BY total_points DESC
           LIMIT 10`,
          { liveClassId: liveClass.live_class_id }
        );

        const roomName = `live:${liveClass.live_class_id}`;
        io.to(roomName).emit('quiz:leaderboard', leaderboard);
      } catch (error) {
        console.error('Error submitting quiz answer:', error);
        socket.emit('quiz:error', { message: 'Failed to submit answer' });
      }
    });

    // ===== DISCONNECT =====
    
    socket.on('disconnect', () => {
      console.log(`User disconnected: ${socket.user.full_name}`);
    });
  });

  console.log('✅ Socket.io initialized');
  return io;
}

function getIO() {
  if (!io) {
    throw new Error('Socket.io not initialized');
  }
  return io;
}

module.exports = { initializeSocket, getIO };
