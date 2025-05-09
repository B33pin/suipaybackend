import express from 'express';
import prisma from '../../prismaClient.js';
import authMiddleware from '../../middleware/authMiddleware.js';
import { sui, serverKeyPair } from '../../utils/suiClient.js';
import { Transaction } from '@mysten/sui/transactions';
import schedule from 'node-schedule';
import { IndividualActiveSubscriptionRegistry, PackageId, ProductRegistry, WalletRegistry } from '../../utils/packageUtils.js';
import { notifyWebHook } from '../merchants/webhookRoute.js';

const router = express.Router();

// Map to store scheduled jobs (paymentIntentId -> job)
const scheduledJobs = new Map();

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
      
      console.log(`Sending webhook notifications for product ${productId}:`, eventData);
      return await notifyWebHook(webhookIds, eventData);
    } else {
      console.log(`No webhooks found for product ${productId}`);
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
    console.log('Initializing scheduled subscription payments...');
    const activePaymentIntents = await prisma.paymentIntent.findMany({
      where: { status: 'ACTIVE' },
      include: { product: true }
    });
    
    for (const intent of activePaymentIntents) {
      schedulePaymentJob(intent.id, intent.nextPaymentDue);
    }
    
    console.log(`Scheduled ${activePaymentIntents.length} recurring payments`);
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
      console.log(`Payment intent ${paymentIntentId} not found or already deleted, skipping unsubscribe`);
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
        const eventsResult = await sui.queryEvents({
          query: { Transaction: result.digest },
        });
        
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
      
      console.log(`Payment intent ${paymentIntentId} cleanup completed successfully`);
      
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
      console.log(`Payment intent ${paymentIntentId} no longer exists, not scheduling job`);
      return { success: false, reason: 'Payment intent not found' };
    }
    
    // Create a Date object for scheduling
    const scheduledDate = new Date(scheduledTime);
    console.log(`Scheduling payment for ${paymentIntentId} at ${scheduledDate}`);
    
    // Schedule the job for the exact date
    const job = schedule.scheduleJob(scheduledDate, async function() {
      try {
        // Double-check payment intent still exists and is active
        const intent = await prisma.paymentIntent.findUnique({
          where: { id: paymentIntentId }
        });
        
        if (!intent || intent.status !== 'ACTIVE') {
          console.log(`Payment intent ${paymentIntentId} is no longer active or exists, skipping scheduled payment`);
          scheduledJobs.delete(paymentIntentId);
          return;
        }
        
        console.log(`Processing scheduled payment for intent ${paymentIntentId}`);
        const result = await processRenewal(paymentIntentId);
        
        if (result.success && result.nextPaymentDue) {
          // Schedule the next payment
          schedulePaymentJob(paymentIntentId, result.nextPaymentDue);
        } else {
          console.log(`Payment processing failed for intent ${paymentIntentId}, not scheduling next payment`);
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
      console.log(`Payment intent ${paymentIntentId} is no longer active`);
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
    const eventsResult = await sui.queryEvents({
      query: { Transaction: result.digest },
    });
    
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
    
    // Execute the transaction
    const transResult = await sui.executeTransactionBlock({
      transactionBlock: bytes,
      signature: signature,
      options: {
        showEvents: true,
      },
    });
    
    const digest = transResult.digest;
    
    // Query Sui events to get payment events
    const eventsResult = await sui.queryEvents({
      query: { Transaction: digest },
    });

    if (!eventsResult.data || eventsResult.data.length === 0) {
      return res.status(400).send({
        error: "Invalid transaction",
        message: "No events found in transaction"
      });
    }
console.log(eventsResult.data);
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
    const eventsResult = await sui.queryEvents({
      query: { Transaction: digest },
    });
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