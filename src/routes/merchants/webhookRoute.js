import express from 'express';
import crypto from 'crypto';
import jwt from 'jsonwebtoken'
import authMiddleware from '../../middleware/authMiddleware.js';
import prisma from '../../prismaClient.js';

const router = express.Router();

// Helper function to encrypt webhook secret
const encryptSecret = (secret) => {
  const jwtSecret = process.env.JWT_SECRET;
  return jwt.sign({ secret }, jwtSecret);
};

// Helper function to decrypt webhook secret
const decryptSecret = (encryptedSecret) => {
  const jwtSecret = process.env.JWT_SECRET;
  try {
    const decoded = jwt.verify(encryptedSecret, jwtSecret);
    return decoded.secret;
  } catch (err) {
    console.error("Error decrypting webhook secret:", err);
    return null;
  }
};

// Create a new webhook
router.post('/api-webhooks', authMiddleware, async(req, res) => {
  try {
    const { url } = req.body;
    
    if (!url) {
      return res.status(400).send({
        error: "Missing required field",
        message: "URL is required"
      });
    }
    
    // Validate URL format
    try {
      new URL(url);
    } catch (err) {
      return res.status(400).send({
        error: "Invalid URL",
        message: "The provided URL is not valid"
      });
    }
    
    // Generate random secret
    const secret = crypto.randomBytes(32).toString('hex');
    
    // Encrypt the secret
    const encryptedSecret = encryptSecret(secret);
    
    // Create webhook in database
    const webhook = await prisma.aPIWebHooks.create({
      data: {
        url,
        secret: encryptedSecret,
        merchantId: req.id
      }
    });
    
    // Return webhook with decrypted secret
    res.status(201).send({
      success: true,
      webhook: {
        id: webhook.id,
        url: webhook.url,
        secret, // Return the original secret for the user to save
        createdAt: webhook.createdAt,
        updatedAt: webhook.updatedAt
      },
      message: "Please save this secret as it will only be shown once"
    });
    
  } catch (err) {
    console.error(err);
    res.status(400).send({
      error: "Error creating webhook",
      message: err.message || String(err)
    });
  }
});

// Link webhook to product
router.post('/products/:productId/webhooks', authMiddleware, async(req, res) => {
  try {
    const { productId } = req.params;
    const { webhookId } = req.body;
    
    if (!webhookId) {
      return res.status(400).send({
        error: "Missing required field",
        message: "webhookId is required"
      });
    }
    
    // Check if product exists and belongs to the merchant
    const product = await prisma.product.findFirst({
      where: {
        id: productId,
        merchantId: req.id
      }
    });
    
    if (!product) {
      return res.status(404).send({
        error: "Product not found",
        message: "Product not found or does not belong to this merchant"
      });
    }
    
    // Check if webhook exists and belongs to the merchant
    const webhook = await prisma.aPIWebHooks.findFirst({
      where: {
        id: webhookId,
        merchantId: req.id
      }
    });
    
    if (!webhook) {
      return res.status(404).send({
        error: "Webhook not found",
        message: "Webhook not found or does not belong to this merchant"
      });
    }
    
    // Link webhook to product
    const updatedWebhook = await prisma.aPIWebHooks.update({
      where: { id: webhookId },
      data: { productId }
    });
    
    res.status(200).send({
      success: true,
      webhook: {
        id: updatedWebhook.id,
        url: updatedWebhook.url,
        createdAt: updatedWebhook.createdAt,
        updatedAt: updatedWebhook.updatedAt,
        productId: updatedWebhook.productId
      }
    });
    
  } catch (err) {
    console.error(err);
    res.status(400).send({
      error: "Error linking webhook to product",
      message: err.message || String(err)
    });
  }
});

// Get all webhooks for the merchant
router.get('/api-webhooks', authMiddleware, async(req, res) => {
  try {
    // Fetch all webhooks for the merchant
    const webhooks = await prisma.aPIWebHooks.findMany({
      where: { merchantId: req.id },
      include: {
        Product: {
          select: {
            id: true,
            name: true
          }
        }
      }
    });
    
    // Decrypt secrets and format response
    const formattedWebhooks = webhooks.map(webhook => ({
      id: webhook.id,
      url: webhook.url,
      secret: decryptSecret(webhook.secret),
      productId: webhook.productId,
      product: webhook.Product,
      createdAt: webhook.createdAt,
      updatedAt: webhook.updatedAt
    }));
    
    res.status(200).send({
      success: true,
      count: webhooks.length,
      webhooks: formattedWebhooks
    });
    
  } catch (err) {
    console.error(err);
    res.status(400).send({
      error: "Error fetching webhooks",
      message: err.message || String(err)
    });
  }
});

// Update webhook
router.put('/api-webhooks/:id', authMiddleware, async(req, res) => {
  try {
    const { id } = req.params;
    const { url } = req.body;
    
    // Check if webhook exists and belongs to the merchant
    const webhook = await prisma.aPIWebHooks.findFirst({
      where: {
        id,
        merchantId: req.id
      }
    });
    
    if (!webhook) {
      return res.status(404).send({
        error: "Webhook not found",
        message: "Webhook not found or does not belong to this merchant"
      });
    }
    
    // Prepare update data
    const updateData = {};
    
    if (url) {
      // Validate URL format
      try {
        new URL(url);
        updateData.url = url;
      } catch (err) {
        return res.status(400).send({
          error: "Invalid URL",
          message: "The provided URL is not valid"
        });
      }
    }
    
    // Update webhook
    const updatedWebhook = await prisma.aPIWebHooks.update({
      where: { id },
      data: updateData
    });
    
    // Format response
    const response = {
      success: true,
      webhook: {
        id: updatedWebhook.id,
        url: updatedWebhook.url,
        createdAt: updatedWebhook.createdAt,
        updatedAt: updatedWebhook.updatedAt,
        productId: updatedWebhook.productId
      }
    };
    
    res.status(200).send(response);
    
  } catch (err) {
    console.error(err);
    res.status(400).send({
      error: "Error updating webhook",
      message: err.message || String(err)
    });
  }
});

// Delete webhook
router.delete('/api-webhooks/:id', authMiddleware, async(req, res) => {
  try {
    const { id } = req.params;
    
    // Check if webhook exists and belongs to the merchant
    const webhook = await prisma.aPIWebHooks.findFirst({
      where: {
        id,
        merchantId: req.id
      }
    });
    
    if (!webhook) {
      return res.status(404).send({
        error: "Webhook not found",
        message: "Webhook not found or does not belong to this merchant"
      });
    }
    
    // Delete webhook - the association with product will automatically be removed
    // because we're deleting the webhook record itself
    await prisma.aPIWebHooks.delete({
      where: { id }
    });
    
    res.status(200).send({
      success: true,
      message: "Webhook deleted successfully"
    });
    
  } catch (err) {
    console.error(err);
    res.status(400).send({
      error: "Error deleting webhook",
      message: err.message || String(err)
    });
  }
});

// Regenerate webhook secret
router.post('/api-webhooks/:id/regenerate-secret', authMiddleware, async(req, res) => {
  try {
    const { id } = req.params;
    
    // Check if webhook exists and belongs to the merchant
    const webhook = await prisma.aPIWebHooks.findFirst({
      where: {
        id,
        merchantId: req.id
      }
    });
    
    if (!webhook) {
      return res.status(404).send({
        error: "Webhook not found",
        message: "Webhook not found or does not belong to this merchant"
      });
    }
    
    // Generate new secret
    const newSecret = crypto.randomBytes(32).toString('hex');
    const encryptedSecret = encryptSecret(newSecret);
    
    // Update webhook with new secret
    const updatedWebhook = await prisma.aPIWebHooks.update({
      where: { id },
      data: { 
        secret: encryptedSecret,
        updatedAt: new Date()
      }
    });
    
    // Return the new secret
    res.status(200).send({
      success: true,
      webhook: {
        id: updatedWebhook.id,
        url: updatedWebhook.url,
        secret: newSecret,
        createdAt: updatedWebhook.createdAt,
        updatedAt: updatedWebhook.updatedAt,
        productId: updatedWebhook.productId
      },
      message: "Secret regenerated successfully. Please save this new secret as it will only be shown once."
    });
    
  } catch (err) {
    console.error(err);
    res.status(400).send({
      error: "Error regenerating webhook secret",
      message: err.message || String(err)
    });
  }
});

export default router;