import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import express from 'express';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';

// Session management interface
interface SessionInfo {
  transport: SSEServerTransport;
  sessionId: string;
  lastActivity: number;
  isActive: boolean;
  isReady: boolean; // Thêm flag để track trạng thái sẵn sàng
}

export function startSSEServer(server: Server) {
  const app = express();

  // Enhanced session management with persistence
  const sessions = new Map<string, SessionInfo>();
  const SESSION_TIMEOUT = 5 * 60 * 1000; // Giảm xuống 5 phút
  const CLEANUP_INTERVAL = 10 * 1000; // Giảm xuống 10 giây

  // Cleanup old sessions periodically
  setInterval(() => {
    const now = Date.now();
    for (const [sessionId, session] of sessions.entries()) {
      if (now - session.lastActivity > SESSION_TIMEOUT) {
        console.log(`🧹 Cleaning up expired session: ${sessionId}`);
        sessions.delete(sessionId);
      }
    }
  }, CLEANUP_INTERVAL);

  app.get('/sse', async (req, res) => {
    const requestedSessionId = req.query.sessionId as string;
    let sessionInfo: SessionInfo | undefined;
    let isResume = false;

    // Kiểm tra xem client có muốn resume session không
    if (requestedSessionId) {
      const existingSession = sessions.get(requestedSessionId);
      if (existingSession) {
        // Resume session hiện có
        console.log(`🔄 Resuming existing session: ${requestedSessionId}`);
        sessionInfo = existingSession;
        isResume = true;

        // Cập nhật transport mới cho connection mới
        const newTransport = new SSEServerTransport('/messages', res);
        sessionInfo.transport = newTransport;
        sessionInfo.isActive = true;
        sessionInfo.lastActivity = Date.now();

        // Nếu session đã sẵn sàng, không cần connect lại
        if (sessionInfo.isReady) {
          console.log(`✅ Session resumed and ready: ${requestedSessionId}`);
        }
      } else {
        console.log(`⚠️ Requested session not found, creating new: ${requestedSessionId}`);
      }
    }

    // Tạo session mới nếu không resume
    if (!isResume) {
      const transport = new SSEServerTransport('/messages', res);

      // Tạo session ID tạm thời ngay lập tức thay vì chờ
      const tempSessionId = requestedSessionId || `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

      // Store session với trạng thái chưa sẵn sàng
      sessionInfo = {
        transport,
        sessionId: tempSessionId,
        lastActivity: Date.now(),
        isActive: true,
        isReady: false
      };

      sessions.set(tempSessionId, sessionInfo);
      console.log(`🔗 New SSE session created: ${tempSessionId}`);
    }

    // Handle SSE connection close - sử dụng sessionId hiện tại
    res.on('close', () => {
      if (sessionInfo) {
        sessionInfo.isActive = false;
        console.log(`⚠️ SSE connection closed for session: ${sessionInfo.sessionId}`);
      }
    });

    // Connect to MCP server chỉ khi session mới hoặc chưa sẵn sàng
    if (sessionInfo && (!isResume || !sessionInfo.isReady)) {
      try {
        await server.connect(sessionInfo.transport);
        // Đánh dấu session đã sẵn sàng sau khi connect thành công
        sessionInfo.isReady = true;
        const realSessionId = sessionInfo.transport.sessionId || sessionInfo.sessionId;

        // Nếu SDK cung cấp sessionId mới (UUID), thêm key thật ngay lập tức
        if (realSessionId !== sessionInfo.sessionId && !isResume) {
          sessions.set(realSessionId, sessionInfo);
          console.log(`🔑 Re-key session: ${sessionInfo.sessionId} -> ${realSessionId}`);
          // Trì hoãn xóa key tạm để tránh race khi client POST ngay sau khi nhận sessionId
          setTimeout(() => {
            sessions.delete(sessionInfo!.sessionId);
          }, 3000);
          sessionInfo.sessionId = realSessionId;
        }

        console.log(`✅ Session ready: ${sessionInfo.sessionId}`);
      } catch (error) {
        console.error(`❌ Failed to connect session ${sessionInfo.sessionId}:`, error);
        sessions.delete(sessionInfo.sessionId);
        res.status(500).send('Failed to establish SSE connection');
        return;
      }
    }
  });

  app.post('/messages', (req, res) => {
    const sessionId = req.query.sessionId as string;

    if (!sessionId) {
      return res.status(400).send('Missing sessionId parameter');
    }

    // Tìm trực tiếp theo key trước
    let session = sessions.get(sessionId);
    // Fallback 1: nếu không thấy, thử tìm theo giá trị sessionInfo.sessionId (trường hợp chưa kịp re-key)
    if (!session) {
      for (const [key, value] of sessions.entries()) {
        if (value.sessionId === sessionId) {
          session = value;
          // Đảm bảo Map có key đúng = sessionId
          if (key !== sessionId) {
            sessions.delete(key);
            sessions.set(sessionId, value);
            console.log(`🔧 Normalized session key: ${key} -> ${sessionId}`);
          }
          break;
        }
      }
    }

    // Fallback 2: tìm theo transport.sessionId (đã set bởi SDK sau connect)
    if (!session) {
      for (const [key, value] of sessions.entries()) {
        if (value.transport?.sessionId === sessionId) {
          session = value;
          if (key !== sessionId) {
            sessions.delete(key);
            sessions.set(sessionId, value);
            console.log(`🔧 Normalized session key via transport: ${key} -> ${sessionId}`);
          }
          break;
        }
      }
    }

    if (!session) {
      console.log(`❌ Session not found: ${sessionId}`);
      return res.status(404).send('Session not found. Must establish SSE connection first.');
    }

    // Kiểm tra session có sẵn sàng không
    if (!session.isReady) {
      console.log(`⏳ Session not ready yet: ${sessionId}`);
      return res.status(503).send('Session not ready. Please wait a moment and try again.');
    }

    // Update last activity
    session.lastActivity = Date.now();

    // If session was marked as inactive, reactivate it
    if (!session.isActive) {
      session.isActive = true;
      console.log(`🔄 Reactivating session: ${sessionId}`);
    }

    try {
      // Kiểm tra transport có tồn tại và sẵn sàng không
      if (!session.transport || typeof session.transport.handlePostMessage !== 'function') {
        console.error(`❌ Invalid transport for session: ${sessionId}`);
        return res.status(500).send('Transport not properly initialized');
      }

      // Kiểm tra SSE connection còn active không
      if (!session.isActive) {
        console.error(`❌ SSE connection closed for session: ${sessionId}`);
        sessions.delete(sessionId); // Dọn dẹp session đã chết
        return res.status(410).send('SSE connection closed. Please reconnect.');
      }

      session.transport.handlePostMessage(req, res);
      console.log(`📤 RPC call processed for session: ${sessionId}`);
    } catch (error) {
      console.error(`❌ Error handling RPC for session ${sessionId}:`, error);

      // Nếu lỗi là "SSE connection not established", dọn dẹp session
      if (error instanceof Error && error.message.includes('SSE connection not established')) {
        console.log(`🧹 Cleaning up dead session: ${sessionId}`);
        sessions.delete(sessionId);
        return res.status(410).send('SSE connection lost. Please reconnect.');
      }

      res.status(500).send('Internal server error');
    }
  });

  // Add session status endpoint for debugging
  app.get('/sessions', (req, res) => {
    const sessionList = Array.from(sessions.entries()).map(([id, session]) => ({
      sessionId: id,
      isActive: session.isActive,
      isReady: session.isReady,
      lastActivity: new Date(session.lastActivity).toISOString(),
      age: Date.now() - session.lastActivity
    }));

    res.json({
      totalSessions: sessions.size,
      sessions: sessionList
    });
  });

  let port = 3000;
  try {
    port = parseInt(process.env.PORT || '3000', 10);
  } catch (e) {
    console.error('Invalid PORT environment variable, using default port 3000.');
  }

  const host = process.env.HOST || 'localhost';
  app.listen(port, host, () => {
    console.log(`✅mcp-kubernetes-server is listening on port ${port}`);
    console.log(`🌐Use the following url to connect to the server:`);
    console.log(` http://${host}:${port}/sse`);
    console.log(`🔄 Resume: http://${host}:${port}/sse?sessionId=<existing-session-id>`);
    console.log(`⚡ Fast session setup enabled (${SESSION_TIMEOUT / 1000}s timeout)`);
  });
}
