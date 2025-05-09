import express from 'express';
import crypto from 'crypto';
import jwt from 'jsonwebtoken'
import authMiddleware from '../../middleware/authMiddleware.js';
import prisma from '../../prismaClient.js';
import https from 'https';
import http from 'http';
import { URL } from 'url';

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


// Function to encrypt payload with webhook secret
const encryptPayload = (payload, secret) => {
  try {
    // Generate a random IV (Initialization Vector)
    const iv = crypto.randomBytes(16);
    
    // Create a key from the secret
    const key = crypto.createHash('sha256').update(secret).digest();
    
    // Create a cipher
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    
    // Encrypt the payload
    const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
    let encrypted = cipher.update(data, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    
    // Return both the encrypted data and the IV (needed for decryption)
    return {
      iv: iv.toString('hex'),
      data: encrypted
    };
  } catch (err) {
    console.error('Error encrypting payload:', err);
    throw new Error(`Failed to encrypt payload: ${err.message}`);
  }
};


// True fire-and-forget webhook notification function
const notifyWebHook = async (webhookIds, body) => {
  // Start the webhook process but don't wait for it
  setImmediate(() => {
    processWebhooks(webhookIds, body)
      .catch(err => console.error('Background webhook processing error:', err));
  });
  
  // Return immediately - don't wait for webhook delivery
  return { success: true, message: 'Webhook delivery started' };
};

// Process webhooks in the background without blocking the main application
async function processWebhooks(webhookIds, body) {
  if (!Array.isArray(webhookIds) || webhookIds.length === 0) {
    console.log('No webhook IDs provided, skipping notification');
    return;
  }

  // Fire all webhooks in parallel without waiting for responses
  webhookIds.forEach(async (webhookId) => {
    try {
      // Quick query to get webhook info
      const webhook = await prisma.aPIWebHooks.findUnique({
        where: { id: webhookId },
        select: { url: true, secret: true } // Only select what we need
      }).catch(err => {
        console.error(`Error fetching webhook ${webhookId}:`, err);
        return null;
      });

      if (!webhook) return; // Skip silently

      // Decrypt and encrypt payload (wrapped in try/catch)
      let encryptedPayload;
      try {
        const secret = decryptSecret(webhook.secret);
        if (!secret) return; // Skip silently
        encryptedPayload = encryptPayload(body, secret);
      } catch (e) {
        console.error(`Encryption error for webhook ${webhookId}:`, e);
        return; // Skip silently
      }

      // Send webhook without waiting for response
      fireWebhook(webhook.url, encryptedPayload, webhookId);
    } catch (err) {
      // Just log the error and continue - never block or throw
      console.error(`Error processing webhook ${webhookId}:`, err);
    }
  });
}

// Fire a single webhook without waiting for response
function fireWebhook(url, payload, webhookId) {
  try {
    const urlObj = new URL(url);
    const protocol = urlObj.protocol === 'https:' ? https : http;
    
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
      path: `${urlObj.pathname}${urlObj.search}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      timeout: 10000 // 10 second timeout, but we don't wait for it anyway
    };
    
    const req = protocol.request(options);
    
    // Set up minimal event handlers
    req.on('error', (err) => {
      console.error(`Webhook delivery error for ${webhookId}:`, err.message);
    });
    
    // Optional: Log success in background (but don't capture full response)
    req.on('response', (res) => {
      // Just log status code and move on
      const success = res.statusCode >= 200 && res.statusCode < 300;
      if (!success) {
        console.error(`Webhook ${webhookId} failed with status ${res.statusCode}`);
      }
      
      // Consume response data so the socket can be released
      res.resume();
    });
    
    // Send the data and complete request
    req.write(JSON.stringify(payload));
    req.end();
  } catch (e) {
    console.error(`Error sending webhook ${webhookId}:`, e);
    // Silently continue - fire and forget
  }
}

export default router;
export { notifyWebHook };