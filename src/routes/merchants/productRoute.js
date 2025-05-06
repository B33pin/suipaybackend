import express from 'express'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import prisma from '../../prismaClient.js';
import  {sui, serverKeyPair } from '../../utils/suiClient.js';
import { PackageId, WalletRegistry,ProductRegistry } from '../../utils/packageUtils.js';
import { Transaction } from '@mysten/sui/transactions';
import authMiddleware from '../../middleware/authMiddleware.js';



const router = express.Router()

router.post('/createProduct', authMiddleware, async(req, res) => {
    try {
      // Find the authenticated merchant
      const user = await prisma.merchant.findUnique({
        where: { id: req.id }
      });
  
      if (!user) {
        return res.status(404).send({ message: 'User not found' });
      }
  
      // Get transaction digest from request
      const { digest, name, type, price, recurringPeriod } = req.body;
      
      if (!digest) {
        return res.status(400).send({
          error: "Missing required field",
          message: "Transaction digest is required"
        });
      }
  
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

export default router;