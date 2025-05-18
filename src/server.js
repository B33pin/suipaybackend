import express from 'express';
import cors from 'cors';
import expressWs from 'express-ws';
import merchantAuthRoutes from './routes/merchants/merchantAuthRoute.js';
import merchantWalletRoutes from './routes/merchants/merchantWalletRoute.js';
import productRoutes from './routes/merchants/productRoute.js';
import webhookRoutes from './routes/merchants/webhookRoute.js';
import prisma from './prismaClient.js';
import userAuthRoutes from './routes/enduser/enduserAuthRoute.js';
import linkGenerationRoutes from './routes/operations/linkGeneration.js';
import subsccriptionRoutes from './routes/enduser/subscriptionRoute.js';
import axios from 'axios';

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
app.use('/api/link', linkGenerationRoutes);
app.use('/api', subsccriptionRoutes);

// Basic health check endpoint
app.get('/health', (req, res) => {
  res.status(200).send({ status: 'ok' });
});

app.get('/api/price',async (req, res) => {
  try {
    // Make the request to CoinMarketCap API
    const response = await axios.get('https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest', {
      headers: {
        'X-CMC_PRO_API_KEY': process.env.CMC_API_KEY,
      },
      params: {
        'symbol': 'SUI'
      }
    });
    
    // Extract the relevant data
    const suiData = response.data.data.SUI;
    const price = suiData.quote.USD.price;
    const percentChange24h = suiData.quote.USD.percent_change_24h;
    const marketCap = suiData.quote.USD.market_cap;
    const volume24h = suiData.quote.USD.volume_24h;
    const lastUpdated = suiData.quote.USD.last_updated;
    
    // Send back a simplified response
    res.json({
      symbol: 'SUI',
      name: suiData.name,
      price: price,
      percent_change_24h: percentChange24h,
      market_cap: marketCap,
      volume_24h: volume24h,
      last_updated: lastUpdated
    });
  } catch (error) {
    console.error('Error fetching SUI price:', error.response ? error.response.data : error.message);
    res.status(500).json({ 
      error: 'Failed to fetch SUI price',
      message: error.response ? error.response.data.status.error_message : error.message
    });
  }
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