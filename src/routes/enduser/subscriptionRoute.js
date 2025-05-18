import express from 'express';
import prisma from '../../prismaClient.js';
import authMiddleware from '../../middleware/authMiddleware.js';
import { sui, serverKeyPair } from '../../utils/suiClient.js';
import { Transaction } from '@mysten/sui/transactions';
import schedule from 'node-schedule';
import { IndividualActiveSubscriptionRegistry, PackageId, ProductRegistry, WalletRegistry } from '../../utils/packageUtils.js';
import { notifyWebHook } from '../merchants/webhookRoute.js';
import { bcs } from '@mysten/sui/bcs';
import { setTimeout } from 'timers/promises';

const router = express.Router();

// Map to store scheduled jobs (paymentIntentId -> job)
const scheduledJobs = new Map();

// Helper function to query events with retry and exponential backoff
async function queryEventsWithRetry(digest, maxRetries = 5, initialDelay = 500) {
  let retries = 0;
  let delay = initialDelay;
  
  while (retries < maxRetries) {
    try {
      // Try to query events
      const eventsResult = await sui.queryEvents({
        query: { Transaction: digest },
      });
      
      // If successful, return the result
      return eventsResult;
    } catch (error) {
      // If we hit the specific error about transaction not found
      if (error.message?.includes('Could not find the referenced transaction') || 
          error.code === -32602) {
        
        // Increment retry counter
        retries++;
        
        if (retries >= maxRetries) {
          throw error; // Max retries reached, propagate the error
        }
        
        console.log(`Transaction ${digest} not yet indexed, retrying in ${delay}ms (attempt ${retries}/${maxRetries})...`);
        
        // Wait before retrying
        await setTimeout(delay);
        
        // Exponential backoff: double the delay for next retry
        delay *= 2;
      } else {
        // If it's a different error, don't retry, just throw
        throw error;
      }
    }
  }
}

// Helper function to find and notify webhooks for a product
async function notifyProductWebhooks(productId, eventData) {
  try {
    // Find all webhooks attached to this product
    const webhooks = await prisma.aPIWebHooks.findMany({
      where: { productId }
    });
    
    if (webhooks && webhooks.length > 0) {
      const webhookIds = webhooks.map(webhook => webhook.id);
      // Always set currency to MIST
      eventData.currency = "MIST";
      
      
      return await notifyWebHook(webhookIds, eventData);
    } else {
      
      return { success: true, results: [] };
    }
  } catch (error) {
    console.error(`Error notifying webhooks for product ${productId}:`, error);
    return { success: false, error: error.message };
  }
}

// Initialize jobs for existing active payment intents when server starts
async function initializeScheduledJobs() {
  try {
    
    const activePaymentIntents = await prisma.paymentIntent.findMany({
      where: { status: 'ACTIVE' },
      include: { product: true }
    });
    
    const now = new Date();
    
    for (const intent of activePaymentIntents) {
      const nextPaymentDue = new Date(intent.nextPaymentDue);
      
      // Check if the payment is already past due
      if (nextPaymentDue < now) {
        console.log(`Payment intent ${intent.id} is past due. Processing immediately...`);
        try {
          // Process the payment immediately
          await processRenewal(intent.id);
        } catch (error) {
          console.error(`Error processing past due payment ${intent.id}:`, error);
        }
      } else {
        // Schedule future payments as normal
        schedulePaymentJob(intent.id, intent.nextPaymentDue);
      }
    }
    
    
  } catch (error) {
    console.error('Error initializing scheduled jobs:', error);
  }
}

// Integrated function to handle unsubscribing and clean up when a subscription fails or is cancelled
async function handleUnsubscribe(paymentIntentId, shouldNotifyWebhook = true, reason = "unsubscribed") {
  try {
    // Get complete payment intent details including relations
    const paymentIntent = await prisma.paymentIntent.findUnique({
      where: { id: paymentIntentId },
      include: { 
        product: true, 
        user: true 
      }
    });
    
    if (!paymentIntent) {
      
      return { success: false, reason: 'Payment intent not found' };
    }

    let transactionSuccess = false;
    let result = null;

    // Only try blockchain operation if status is still ACTIVE
    if (paymentIntent.status === 'ACTIVE') {
      try {
        const product = await prisma.product.findUnique({
          where: { id: paymentIntent.productId },
          include: { Merchant: true }
        });
        
        // Create and execute transaction to call unsubscribeFromProduct on the blockchain
        const tx = new Transaction();
        tx.moveCall({
          target: `${PackageId}::payment::unsubscribeFromProduct`,
          arguments: [
            tx.object(paymentIntent.productId),
            tx.object(paymentIntent.id),
            tx.object(product.subscribersRegistry),
            tx.object(IndividualActiveSubscriptionRegistry),
          ],
        });
        
        result = await sui.signAndExecuteTransaction({
          signer: serverKeyPair,
          transaction: tx,
        });
        
        // Verify if the blockchain operation was successful
        const eventsResult = await queryEventsWithRetry(result.digest);
        
        const paymentIntentDeleteEvent = eventsResult.data.find(event => 
          event.type.includes('::payment::PaymentIntentDeleteEvent')
        );
        
        if (paymentIntentDeleteEvent && paymentIntentDeleteEvent.parsedJson) {
          transactionSuccess = true;
        }
      } catch (blockchainError) {
        console.error(`Blockchain error during unsubscribe for ${paymentIntentId}:`, blockchainError);
        // Continue with database cleanup even if blockchain operation fails
      }
    }
    
    // Send webhook notification if requested - do this before deleting data
    if (shouldNotifyWebhook) {
      await notifyProductWebhooks(paymentIntent.productId, {
        productId: paymentIntent.productId,
        ref_id: paymentIntent.ref_id,
        event: reason, // "unsubscribed" or "payment_failed"
        amount: paymentIntent.product.price.toString(),
        paidOn: paymentIntent.lastPaidOn.toISOString(), // Use the stored lastPaidOn date
        userId: paymentIntent.userId,
        userWallet: paymentIntent.user.wallet
      });
    }
    
    // Clean up database records regardless of blockchain operation result
    try {
      // First, delete all related transaction digests
      await prisma.transactionDigest.deleteMany({
        where: { paymentIntentId: paymentIntentId }
      });
      
      // Then delete the payment intent
      await prisma.paymentIntent.delete({
        where: { id: paymentIntentId }
      });
      
      // Remove the job from the scheduled jobs map
      if (scheduledJobs.has(paymentIntentId)) {
        scheduledJobs.get(paymentIntentId).cancel();
        scheduledJobs.delete(paymentIntentId);
      }
      
      
      
      return { 
        success: true, 
        blockchainSuccess: transactionSuccess,
        transactionDigest: result ? result.digest : null
      };
    } catch (dbError) {
      console.error(`Database error during unsubscribe cleanup for ${paymentIntentId}:`, dbError);
      return { success: false, error: dbError.message };
    }
  } catch (error) {
    console.error(`Error in handleUnsubscribe for ${paymentIntentId}:`, error);
    return { success: false, error: error.message };
  }
}

// Function to schedule a payment job for the exact time
async function schedulePaymentJob(paymentIntentId, scheduledTime) {
  try {
    // Cancel any existing job for this intent
    if (scheduledJobs.has(paymentIntentId)) {
      scheduledJobs.get(paymentIntentId).cancel();
      scheduledJobs.delete(paymentIntentId);
    }
    
    // Check if the payment intent still exists
    const paymentIntent = await prisma.paymentIntent.findUnique({
      where: { id: paymentIntentId }
    });
    
    if (!paymentIntent) {
      
      return { success: false, reason: 'Payment intent not found' };
    }
    
    // Create a Date object for scheduling
    const scheduledDate = new Date(scheduledTime);
    
    
    // Schedule the job for the exact date
    const job = schedule.scheduleJob(scheduledDate, async function() {
      try {
        // Double-check payment intent still exists and is active
        const intent = await prisma.paymentIntent.findUnique({
          where: { id: paymentIntentId }
        });
        
        if (!intent || intent.status !== 'ACTIVE') {
          
          scheduledJobs.delete(paymentIntentId);
          return;
        }
        
        
        const result = await processRenewal(paymentIntentId);
        
        if (result.success && result.nextPaymentDue) {
          // Schedule the next payment
          schedulePaymentJob(paymentIntentId, result.nextPaymentDue);
        } else {
          
        }
      } catch (error) {
        console.error(`Error processing scheduled payment ${paymentIntentId}:`, error);
        
        try {
          // Get payment intent details for notification
          const paymentIntent = await prisma.paymentIntent.findUnique({
            where: { id: paymentIntentId },
            include: { product: true, user: true }
          });
          
          if (paymentIntent) {
            // First notify about payment failure
            await notifyProductWebhooks(paymentIntent.productId, {
              productId: paymentIntent.productId,
              ref_id: paymentIntent.ref_id,
              event: "payment_failed",
              amount: paymentIntent.product.price.toString(),
              paidOn: paymentIntent.lastPaidOn.toISOString(), // Use the stored lastPaidOn date
              userId: paymentIntent.userId,
              userWallet: paymentIntent.user.wallet
            });
            
            // Then handle unsubscribe (which will also notify with unsubscribed event)
            await handleUnsubscribe(paymentIntentId, true, "unsubscribed");
          }
        } catch (handleError) {
          console.error(`Error handling payment job failure for ${paymentIntentId}:`, handleError);
        } finally {
          // Always clean up the job from the map
          if (scheduledJobs.has(paymentIntentId)) {
            scheduledJobs.get(paymentIntentId).cancel();
            scheduledJobs.delete(paymentIntentId);
          }
        }
      }
    });
    
    // Store the job reference
    scheduledJobs.set(paymentIntentId, job);
    
    return { success: true };
  } catch (error) {
    console.error(`Error scheduling payment job for ${paymentIntentId}:`, error);
    return { success: false, error: error.message };
  }
}

async function doesDigestExist(digest) {
  const existingDigest = await prisma.transactionDigest.findFirst({
    where: { digest }
  });
  
  return existingDigest !== null;
}


async function extractProductIdFromTransactionBytes(bytes) {
  try {
    // Deserialize the transaction bytes
    const txBlock = Transaction.from(bytes);
    
    // Get the transactions from the block
    const transactions = txBlock.blockData.transactions;
    
    // Find the payment-related transaction (assuming it's a MoveCall)
    const paymentCall = transactions.find(tx => 
      tx.kind === 'MoveCall' && 
      tx.target.includes('::payment::')
    );
    
    if (!paymentCall) {
      throw new Error('No payment call found in transaction');
    }
    
    // Extract the product ID from the arguments
    const productIdArg = paymentCall.arguments[0]; // Assuming product ID is the first argument
    
    
    let productId;
    
    if (productIdArg.kind === 'Input') {
      const inputIndex = productIdArg.index;
      let inputValue;
      
      // Try to get the input value
      if (productIdArg.value && typeof productIdArg.value === 'object') {
        inputValue = productIdArg.value;
      } else if (txBlock.blockData.inputs && txBlock.blockData.inputs[inputIndex]) {
        inputValue = txBlock.blockData.inputs[inputIndex].value;
      } else {
        throw new Error('Could not find input value');
      }
      
      // Navigate the complex object structure to get the actual objectId
      if (inputValue.Object && inputValue.Object.Shared && inputValue.Object.Shared.objectId) {
        productId = inputValue.Object.Shared.objectId;
      } else if (inputValue.objectId) {
        productId = inputValue.objectId;
      } else {
        // Try to find objectId recursively in the object
        const findObjectId = (obj) => {
          if (!obj || typeof obj !== 'object') return null;
          if (obj.objectId) return obj.objectId;
          
          for (const key in obj) {
            if (obj[key] && typeof obj[key] === 'object') {
              const found = findObjectId(obj[key]);
              if (found) return found;
            }
          }
          return null;
        };
        
        productId = findObjectId(inputValue);
        
        if (!productId) {
          console.error('Complex input value structure:', JSON.stringify(inputValue));
          throw new Error('Could not find objectId in input value');
        }
      }
    } else if (productIdArg.kind === 'Pure') {
      productId = bcs.de(productIdArg.value);
    } else if (productIdArg.kind === 'Object') {
      productId = productIdArg.value;
    }
    
    if (!productId) {
      throw new Error('Could not extract product ID from transaction');
    }
    
    // Ensure we're returning a string, not an object
    if (typeof productId === 'object') {
      
      if (productId.objectId) {
        productId = productId.objectId;
      } else {
        throw new Error('Product ID extracted is an object without objectId property');
      }
    }
    
    
    return productId;
  } catch (error) {
    console.error('Error extracting product ID:', error);
    throw error;
  }
}

async function hasActiveSubscription(userId, productId) {
  try {
    const existingSubscription = await prisma.paymentIntent.findFirst({
      where: {
        userId,
        productId,
        status: 'ACTIVE'
      }
    });
    
    return existingSubscription !== null;
  } catch (error) {
    console.error("Error checking for active subscription:", error);
    throw error;
  }
}


// Process a payment renewal
async function processRenewal(paymentIntentId) {
  try {
    // Get payment intent details
    const intent = await prisma.paymentIntent.findUnique({
      where: { id: paymentIntentId },
      include: { 
        product: true,
        user: true
      }
    });
    
    if (!intent || intent.status !== 'ACTIVE') {
      
      return { success: false, reason: 'Payment intent not active' };
    }

    const product = await prisma.product.findUnique({
        where: { id: intent.productId },
        include: { Merchant: true }
    });
    
    // Create transaction to call makePaymentFromIntent on the blockchain
    const tx = new Transaction();
    tx.moveCall({
      target: `${PackageId}::payment::makePaymentFromIntent`,
      arguments: [
        tx.object(intent.productId),
        tx.object(intent.id), // payment intent ID
        tx.object(intent.user.wallet), // user wallet
        tx.object(product.Merchant.wallet),
        tx.object(product.subscribersRegistry), // amount to pay
        tx.object("0x6")
      ],
    });
    
    // Execute transaction with server key pair
    const result = await sui.signAndExecuteTransaction({
      signer: serverKeyPair,
      transaction: tx,
    });
    
    // Check for payment receipt event to confirm success
    const eventsResult = await queryEventsWithRetry(result.digest);
    
    const paymentReceiptEvent = eventsResult.data.find(event => 
      event.type.includes('::payment::PaymentReceiptEvent')
    );
    
    if (!paymentReceiptEvent || !paymentReceiptEvent.parsedJson) {
      throw new Error('Payment transaction successful but no receipt event found');
    }
    
    // Handle successful payment
    const lastPaidOn = new Date();
    const nextPaymentDue = new Date(lastPaidOn.getTime() + (intent.product.recurringPeriod));
    
    // Update payment intent with new dates
    await prisma.paymentIntent.update({
      where: { id: intent.id },
      data: {
        lastPaidOn,
        nextPaymentDue
      }
    });
    
    // Store transaction digest
    await prisma.transactionDigest.create({
      data: {
        digest: result.digest,
        paymentIntentId: intent.id,
      }
    });
    
    // Create receipt record
    const receipt = await prisma.receipt.create({
      data: {
        productId: intent.productId,
        ref_id: intent.ref_id,
        owner: intent.user.wallet,
        amount: intent.product.price,
        userId: intent.userId,
        intentId: intent.id
      }
    });
    
    // Notify webhooks about successful payment
    await notifyProductWebhooks(intent.productId, {
      productId: intent.productId,
      ref_id: intent.ref_id,
      event: "payment_success",
      amount: intent.product.price.toString(),
      receiptId: receipt.id,
      paidOn: lastPaidOn.toISOString(),
      userId: intent.userId,
      userWallet: intent.user.wallet
    });
    
    return { 
      success: true, 
      transactionDigest: result.digest,
      receiptId: receipt.id,
      nextPaymentDue: nextPaymentDue
    };
  } catch (error) {
    console.error(`Error processing payment intent ${paymentIntentId}:`, error);
    
    try {
      // Get payment intent details for notification
      const paymentIntent = await prisma.paymentIntent.findUnique({
        where: { id: paymentIntentId },
        include: { product: true, user: true }
      });
      
      if (paymentIntent) {
        // First notify about payment failure
        await notifyProductWebhooks(paymentIntent.productId, {
          productId: paymentIntent.productId,
          ref_id: paymentIntent.ref_id,
          event: "payment_failed",
          amount: paymentIntent.product.price.toString(),
          paidOn: paymentIntent.lastPaidOn.toISOString(), // Use the stored lastPaidOn date
          userId: paymentIntent.userId,
          userWallet: paymentIntent.user.wallet
        });
        
        // Then handle unsubscribe (includes database cleanup and unsubscribe notification)
        await handleUnsubscribe(paymentIntentId, true, "unsubscribed");
      }
    } catch (handleError) {
      console.error(`Error handling payment failure for ${paymentIntentId}:`, handleError);
    }
    
    return { success: false, error: error.message };
  }
}

// Call initialization on server start
initializeScheduledJobs();

// The payment processing route
router.post('/pay', authMiddleware, async (req, res) => {
    
  try {
    const { bytes, signature } = req.body;
    if (!bytes || !signature) {
      return res.status(400).send({
        error: "Missing required field",
        message: "Transaction block and signature are required"
      });
    }
    const productIdCheck =await extractProductIdFromTransactionBytes(bytes);
   
    const productCheck = await prisma.product.findUnique({
      where: { id: productIdCheck }
    });
    
    if (!productCheck) {
      return res.status(404).send({
        error: "Product not found",
        message: "The product doesn't exist in the database"
      });
    }
    
    // If it's a subscription product, check if user already has an active subscription
    // before executing the blockchain transaction
    if (productCheck.productType === 'SUBSCRIPTION') {
      const userId = req.id; // User ID from auth middleware
      
      // Check for existing active subscription
      const subscriptionExists = await hasActiveSubscription(userId, productIdCheck);
      
      if (subscriptionExists) {
        return res.status(409).send({
          error: "Subscription already exists",
          message: "You already have an active subscription for this product",
          productIdCheck
        });
      }
    }
    
    // Execute the transaction
    const transResult = await sui.executeTransactionBlock({
      transactionBlock: bytes,
      signature: signature,
      options: {
        showEvents: true,
      },
    });
    
    const digest = transResult.digest;
    const digestExists = await doesDigestExist(digest);
    if (digestExists) {
      return res.status(409).send({
        error: "Duplicate transaction",
        message: "This transaction has already been processed",
        digest
      });
    }

    
    // Query Sui events to get payment events
    const eventsResult = await queryEventsWithRetry(digest);

    if (!eventsResult.data || eventsResult.data.length === 0) {
      return res.status(400).send({
        error: "Invalid transaction",
        message: "No events found in transaction"
      });
    }
    
    // Get the PaymentReceiptEvent which exists for both one-time and subscription payments
    const paymentReceiptEvent = eventsResult.data.find(event => 
      event.type.includes('::payment::PaymentReceiptEvent')
    );
    
    if (!paymentReceiptEvent || !paymentReceiptEvent.parsedJson) {
      return res.status(400).send({
        error: "Invalid transaction",
        message: "Payment receipt event not found in transaction"
      });
    }
    
    // Extract data from the payment receipt event
    const { owner, productId, ref_id, amount, paidon } = paymentReceiptEvent.parsedJson;
    
    // Find the product in database
    const product = await prisma.product.findUnique({
      where: { id: productId }
    });
    
    if (!product) {
      return res.status(404).send({
        error: "Product not found",
        message: "The product referenced in the transaction doesn't exist in the database"
      });
    }
    
    // Find the user by wallet address
    const user = await prisma.user.findFirst({
      where: { id: owner }
    });
    
    if (!user) {
      return res.status(404).send({
        error: "User not found",
        message: "The user referenced in the transaction doesn't exist in the database"
      });
    }
    
    // Create a receipt record
    const receipt = await prisma.receipt.create({
      data: {
        productId,
        ref_id,
        owner,
        amount: BigInt(amount),
        userId: user.id,
      }
    });
    
    // Check if this is a subscription (recurring) payment
    if (product.productType === 'SUBSCRIPTION') {
      // Look for the PaymentIntentCreationEvent
      const paymentIntentEvent = eventsResult.data.find(event => 
        event.type.includes('::payment::PaymentIntentCreationEvent')
      );
      
      if (paymentIntentEvent && paymentIntentEvent.parsedJson) {
        const { intentId, lastPaidOn } = paymentIntentEvent.parsedJson;
        
        // Calculate when the next payment is due
        const nextPaymentDue = new Date(parseInt(lastPaidOn) + (product.recurringPeriod));
        
        // Create or update the payment intent
        const paymentIntent = await prisma.paymentIntent.upsert({
          where: { id: intentId },
          update: {
            lastPaidOn: new Date(parseInt(lastPaidOn)),
            nextPaymentDue,
            status: 'ACTIVE',
          },
          create: {
            id: intentId,
            userId: user.id,
            productId,
            lastPaidOn: new Date(parseInt(lastPaidOn)),
            nextPaymentDue,
            ref_id,
            status: 'ACTIVE',
          }
        });
        
        // Store the transaction digest
        await prisma.transactionDigest.create({
          data: {
            digest,
            paymentIntentId: intentId,
          }
        });
        
        // Update the receipt with the payment intent ID
        await prisma.receipt.update({
          where: { id: receipt.id },
          data: { intentId }
        });
        
        // Notify webhooks about successful payment
        await notifyProductWebhooks(productId, {
          productId,
          ref_id,
          event: "payment_success",
          amount: amount.toString(),
          receiptId: receipt.id,
          paidOn: new Date(parseInt(paidon)).toISOString(),
          userId: user.id,
          userWallet: user.wallet
        });
        
        // Schedule the next payment
        await schedulePaymentJob(intentId, nextPaymentDue);
        
        return res.status(200).send({
          success: true,
          message: "Subscription payment processed successfully",
          receiptId: receipt.id,
          paymentIntentId: paymentIntent.id,
          nextPaymentDue: nextPaymentDue.toISOString()
        });
      }
    } else {
      // For one-time payment, send webhook notification
      await notifyProductWebhooks(productId, {
        productId,
        ref_id,
        event: "payment_success",
        amount: amount.toString(),
        receiptId: receipt.id,
        paidOn: new Date(parseInt(paidon)).toISOString(),
        userId: user.id,
        userWallet: user.wallet
      });
    }
    
    // If it's a one-time payment (no subscription handling needed)
    return res.status(200).send({
      success: true,
      message: "One-time payment processed successfully",
      receiptId: receipt.id
    });
    
  } catch (err) {
    console.error("Payment processing error:", err);
    return res.status(400).send({
      error: "Payment processing error",
      message: err.message || String(err)
    });
  }
});

// Add route for unsubscribing from a product
router.post('/unsubscribe', authMiddleware, async (req, res) => {
  try {
    const { bytes, signature } = req.body;
    if (!bytes || !signature) {
      return res.status(400).send({
        error: "Missing required field",
        message: "Transaction block and signature are required"
      });
    }
    
    // Execute the transaction
    const transResult = await sui.executeTransactionBlock({
      transactionBlock: bytes,
      signature: signature,
      options: {
        showEvents: true,
      },
    });
    
    const digest = transResult.digest;
    
    // Check for PaymentIntentDeleteEvent and take actions as needed
    const eventsResult = await queryEventsWithRetry(digest);
    const paymentIntentDeleteEvent = eventsResult.data.find(event => 
      event.type.includes('::payment::PaymentIntentDeleteEvent')
    );

    if (paymentIntentDeleteEvent && paymentIntentDeleteEvent.parsedJson) {
      const { intentId, productId, ref_id, amount, owner } = paymentIntentDeleteEvent.parsedJson;
      
      // Get payment intent details for lastPaidOn date
      const paymentIntentDetails = await prisma.paymentIntent.findUnique({
        where: { id: intentId },
        include: { product: true, user: true }
      });
      
      // Get user details if not found in payment intent
      const user = paymentIntentDetails?.user || await prisma.user.findFirst({
        where: { id: owner }
      });
      
      // Notify webhooks about unsubscription
      if (productId) {
        await notifyProductWebhooks(productId, {
          productId,
          ref_id,
          event: "unsubscribed",
          amount: amount.toString(),
          paidOn: paymentIntentDetails ? paymentIntentDetails.lastPaidOn.toISOString() : new Date().toISOString(), // Use lastPaidOn when available
          userId: user ? user.id : owner,
          userWallet: user ? user.wallet : owner
        });
      }
      
      // First, delete all related transaction digests
      await prisma.transactionDigest.deleteMany({
        where: { paymentIntentId: intentId }
      });
      
      // Then delete the payment intent
      await prisma.paymentIntent.delete({
        where: { id: intentId }
      });
      
      // Remove the job from the scheduled jobs map
      if (scheduledJobs.has(intentId)) {
        scheduledJobs.get(intentId).cancel();
        scheduledJobs.delete(intentId);
      }
      
      return res.status(200).send({
        success: true,
        message: "Unsubscribed successfully",
        paymentIntentId: intentId
      });
    } else {
      return res.status(400).send({
        error: "Invalid transaction",
        message: "No unsubscribe event found in transaction"
      });
    }
  } catch (err) {
    console.error("Unsubscribe error:", err);
    return res.status(400).send({
      error: "Unsubscribe error",
      message: err.message || String(err)
    });
  }
});

// Route for manually triggering subscription cancellation from backend
router.post('/cancel-subscription/:paymentIntentId', authMiddleware, async (req, res) => {
  try {
    const { paymentIntentId } = req.params;
    
    // Verify the payment intent exists and belongs to this user
    const paymentIntent = await prisma.paymentIntent.findFirst({
      where: {
        id: paymentIntentId,
        userId: req.id
      }
    });
    
    if (!paymentIntent) {
      return res.status(404).send({
        error: "Subscription not found",
        message: "The subscription doesn't exist or doesn't belong to this user"
      });
    }
    
    // Handle the unsubscribe process
    const result = await handleUnsubscribe(paymentIntentId);
    
    if (result.success) {
      return res.status(200).send({
        success: true,
        message: "Subscription canceled successfully"
      });
    } else {
      return res.status(400).send({
        error: "Error canceling subscription",
        message: result.error || "An unknown error occurred"
      });
    }
  } catch (err) {
    console.error("Subscription cancellation error:", err);
    return res.status(400).send({
      error: "Subscription cancellation error",
      message: err.message || String(err)
    });
  }
});

router.get('/my-subscriptions', authMiddleware, async (req, res) => {
  try {
    const userId = req.id;
    
    // Get all active payment intents for the user
    const subscriptions = await prisma.paymentIntent.findMany({
      where: { 
        userId,
        status: 'ACTIVE'
      },
      include: {
        product: true
      }
    });
    
    // Convert BigInt values to strings before sending as JSON
    const serializedSubscriptions = subscriptions.map(sub => ({
      ...sub,
      product: {
        ...sub.product,
        price: sub.product.price.toString() // Convert BigInt to string
      }
    }));
    
    return res.status(200).send({
      success: true,
      subscriptions: serializedSubscriptions
    });
  } catch (err) {
    console.error("Error fetching subscriptions:", err);
    return res.status(400).send({
      error: "Error fetching subscriptions",
      message: err.message || String(err)
    });
  }
});

export default router;