import express from 'express'
import prisma from '../../prismaClient.js';
import  {sui} from '../../utils/suiClient.js';
import authMiddleware from '../../middleware/authMiddleware.js';

const router = express.Router()

router.post('/createProduct', authMiddleware, async(req, res) => {
    try {
      const user = await prisma.merchant.findUnique({
        where: { id: req.id }
      });
      if (!user) {
        return res.status(404).send({ message: 'User not found' });
      }
      const { signature,bytes } = req.body;
      if (!signature || !bytes) {
        return res.status(400).send({
          error: "Missing required field",
          message: "Transaction digest is required"
        });
      }
      console.log("bytes", bytes);
      const transResult = await sui.executeTransactionBlock({
        transactionBlock:bytes,
        signature: signature,
        options: {
          showEvents: true,
      },
   
      });
      const digest = transResult.digest;
      // Query Sui events to get product creation event
      const eventsResult = await sui.queryEvents({
        query: { Transaction: digest },
      });
      // Find the product creation event
      const walletEvent = eventsResult.data.find(event => 
        event.type.includes('::product::ProductCreationEvent')
      );
      if (!walletEvent || !walletEvent.parsedJson) {
        return res.status(400).send({
          error: "Invalid transaction",
          message: "Product creation event not found in transaction"
        });
      }
      // Extract product info from event
      const prod = walletEvent.parsedJson;
      console.log("owner", req.id);
      console.log(prod);
      // Check if the owner matches the authenticated user
      if (prod.owner !== req.id) {
        return res.status(403).send({
          error: "Owner mismatch",
          message: "The product owner does not match the authenticated user"
        });
      }
      // Check if product already exists
      const existingProduct = await prisma.product.findUnique({
        where: { id: prod.productId }
      });
      if (existingProduct) {
        return res.status(409).send({
          error: "Product already exists",
          message: "A product with this ID already exists in the database"
        });
      }
      // Determine product type based on the event data
      const productType = prod.productType === 'OneTime' ? 'ONETIME' : 'SUBSCRIPTION';
      // Create the product in the database
      const product = await prisma.product.create({
        data: {
          id: prod.productId,
          name: prod.name,
          price: BigInt(prod.price),
          productType: productType,
          recurringPeriod: parseInt(prod.recurringPeriod || '0'),
          subscribersRegistry: prod.subscribersRegistry,
          merchantId: req.id
        }
      });
      // Return the created product
      res.status(201).send({
        success: true,
        product: {
          id: product.id,
          name: product.name,
          price: product.price.toString(), // Convert BigInt to string for JSON
          productType: product.productType,
          recurringPeriod: product.recurringPeriod,
          subscribersRegistry: product.subscribersRegistry,
          merchantId: product.merchantId
        }
      });
    } catch (err) {
      console.log(err);
      res.status(400).send({
        error: "Error creating product",
        message: err.message || String(err),
      });
    }
  });

// GET all products for a merchant
router.get('/products', authMiddleware, async(req, res) => {
    try {
      // Find the authenticated merchant
      const user = await prisma.merchant.findUnique({
        where: { id: req.id }
      });
  
      if (!user) {
        return res.status(404).send({ message: 'User not found' });
      }
      // Fetch all products for this merchant
      const products = await prisma.product.findMany({
        where: { merchantId: req.id }
      });
  
      // Format the response (convert BigInt to string for JSON)
      const formattedProducts = products.map(product => ({
        id: product.id,
        name: product.name,
        price: product.price.toString(),
        productType: product.productType,
        recurringPeriod: product.recurringPeriod,
        subscribersRegistry: product.subscribersRegistry,
        merchantId: product.merchantId
      }));
  
      // Return the products
      res.status(200).send({
        success: true,
        count: products.length,
        products: formattedProducts
      });
      
    } catch (err) {
      console.log(err);
      res.status(400).send({
        error: "Error fetching products",
        message: err.message || String(err),
      });
    }
  });

  // GET product details by ID with merchant information
router.get('/:id', authMiddleware, async(req, res) => {
  try {
    // Get the product ID from the request parameters
    const { id } = req.params;
    
    if (!id) {
      return res.status(400).send({
        error: "Missing required parameter",
        message: "Product ID is required"
      });
    }

    // Find the product by ID with merchant data
    const product = await prisma.product.findUnique({
      where: { id },
      include: {
        Merchant: true // Use capital M to match the schema
      }
    });

    if (!product) {
      return res.status(404).send({
        error: "Product not found",
        message: "No product found with the provided ID"
      });
    }

    // Check if the authenticated user is the owner of this product
    if (product.merchantId !== req.id) {
      return res.status(403).send({
        error: "Access denied",
        message: "You don't have permission to access this product"
      });
    }

    // Format the response (convert BigInt to string for JSON)
    const formattedProduct = {
      id: product.id,
      name: product.name,
      price: product.price.toString(),
      productType: product.productType,
      recurringPeriod: product.recurringPeriod,
      subscribersRegistry: product.subscribersRegistry,
      merchantId: product.merchantId,
      merchant: product.Merchant ? {
        id: product.Merchant.id,
        businessName: product.Merchant.businessName,
        email: product.Merchant.email,
        wallet: product.Merchant.wallet,
        createdAt: product.Merchant.createdAt
        // Add any other merchant fields you want to include
      } : null
    };

    // Return the product with merchant details
    res.status(200).send({
      success: true,
      product: formattedProduct
    });
    
  } catch (err) {
    console.log(err);
    res.status(400).send({
      error: "Error fetching product",
      message: err.message || String(err),
    });
  }
});

export default router;