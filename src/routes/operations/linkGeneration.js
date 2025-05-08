
import express from 'express';
import crypto from 'crypto';
import prisma from '../../prismaClient.js';
import authMiddleware from '../../middleware/authMiddleware.js';

const router = express.Router();

router.post('/generate-link', authMiddleware, async (req, res) => {
  try {
    // Get the product ID and reference ID from the request body
    const { product_id, ref_id } = req.body;
    
    if (!product_id || !ref_id) {
      return res.status(400).send({
        error: "Missing required fields",
        message: "Product ID and reference ID are required"
      });
    }

    // Retrieve the product details
    const product = await prisma.product.findUnique({
      where: { id: product_id },
      include: {
        Merchant: true
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
        message: "You don't have permission to generate links for this product"
      });
    }

    // Get owner details
    const owner_id = product.merchantId;
    const owner_wallet = product.Merchant.wallet;

    // Create the payload to encrypt
    const payload = JSON.stringify({
      product_id,
      ref_id,
      owner_wallet,
      owner_id,
      created_at: new Date().toISOString(), // Add timestamp for validity checking
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() // 24 hours expiry
    });

    // Encryption setup
    const algorithm = 'aes-256-ctr';
    // Create a key from the JWT_SECRET (must be 32 bytes for aes-256)
    const key = crypto.createHash('sha256').update(process.env.JWT_SECRET).digest();
    // Create a random initialization vector
    const iv = crypto.randomBytes(16);
    
    // Encrypt the payload
    const cipher = crypto.createCipheriv(algorithm, key, iv);
    let encrypted = cipher.update(payload, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    
    // Combine the IV and encrypted data
    const result = iv.toString('hex') + ':' + encrypted;
    
    // Encode for URL safety
    const safeToken = Buffer.from(result).toString('base64url');

    // Generate the payment link
    const paymentLink = `https://suipay.com/pay?pay=${safeToken}`;

    // Return the payment link
    res.status(200).send({
      success: true,
      paymentLink: paymentLink
    });
    
  } catch (err) {
    console.log(err);
    res.status(400).send({
      error: "Error generating payment link",
      message: err.message || String(err),
    });
  }
});

export default router;


/*
// Frontend decryption function
function decryptPayload(encryptedPayload) {
  try {
    // Decode from base64url
    const encoded = Buffer.from(encryptedPayload, 'base64url').toString();
    
    // Split IV and encrypted content
    const [ivHex, encryptedHex] = encoded.split(':');
    
    // Convert hex to buffers
    const iv = Buffer.from(ivHex, 'hex');
    const encrypted = Buffer.from(encryptedHex, 'hex');
    
    // Create key from the same JWT_SECRET
    const key = crypto.createHash('sha256').update(process.env.JWT_SECRET).digest();
    
    // Create decipher
    const decipher = crypto.createDecipheriv('aes-256-ctr', key, iv);
    
    // Decrypt
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    
    // Parse and return the payload
    return JSON.parse(decrypted);
  } catch (error) {
    console.error('Decryption error:', error);
    return null;
  }
}
*/
