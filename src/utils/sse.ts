import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import express from 'express';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';

// Session management interface
interface SessionInfo {
  transport: SSEServerTransport;
  sessionId: string;
  lastActivity: number;
  isActive: boolean;
}

export function startSSEServer(server: Server) {
  const app = express();

  // Enhanced session management with persistence
  const sessions = new Map<string, SessionInfo>();
  const SESSION_TIMEOUT = 5 * 60 * 1000; // 5 minutes
  const CLEANUP_INTERVAL = 60 * 1000; // 1 minute

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
    const transport = new SSEServerTransport('/messages', res);
    
    // Wait for session ID to be available
    await new Promise<void>((resolve) => {
      const checkSessionId = () => {
        if (transport.sessionId) {
          resolve();
        } else {
          setTimeout(checkSessionId, 10);
        }
      };
      checkSessionId();
    });

    // Store session with activity tracking
    const sessionInfo: SessionInfo = {
      transport,
      sessionId: transport.sessionId,
      lastActivity: Date.now(),
      isActive: true
    };

    sessions.set(transport.sessionId, sessionInfo);
    console.log(`🔗 New SSE session created: ${transport.sessionId}`);

    // Handle SSE connection close
    res.on('close', () => {
      const session = sessions.get(transport.sessionId);
      if (session) {
        session.isActive = false;
        console.log(`⚠️ SSE connection closed for session: ${transport.sessionId}`);
        // Don't delete immediately, keep for potential recovery
      }
    });

    await server.connect(transport);
  });

  app.post('/messages', (req, res) => {
    const sessionId = req.query.sessionId as string;
    
    if (!sessionId) {
      return res.status(400).send('Missing sessionId parameter');
    }

    const session = sessions.get(sessionId);
    
    if (!session) {
      console.log(`❌ Session not found: ${sessionId}`);
      return res.status(404).send('Session not found. Must establish SSE connection first.');
    }

    // Update last activity
    session.lastActivity = Date.now();
    
    // If session was marked as inactive, reactivate it
    if (!session.isActive) {
      session.isActive = true;
      console.log(`🔄 Reactivating session: ${sessionId}`);
    }

    try {
      session.transport.handlePostMessage(req, res);
      console.log(`📤 RPC call processed for session: ${sessionId}`);
    } catch (error) {
      console.error(`❌ Error handling RPC for session ${sessionId}:`, error);
      res.status(500).send('Internal server error');
    }
  });

  // Add session status endpoint for debugging
  app.get('/sessions', (req, res) => {
    const sessionList = Array.from(sessions.entries()).map(([id, session]) => ({
      sessionId: id,
      isActive: session.isActive,
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
    console.log(` Session management enabled with ${SESSION_TIMEOUT/1000/60/60/24} days timeout`);
  });
}
