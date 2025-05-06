import jwt from 'jsonwebtoken';
import prisma from '../prismaClient.js';

const authMiddleware = async (req, res, next) => {
  // Check if this is a WebSocket request
  const isWebSocket = req.headers.upgrade && req.headers.upgrade.toLowerCase() === 'websocket';
  
  try {
    // Get token from header
    const authHeader = req.headers.authorization;
    
    if (!authHeader) {
      if (isWebSocket) {
        // For WebSocket, close the connection
        return req.socket.close(1008, 'Authentication failed: No token provided');
      } else {
        // For HTTP, send error response
        return res.status(401).json({ error: 'Authentication failed: No token provided' });
      }
    }
    
    // Extract token (remove "Bearer ")
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
    
    // Verify token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    // Add user ID to request
    req.id = decoded.id;
    
    // Determine if this is a merchant or user based on the token
    // Option 1: If your token contains a type field
    if (decoded.type) {
      req.ownerType = decoded.type; // 'MERCHANT' or 'USER'
    } 
    // Option 2: Check both databases if type isn't in token
    else {
      // Try to find in merchant database first
      const merchant = await prisma.merchant.findUnique({
        where: { id: decoded.id },
        select: { id: true }
      });
      
      if (merchant) {
        req.ownerType = 'MERCHANT';
      } else {
        // Try to find in user database
        const user = await prisma.user.findUnique({
          where: { id: decoded.id },
          select: { id: true }
        });
        
        if (user) {
          req.ownerType = 'USER';
        } else {
          // Neither merchant nor user found with this ID
          if (isWebSocket) {
            return req.socket.close(1008, 'Authentication failed: Invalid entity ID');
          } else {
            return res.status(401).json({ error: 'Authentication failed: Invalid entity ID' });
          }
        }
      }
    }
    
    // Continue
    next();
  } catch (error) {
    console.error('Auth error:', error.message);
    
    if (isWebSocket) {
      // For WebSocket, close the connection
      return req.socket.close(1008, 'Authentication failed: Invalid token');
    } else {
      // For HTTP, send error response
      return res.status(401).json({ error: 'Authentication failed: Invalid token' });
    }
  }
};

export default authMiddleware;