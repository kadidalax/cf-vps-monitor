package main

import (
	"context"
	"fmt"
	"time"

	"github.com/gorilla/websocket"
)

const webSocketWriteTimeout = 10 * time.Second

// Configure once before starting the connection's reader and writers. After
// that, only the reader (including its Pong handler) renews the read deadline.
func (c *safeWebSocketConn) configureLiveness(heartbeatInterval time.Duration) error {
	c.readTimeout = 3 * heartbeatInterval
	c.writeTimeout = min(webSocketWriteTimeout, heartbeatInterval)
	c.conn.SetPongHandler(func(string) error { return c.renewReadDeadline() })
	return c.renewReadDeadline()
}

func (c *safeWebSocketConn) renewReadDeadline() error {
	if c.readTimeout <= 0 {
		return nil
	}
	return c.conn.SetReadDeadline(time.Now().Add(c.readTimeout))
}

func (c *safeWebSocketConn) writeDeadline() time.Time {
	timeout := c.writeTimeout
	if timeout <= 0 {
		timeout = webSocketWriteTimeout
	}
	return time.Now().Add(timeout)
}

func (c *safeWebSocketConn) WriteMessage(messageType int, data []byte) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if err := c.conn.SetWriteDeadline(c.writeDeadline()); err != nil {
		return err
	}
	return c.conn.WriteMessage(messageType, data)
}

func (c *safeWebSocketConn) WriteJSON(data interface{}) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if err := c.conn.SetWriteDeadline(c.writeDeadline()); err != nil {
		return err
	}
	return c.conn.WriteJSON(data)
}

func (c *safeWebSocketConn) ReadMessage() (int, []byte, error) {
	return c.conn.ReadMessage()
}

func (c *safeWebSocketConn) Close() {
	// Gorilla explicitly permits Close concurrently with every other method.
	// Waiting for the ordinary writer lock would prevent aborting a blocked write.
	_ = c.conn.Close()
}

func runWebSocketHeartbeat(ctx context.Context, conn *safeWebSocketConn, interval time.Duration) error {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
			// WriteControl has its own deadline and may run alongside ordinary writes.
			if err := conn.conn.WriteControl(websocket.PingMessage, nil, conn.writeDeadline()); err != nil {
				return fmt.Errorf("WebSocket heartbeat failed: %w", err)
			}
		}
	}
}
