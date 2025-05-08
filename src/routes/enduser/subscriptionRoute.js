import express from 'express';
import prisma from '../../prismaClient.js';
import authMiddleware from '../../middleware/authMiddleware.js';
import { sui, serverKeyPair } from '../../utils/suiClient.js';
import { Transaction } from '@mysten/sui/transactions';
import schedule from 'node-schedule';
import { IndividualActiveSubscriptionRegistry, PackageId, ProductRegistry, WalletRegistry } from '../../utils/packageUtils.js';

const router = express.Router();

// Map to store scheduled jobs (paymentIntentId -> job)
const scheduledJobs = new Map();

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

async function unsubscribeFromProduct(paymentIntentId)
{
  try {
    const paymentIntent = await prisma.paymentIntent.findUnique({
      where: { id: paymentIntentId },
      include: { product: true }
    });
    
    if (!paymentIntent) {
      console.log(`Payment intent ${paymentIntentId} not found or already deleted, skipping unsubscribe`);
      return;
    }

    const product = await prisma.product.findUnique({
      where: { id: paymentIntent.productId },
      include: { Merchant: true }
    });
    
    // Create transaction to call unsubscribeFromProduct on the blockchain
    const tx = new Transaction();
    tx.moveCall({
      target: `${PackageId}::payment::unsubscribeFromProduct`,
      arguments: [
        tx.object(paymentIntent.productId),
        tx.object(paymentIntent.id), // payment intent ID
        tx.object(product.subscribersRegistry), // user wallet
        tx.object(IndividualActiveSubscriptionRegistry),
      ],
    });
    
    // Execute transaction with server key pair
    const result = await sui.signAndExecuteTransaction({
      signer: serverKeyPair,
      transaction: tx,
    });
    
    //look out for PaymentIntentDeleteEvent 
    const eventsResult = await sui.queryEvents({
      query: { Transaction: result.digest },
    });
    const paymentIntentDeleteEvent = eventsResult.data.find(event => 
      event.type.includes('::payment::PaymentIntentDeleteEvent')
    );
    if (paymentIntentDeleteEvent && paymentIntentDeleteEvent.parsedJson) {
      console.log(`Payment intent ${paymentIntentId} unsubscribed successfully`);
      
      // First, delete all related transaction digests
      await prisma.transactionDigest.deleteMany({
        where: { paymentIntentId: paymentIntentId }
      });
      
      // Then delete the payment intent
      await prisma.paymentIntent.delete({
        where: { id: paymentIntentId }
      });
      
      // Remove the job from the scheduled jobs map
      scheduledJobs.delete(paymentIntentId);
    } else {
      console.error(`Failed to unsubscribe payment intent ${paymentIntentId}`);
    }

  } catch (error) {
    console.error(`Error unsubscribing from product ${paymentIntentId}:`, error);
  }
}


// Call initialization on server start
initializeScheduledJobs();

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
          // Check if payment intent still exists
          const paymentIntent = await prisma.paymentIntent.findUnique({
            where: { id: paymentIntentId }
          });
          
          if (paymentIntent) {
            // First, delete all related transaction digests
            await prisma.transactionDigest.deleteMany({
              where: { paymentIntentId: paymentIntentId }
            });
            
            // Then delete the payment intent directly
            await prisma.paymentIntent.delete({
              where: { id: paymentIntentId }
            });
            
            console.log(`Job error - deleted payment intent ${paymentIntentId} from database`);
          }
        } catch (handleError) {
          console.error(`Error handling payment job failure for ${paymentIntentId}:`, handleError);
        }
      } finally {
        // Always clean up the job from the map
        scheduledJobs.delete(paymentIntentId);
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
async function markPaymentIntentFailed(paymentIntentId) {
  try {
    // Check if payment intent exists before updating
    const paymentIntent = await prisma.paymentIntent.findUnique({
      where: { id: paymentIntentId }
    });
    
    if (!paymentIntent) {
      console.log(`Payment intent ${paymentIntentId} not found, skipping status update`);
      return;
    }
    
    await prisma.paymentIntent.update({
      where: { id: paymentIntentId },
      data: { status: 'FAILED' }
    });
  } catch (error) {
    console.error(`Error marking payment intent ${paymentIntentId} as failed:`, error);
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
    
    // Handle successful payment
    const lastPaidOn = new Date();
    const nextPaymentDue = new Date(lastPaidOn.getTime() + (intent.product.recurringPeriod ));
    
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
    
    return { 
      success: true, 
      transactionDigest: result.digest,
      receiptId: receipt.id,
      nextPaymentDue: nextPaymentDue
    };
  } catch (error) {
    console.error(`Error processing payment intent ${paymentIntentId}:`, error);
    
    try {
      // Check if the payment intent still exists
      const paymentIntent = await prisma.paymentIntent.findUnique({
        where: { id: paymentIntentId }
      });
      
      if (paymentIntent) {
        // First, delete all related transaction digests
        await prisma.transactionDigest.deleteMany({
          where: { paymentIntentId: paymentIntentId }
        });
        
        // Then delete the payment intent directly
        await prisma.paymentIntent.delete({
          where: { id: paymentIntentId }
        });
        
        console.log(`Payment failed - deleted payment intent ${paymentIntentId} from database`);
        
        // Remove the job from the scheduled jobs map
        if (scheduledJobs.has(paymentIntentId)) {
          scheduledJobs.get(paymentIntentId).cancel();
          scheduledJobs.delete(paymentIntentId);
        }
      } else {
        console.log(`Payment intent ${paymentIntentId} no longer exists, skipping deletion`);
      }
    } catch (handleError) {
      console.error(`Error handling payment failure for ${paymentIntentId}:`, handleError);
    }
    
    return { success: false, error: error.message };
  }
}

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
    const { owner, productId, ref_id, amount } = paymentReceiptEvent.parsedJson;
    
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
        const nextPaymentDue = new Date(parseInt(lastPaidOn) + (product.recurringPeriod ));
        
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

//add route for unsubscribing from a product
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
        // Execute the transaction
        const transResult = await sui.executeTransactionBlock({
          transactionBlock: bytes,
          signature: signature,
          options: {
            showEvents: true,
          },
        });
        
        const digest = transResult.digest;
        
        //check for PaymentIntentDeleteEvent and take actions as needed
        const eventsResult = await sui.queryEvents({
          query: { Transaction: digest },
        });
        const paymentIntentDeleteEvent = eventsResult.data.find(event => 
          event.type.includes('::payment::PaymentIntentDeleteEvent')
        );

        if (paymentIntentDeleteEvent && paymentIntentDeleteEvent.parsedJson) {
          const { intentId } = paymentIntentDeleteEvent.parsedJson;
          
          // First, delete all related transaction digests
          await prisma.transactionDigest.deleteMany({
            where: { paymentIntentId: intentId }
          });
          
          // Then delete the payment intent
          await prisma.paymentIntent.delete({
            where: { id: intentId }
          });
          
          // Remove the job from the scheduled jobs map
          scheduledJobs.delete(intentId);
          
          return res.status(200).send({
            success: true,
            message: "Unsubscribed successfully",
            paymentIntentId: intentId
          });
        }
         else {
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