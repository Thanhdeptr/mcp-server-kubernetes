import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import express from 'express';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';

// Session management interface - đơn giản
interface SessionInfo {
  transport: SSEServerTransport;
  sessionId: string;
  lastActivity: number;
  isActive: boolean;
  isReady: boolean;
}

export function startSSEServer(server: Server) {
  const app = express();

  // Simple session management - không bao giờ xóa sessions
  const sessions = new Map<string, SessionInfo>();

  // Helper function để check transport có alive không
  function isTransportAlive(transport: SSEServerTransport): boolean {
    try {
      // Kiểm tra transport có còn kết nối không
      return transport &&
        typeof transport.handlePostMessage === 'function' &&
        // @ts-ignore - access internal property để check connection
        transport._response &&
        !transport._response.destroyed;
    } catch {
      return false;
    }
  }

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

        console.log(`✅ Session resumed: ${requestedSessionId}`);
      } else {
        console.log(`⚠️ Requested session not found, creating new: ${requestedSessionId}`);
      }
    }

    // Tạo session mới nếu không resume
    if (!isResume) {
      const transport = new SSEServerTransport('/messages', res);

      // Tạo session ID
      const tempSessionId = requestedSessionId || `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

      // Store session
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

    // Handle SSE connection close
    res.on('close', () => {
      if (sessionInfo) {
        sessionInfo.isActive = false;
        console.log(`⚠️ SSE connection closed for session: ${sessionInfo.sessionId} (session preserved for resume)`);
      }
    });

    // Connect to MCP server chỉ khi session mới hoặc chưa sẵn sàng
    if (sessionInfo && (!isResume || !sessionInfo.isReady)) {
      try {
        await server.connect(sessionInfo.transport);
        // Đánh dấu session đã sẵn sàng sau khi connect thành công
        sessionInfo.isReady = true;
        const realSessionId = sessionInfo.transport.sessionId || sessionInfo.sessionId;

        // Nếu SDK cung cấp sessionId mới (UUID), re-key Map
        if (realSessionId !== sessionInfo.sessionId && !isResume) {
          sessions.set(realSessionId, sessionInfo);
          console.log(`🔑 Re-key session: ${sessionInfo.sessionId} -> ${realSessionId}`);
          // Trì hoãn xóa key tạm để tránh race
          setTimeout(() => {
            sessions.delete(sessionInfo!.sessionId);
          }, 3000);
          sessionInfo.sessionId = realSessionId;
        }

        console.log(`✅ Session ready: ${sessionInfo.sessionId}`);
      } catch (error) {
        console.error(`❌ Failed to connect session ${sessionInfo.sessionId}:`, error);
        // Không xóa session khi lỗi - giữ lại để resume
        res.status(500).send('Failed to establish SSE connection');
        return;
      }
    }

    // Safety check - này không nên xảy ra, nhưng TypeScript cần
    if (!sessionInfo) {
      console.error('❌ No session info available');
      res.status(500).send('Session creation failed');
      return;
    }
  });

  app.post('/messages', (req, res) => {
    const sessionId = req.query.sessionId as string;

    if (!sessionId) {
      return res.status(400).send('Missing sessionId parameter');
    }

    // Tìm trực tiếp theo key trước
    let session = sessions.get(sessionId);
    // Fallback: tìm theo sessionInfo.sessionId
    if (!session) {
      for (const [key, value] of sessions.entries()) {
        if (value.sessionId === sessionId) {
          session = value;
          // Normalize key về sessionId
          if (key !== sessionId) {
            sessions.delete(key);
            sessions.set(sessionId, value);
            console.log(`🔧 Normalized session key: ${key} -> ${sessionId}`);
          }
          break;
        }
      }
    }

    // Fallback: tìm theo transport.sessionId
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

    // Auto-resume session nếu inactive
    if (!session.isActive) {
      console.log(`🔄 Auto-resuming session on tool call: ${sessionId}`);
      session.isActive = true;
      session.lastActivity = Date.now();
      // Note: Transport sẽ được tạo mới khi cần thiết trong handlePostMessage
    }

    // Kiểm tra transport có alive và valid không
    if (!session.transport || !isTransportAlive(session.transport)) {
      console.log(`⚠️ Transport dead for session: ${sessionId}, need SSE reconnection`);
      session.isActive = false; // Mark as inactive
      return res.status(410).json({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'Session exists but SSE connection is dead. Please reconnect.',
          data: {
            sessionId: sessionId,
            resumeUrl: `/sse?sessionId=${sessionId}`
          }
        },
        id: null
      });
    }

    try {
      session.transport.handlePostMessage(req, res);
      console.log(`📤 RPC call processed for session: ${sessionId}`);
    } catch (error) {
      console.error(`❌ Error handling RPC for session ${sessionId}:`, error);

      // Nếu lỗi là "SSE connection not established", đánh dấu disconnected
      if (error instanceof Error && error.message.includes('SSE connection not established')) {
        session.isActive = false;
        return res.status(410).json({
          jsonrpc: '2.0',
          error: {
            code: -32000,
            message: 'SSE connection lost. Please reconnect to resume.',
            data: {
              sessionId: sessionId,
              resumeUrl: `/sse?sessionId=${sessionId}`
            }
          },
          id: null
        });
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
    console.log(`♾️ Sessions never expire - automatic resume when reconnecting`);
  });
}