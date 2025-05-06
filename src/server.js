import express from 'express';
import cors from 'cors';
import expressWs from 'express-ws';
import merchantAuthRoutes from './routes/merchants/merchantAuthRoute.js';
import merchantWalletRoutes from './routes/merchants/merchantWalletRoute.js';
import productRoutes from './routes/merchants/productRoute.js';
import webhookRoutes from './routes/merchants/webhookRoute.js';
import prisma from './prismaClient.js';
import userAuthRoutes from './routes/enduser/enduserAuthRoute.js';

// Create Express app with WebSocket support
const app = express();
expressWs(app);

// Configure CORS middleware
app.use(cors({
  origin: '*',  // During development you can use * to allow all origins
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));

// Parse JSON request bodies
app.use(express.json());

// Register routes
app.use('/api/merchant', merchantAuthRoutes);
app.use('/api/wallet', merchantWalletRoutes);
app.use('/api/product', productRoutes);
app.use('/api/webhook',webhookRoutes );
app.use('/api/user',userAuthRoutes);


// Basic health check endpoint
app.get('/health', (req, res) => {
  res.status(200).send({ status: 'ok' });
});

// Clean up expired deposits on server start
const cleanupExpiredDeposits = async () => {
  try {
    const result = await prisma.ephemeralDeposit.updateMany({
      where: {
        status: 'PENDING',
        expiresAt: {
          lt: new Date()
        }
      },
      data: {
        status: 'EXPIRED'
      }
    });
    
    console.log(`Cleaned up ${result.count} expired deposits`);
  } catch (error) {
    console.error('Failed to cleanup expired deposits:', error);
  }
};

// Start the server
const PORT = process.env.PORT || 3001;
app.listen(PORT, async () => {
  console.log(`Server is running on port ${PORT}`);
  
  // Run cleanup on server start
  await cleanupExpiredDeposits();
  
  // Log available routes
  console.log('Available WebSocket routes:');
  console.log('- /api/wallet/depositAddress (WebSocket)');
});

// Handle graceful shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down server...');
  
  // Close database connection
  await prisma.$disconnect();
  
  process.exit(0);
});

export default app;