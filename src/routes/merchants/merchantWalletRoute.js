import express from 'express';
import prisma from '../../prismaClient.js';
import { sui } from '../../utils/suiClient.js';
import { PackageId } from '../../utils/packageUtils.js';
import { Transaction } from '@mysten/sui/transactions';
import authMiddleware from '../../middleware/authMiddleware.js';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import expressWs from 'express-ws';

const router = express.Router();
expressWs(router);

// Store active polling intervals and websocket connections
const pollingIntervals = new Map();
const activeConnections = new Map();
const POLL_DURATION = 5 * 60 * 1000; // 5 minutes
const POLL_INTERVAL = 5 * 1000; // 5 seconds
const BUFFER_TIME = 1 * 60 * 1000; // 1 minute buffer
const MIST_TO_SUI = 1000000000; // 1 Billion MIST = 1 SUI

// Merchant deposit WebSocket endpoint
router.ws('/merchantDepositAddress', (ws, req, next) => {
  // Apply merchant auth middleware for WebSocket

  const token = req.query.token;
  if(token) {
  req.headers.authorization = `Bearer ${token}`;}


  authMiddleware(req, {
    status: (statusCode) => ({
      json: (data) => {
        // If authentication fails, close the connection
        ws.close(1008, data.error);
      }
    })
  }, () => {
    // Auth successful, handle the WebSocket connection with merchant type
    handleDepositWebSocket(ws, req, 'MERCHANT');
  });
});

// User deposit WebSocket endpoint
router.ws('/userDepositAddress', (ws, req, next) => {
  const token = req.query.token;
  if(token) {
  req.headers.authorization = `Bearer ${token}`;}
  // Apply user auth middleware for WebSocket
  authMiddleware(req, {
    status: (statusCode) => ({
      json: (data) => {
        // If authentication fails, close the connection
        ws.close(1008, data.error);
      }
    })
  }, () => {
    
    handleDepositWebSocket(ws, req, 'USER');
  });
});

async function handleDepositWebSocket(ws, req, ownerType) {
  try {
    
    const ownerId = req.id;
    
    // Send initial connection message
    ws.send(JSON.stringify({
      status: 'Connected',
      message: 'Waiting for deposit address creation'
    }));
    
    // Build query based on owner type
    const whereClause = {
      status: 'PENDING',
      expiresAt: {
        gt: new Date()
      }
    };
    
    // Set the correct ID field based on owner type
    if (ownerType === 'MERCHANT') {
      whereClause.merchantId = ownerId;
      whereClause.ownerType = 'MERCHANT';
    } else {
      whereClause.userId = ownerId;
      whereClause.ownerType = 'USER';
    }
    
    // Check if there's an active deposit address for this owner
    const existingDeposit = await prisma.ephemeralDeposit.findFirst({
      where: whereClause
    });

    let depositAddress;
    let ephKeypair;
    let expiresAt;

    if (existingDeposit) {
      // Use existing active deposit address
      depositAddress = existingDeposit.address;
      expiresAt = existingDeposit.expiresAt;
      ephKeypair = Ed25519Keypair.fromSecretKey(existingDeposit.privateKey);
      
      // Send existing address info
      ws.send(JSON.stringify({
        status: 'AddressReady',
        depositAddress: depositAddress,
        createdAt: existingDeposit.createdAt.toISOString(),
        expiresAt: expiresAt.toISOString()
      }));
    } else {
      // Create new ephemeral address
      ephKeypair = new Ed25519Keypair();
      depositAddress = ephKeypair.getPublicKey().toSuiAddress();
      const now = new Date();
      expiresAt = new Date(now.getTime() + POLL_DURATION);

      // Prepare data for database based on owner type
      const depositData = {
        address: depositAddress,
        privateKey: ephKeypair.getSecretKey().toString('base64'), // Save securely
        expiresAt,
        status: 'PENDING',
        ownerType
      };
      
      // Set the correct ID field based on owner type
      if (ownerType === 'MERCHANT') {
        depositData.merchantId = ownerId;
      } else {
        depositData.userId = ownerId;
      }
      
      // Save to database
      await prisma.ephemeralDeposit.create({
        data: depositData
      });
      
      // Send new address info
      ws.send(JSON.stringify({
        status: 'AddressReady',
        depositAddress: depositAddress,
        createdAt: now.toISOString(),
        expiresAt: expiresAt.toISOString()
      }));
    }
    
    // Store connection in the active connections map
    activeConnections.set(depositAddress, ws);
    
    // Handle client disconnect
    ws.on('close', () => {
      activeConnections.delete(depositAddress);
      // Don't stop polling here, as we want to continue processing even if client disconnects
    });
    
    // Check if we already have a polling interval for this address
    if (!pollingIntervals.has(depositAddress)) {
      // Start polling with improved logic
      let pollCount = 0;
      const maxPolls = POLL_DURATION / POLL_INTERVAL;
      let isProcessing = false; // Flag to track if processing is in progress
      
      const intervalId = setInterval(async () => {
        // Skip this poll cycle if still processing from previous check
        if (isProcessing) {
          console.log(`Skipping poll for ${depositAddress} - still processing previous deposit`);
          return;
        }

        // Check if polling should still continue
        const currentDeposit = await prisma.ephemeralDeposit.findUnique({
          where: { address: depositAddress }
        });
        
        // Stop polling if deposit is already completed or has error
        if (currentDeposit && ['COMPLETED', 'ERROR', 'EXPIRED'].includes(currentDeposit.status)) {
          console.log(`Stopping polling for ${depositAddress} - status: ${currentDeposit.status}`);
          
          // Close the WebSocket if still connected
          const connection = activeConnections.get(depositAddress);
          if (connection && connection.readyState === 1) {
            // Send final status message if not already sent
            if (currentDeposit.status === 'COMPLETED' && currentDeposit.amount) {
              const suiAmount = parseInt(currentDeposit.amount) / MIST_TO_SUI;
              connection.send(JSON.stringify({
                status: 'Successful',
                message: `Deposit of ${suiAmount.toFixed(9)} SUI has been successful`,
                amount: currentDeposit.amount,
                suiAmount: suiAmount.toFixed(9)
              }));
            } else if (currentDeposit.status === 'ERROR') {
              connection.send(JSON.stringify({
                status: 'Failed',
                message: 'We encountered an issue while processing deposit. It will be refunded in 24 hours in sender\'s account'
              }));
            } else if (currentDeposit.status === 'EXPIRED') {
              connection.send(JSON.stringify({
                status: 'Expired',
                message: 'Deposit address has expired with no deposit detected'
              }));
            }
            
            // Close the connection
            connection.close(1000, `Deposit ${currentDeposit.status.toLowerCase()}`);
          }
          
          clearInterval(intervalId);
          pollingIntervals.delete(depositAddress);
          return;
        }
        
        pollCount++;
        
        // Set processing flag before checking deposit
        isProcessing = true;
        
        try {
          const depositFound = await checkDeposit(depositAddress, ephKeypair, ownerId, ownerType);
          
          if (depositFound) {
            // Deposit successfully processed, stop polling immediately
            console.log(`Deposit successfully processed for ${depositAddress}`);
            clearInterval(intervalId);
            pollingIntervals.delete(depositAddress);
            return;
          }
          
          if (pollCount >= maxPolls) {
            // Reached max polls, initiate final check after buffer time
            clearInterval(intervalId);
            pollingIntervals.delete(depositAddress);
            
            console.log(`Max polls reached. Waiting buffer time for ${depositAddress}`);
            setTimeout(async () => {
              const finalCheck = await checkDeposit(depositAddress, ephKeypair, ownerId, ownerType);
              
              if (!finalCheck) {
                // Mark as expired and cleanup
                await prisma.ephemeralDeposit.update({
                  where: { address: depositAddress },
                  data: { status: 'EXPIRED' }
                });
                console.log(`Deposit expired for ${depositAddress}`);
                
                // Notify client of expiration if still connected
                const connection = activeConnections.get(depositAddress);
                if (connection && connection.readyState === 1) {
                  connection.send(JSON.stringify({
                    status: 'Expired',
                    message: 'Deposit address has expired with no deposit detected'
                  }));
                  // Close the WebSocket connection after expiration
                  connection.close(1000, 'Deposit address expired');
                }
              }
            }, BUFFER_TIME);
          }
        } catch (error) {
          console.error(`Error in polling cycle: ${error.message}`);
          
          // Notify client of error if still connected
          const connection = activeConnections.get(depositAddress);
          if (connection && connection.readyState === 1) {
            connection.send(JSON.stringify({
              status: 'Error',
              message: 'An error occurred while checking for deposits'
            }));
          }
        } finally {
          // Always reset processing flag
          isProcessing = false;
        }
      }, POLL_INTERVAL);

      pollingIntervals.set(depositAddress, intervalId);
    }
  } catch (err) {
    console.log(err);
    ws.send(JSON.stringify({
      status: 'Error',
      message: 'Failed to create deposit address'
    }));
    ws.close(1008, 'Failed to create deposit address');
  }
}

async function checkDeposit(address, ephKeypair, ownerId, ownerType) {
  console.log(`Checking deposit for address ${address}`);
  
  try {
    const balance = await sui.getBalance({
      owner: address,
      coinType: '0x2::sui::SUI'
    });

    if (parseInt(balance.totalBalance) > 0) {
      console.log(`Deposit detected: ${balance.totalBalance} MIST`);
      
      // Calculate SUI amount (1 Billion MIST = 1 SUI)
      const suiAmount = parseInt(balance.totalBalance) / MIST_TO_SUI;
      
      // Update database to prevent concurrent processing
      await prisma.ephemeralDeposit.update({
        where: { address },
        data: { 
          status: 'PROCESSING',
          amount: balance.totalBalance
        }
      });
      
      // Notify client that deposit is processing
      const connection = activeConnections.get(address);
      if (connection && connection.readyState === 1) {
        connection.send(JSON.stringify({
          status: 'Processing',
          message: `Processing Deposit of ${suiAmount.toFixed(9)} SUI`,
          amount: balance.totalBalance,
          suiAmount: suiAmount.toFixed(9)
        }));
      }

      // Perform your action here when deposit is detected
      const success = await handleDeposit(address, balance.totalBalance, ownerId, ownerType, ephKeypair);
      
      if (!success) {
        // Reset status to allow retry if handleDeposit failed
        await prisma.ephemeralDeposit.update({
          where: { address },
          data: { status: 'ERROR' }
        });
        
        // Notify client of failure
        if (connection && connection.readyState === 1) {
          connection.send(JSON.stringify({
            status: 'Failed',
            message: 'We encountered an issue while processing deposit. It will be refunded in 24 hours in sender\'s account',
            amount: balance.totalBalance,
            suiAmount: suiAmount.toFixed(9)
          }));
          // Close the WebSocket connection after failure
          connection.close(1000, 'Deposit failed');
        }
      }
      
      return success; // Return true only if deposit was successfully processed
    }
    
    return false; // No deposit yet
  } catch (error) {
    console.error(`Error checking deposit: ${error.message}`);
    
    // Notify client of error
    const connection = activeConnections.get(address);
    if (connection && connection.readyState === 1) {
      connection.send(JSON.stringify({
        status: 'Error',
        message: `Error checking deposit: ${error.message}`
      }));
      // Close the WebSocket connection after sending error message
      connection.close(1000, 'Deposit check error');
    }
    
    return false;
  }
}

async function handleDeposit(address, amount, ownerId, ownerType, ephKeypair) {
  console.log(`Processing deposit of ${amount} MIST for ${ownerType.toLowerCase()} ${ownerId}`);
  
  try {
    // Get the owner based on type
    let owner;
    if (ownerType === 'MERCHANT') {
      owner = await prisma.merchant.findUnique({
        where: { id: ownerId }
      });
    } else {
      owner = await prisma.user.findUnique({
        where: { id: ownerId }
      });
    }

    if (!owner) {
      throw new Error(`${ownerType} not found`);
    }

    // Check owner's current balance
    const ownerBalance = await sui.getBalance({
      owner: owner.id,
      coinType: '0x2::sui::SUI'
    });
    
    const ownerBalanceSUI = parseInt(ownerBalance.totalBalance) / MIST_TO_SUI;
    const minimumBalanceSUI = 0.25; // 0.25 SUI minimum balance threshold
    const minimumBalanceMIST = minimumBalanceSUI * MIST_TO_SUI; // Convert to MIST
    
    console.log(`${ownerType} current balance: ${ownerBalanceSUI.toFixed(9)} SUI`);
    
    // Get all coins from ephemeral address
    const coins = await sui.getCoins({
      owner: address,
      coinType: '0x2::sui::SUI'
    });

    if (coins.data.length === 0) {
      console.log('No coins found in address');
      return false;
    }

    // Create the transaction
    const tx = new Transaction();
    tx.setSender(address);
    
    // If multiple coins, merge them first
    if (coins.data.length > 1) {
      const [primaryCoin, ...otherCoins] = coins.data;
      tx.mergeCoins(
        tx.object(primaryCoin.coinObjectId), 
        otherCoins.map(coin => tx.object(coin.coinObjectId))
      );
    }

    // Estimate gas with a dry run
    const testTx = new Transaction();
    testTx.setSender(address);
    const [testSplit] = testTx.splitCoins(testTx.gas, [testTx.pure.u64(1000)]);
    
    
      testTx.moveCall({
        target: `${PackageId}::suipay::depositToSuiPayWallet`,
        arguments: [
          testSplit,
          testTx.object(owner.wallet),
          testTx.object("0x6"),
        ],
      });
    
    
    const txBytes = await testTx.build({ client: sui });
    const dryRunResult = await sui.dryRunTransactionBlock({
      transactionBlock: txBytes,
    });

    console.log('Dry run successful, gas estimate:', dryRunResult.effects.gasUsed);
    
    // Calculate gas needed with buffer
    const computationCost = parseInt(dryRunResult.effects.gasUsed.computationCost);
    const storageCost = parseInt(dryRunResult.effects.gasUsed.storageCost);
    const storageRebate = parseInt(dryRunResult.effects.gasUsed.storageRebate || '0');
    const estimatedGas = computationCost + storageCost - storageRebate;
    
    // Add safety buffer
    const gasBudget = Math.ceil(estimatedGas * 1.5);
    
    console.log(`Estimated gas: ${estimatedGas}, Gas budget with buffer: ${gasBudget}`);

    // Calculate transfer amount leaving gas
    const coinBalance = parseInt(amount);
    const depositAmount = coinBalance - gasBudget;
    
    if (depositAmount <= 0) {
      throw new Error('Not enough balance to cover gas fees');
    }
    
    // Build the final transaction
    const finalTx = new Transaction();
    finalTx.setSender(address);
    
    // If multiple coins, merge them
    if (coins.data.length > 1) {
      const [primaryCoin, ...otherCoins] = coins.data;
      finalTx.mergeCoins(
        finalTx.object(primaryCoin.coinObjectId), 
        otherCoins.map(coin => finalTx.object(coin.coinObjectId))
      );
    }
    
    // Check if owner balance is below the threshold
    if (parseInt(ownerBalance.totalBalance) < minimumBalanceMIST) {
      console.log(`${ownerType} balance (${ownerBalanceSUI.toFixed(9)} SUI) is below threshold (${minimumBalanceSUI} SUI). Splitting funds.`);
      
      // Ensure we have enough to split
      if (depositAmount < minimumBalanceMIST) {
        throw new Error(`Deposit amount too small to provide minimum balance to ${ownerType.toLowerCase()}`);
      }
      
      // Calculate how much to send to owner vs contract
      const amountToOwner = minimumBalanceMIST;
      const amountToContract = depositAmount - amountToOwner;
      
      console.log(`Splitting: ${(amountToOwner / MIST_TO_SUI).toFixed(9)} SUI to ${ownerType.toLowerCase()}, ${(amountToContract / MIST_TO_SUI).toFixed(9)} SUI to contract`);
      
      // Split into two coins
      const [coinForOwner, coinForContract] = finalTx.splitCoins(finalTx.gas, [
        finalTx.pure.u64(amountToOwner),
        finalTx.pure.u64(amountToContract)
      ]);
      
      // Send minimumBalance directly to owner.id
      finalTx.transferObjects([coinForOwner], finalTx.pure.address(owner.id));
      
     
        finalTx.moveCall({
          target: `${PackageId}::suipay::depositToSuiPayWallet`,
          arguments: [
            coinForContract,
            finalTx.object(owner.wallet),
            finalTx.object("0x6"),
          ],
        });
      
    } else {
      console.log(`${ownerType} balance (${ownerBalanceSUI.toFixed(9)} SUI) is above threshold. Proceeding with normal deposit.`);
      // Normal flow - split from gas to deposit the full amount
      const [splitCoin] = finalTx.splitCoins(finalTx.gas, [finalTx.pure.u64(depositAmount)]);
      
      // Deposit to appropriate wallet based on owner type
     
        finalTx.moveCall({
          target: `${PackageId}::suipay::depositToSuiPayWallet`,
          arguments: [
            splitCoin,
            finalTx.object(owner.wallet),
            finalTx.object("0x6"),
          ],
        });
      
    }
    
    // Set gas budget and transfer remaining gas
    finalTx.setGasBudget(gasBudget);
    finalTx.transferObjects([finalTx.gas], owner.id);

    // Sign and execute transaction
    const result = await sui.signAndExecuteTransaction({
      signer: ephKeypair,
      transaction: finalTx,
      requestType: 'WaitForLocalExecution',
      options: {
        showEffects: true,
        showInput: true,
      },
    });

    console.log(`Successfully processed deposit for ${depositAmount} MIST`);
    console.log(`Gas used: ${result.effects.gasUsed.computationCost} computation, ${result.effects.gasUsed.storageCost} storage`);
    console.log(`Transaction digest: ${result.digest}`);
    
    // Check remaining balance
    const finalBalance = await sui.getBalance({
      owner: address,
      coinType: '0x2::sui::SUI'
    });
    console.log(`Remaining balance: ${finalBalance.totalBalance} MIST`);
    
    // Calculate SUI amount for user message
    const suiAmount = depositAmount / MIST_TO_SUI;
    
    // Update deposit status to COMPLETED
    await prisma.ephemeralDeposit.update({
      where: { address },
      data: { status: 'COMPLETED' }
    });
    
    // Notify client of success
    const connection = activeConnections.get(address);
    if (connection && connection.readyState === 1) {
      connection.send(JSON.stringify({
        status: 'Successful',
        message: `Deposit of ${suiAmount.toFixed(9)} SUI has been successful`,
        amount: depositAmount,
        suiAmount: suiAmount.toFixed(9),
        txDigest: result.digest
      }));
      // Close the WebSocket connection after successful deposit
      connection.close(1000, 'Deposit successful');
    }
    
    // Return true to indicate success and exit polling
    return true;
    
  } catch (error) {
    console.error(`Error handling deposit: ${error.message}`);
    console.error(`Full error:`, error);
    
    // Update status to indicate processing error
    await prisma.ephemeralDeposit.update({
      where: { address },
      data: { status: 'ERROR' }
    });
    
    // Notify client of error
    const connection = activeConnections.get(address);
    if (connection && connection.readyState === 1) {
      connection.send(JSON.stringify({
        status: 'Failed',
        message: 'We encountered an issue while processing deposit. It will be refunded in 24 hours in sender\'s account',
        error: error.message
      }));
      // Close the WebSocket connection after failure
      connection.close(1000, 'Deposit failed');
    }
    
    // Return false on error
    return false;
  }
}

// Cleanup endpoint for when server restarts
router.get('/cleanup-expired', authMiddleware, async(req, res) => {
  try {
    // Clear all expired deposits
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

    res.json({ cleaned: result.count });
  } catch (error) {
    res.status(500).json({ error: 'Failed to cleanup expired deposits' });
  }
});

// Get deposit status (works for both users and merchants)
router.get('/deposit-status/:address', authMiddleware, async(req, res) => {
  try {
    const deposit = await prisma.ephemeralDeposit.findUnique({
      where: { address: req.params.address }
    });

    if (!deposit) {
      return res.status(404).json({ error: 'Deposit not found' });
    }

    // Check if the deposit belongs to the authenticated entity
    if ((deposit.ownerType === 'MERCHANT' && deposit.merchantId !== req.id) || 
        (deposit.ownerType === 'USER' && deposit.userId !== req.id)) {
      return res.status(403).json({ error: 'Unauthorized access to deposit information' });
    }

    res.json({
      status: deposit.status,
      amount: deposit.amount,
      createdAt: deposit.createdAt,
      expiresAt: deposit.expiresAt
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get deposit status' });
  }
});

// Balance endpoint with support for both merchant and user
router.get('/balance', async (req, res) => {
  try {
    // Determine if this is a merchant or user request based on the request's auth context
    const ownerType = req.query.userType || 'MERCHANT'; 
    const ownerId = req.query.id;
    
    console.log(`Fetching balance for ${ownerType} with ID: ${ownerId}`);
    
    if (!ownerId) {
      return res.status(400).json({ error: 'Missing ID parameter' });
    }
    
    let owner;
    if (ownerType === 'MERCHANT') {
      owner = await prisma.merchant.findUnique({
        where: { id: ownerId }
      });
    } else {
      owner = await prisma.user.findUnique({
        where: { id: ownerId }
      });
    }
    
    if (!owner) {
      return res.status(404).json({ error: `${ownerType} not found` });
    }
    
    const ownerBalance = await sui.getBalance({
      owner: ownerId,
      coinType: '0x2::sui::SUI'
    });
    
    const txn = await sui.getObject({
      id: owner.wallet,
      options: { showContent: true },
    });
    
    // For SuiPay wallet balance
    const balance = await sui.getDynamicFields({
      parentId: txn.data.content.fields.wallet.fields.id.id,
    });
    
    // Process all dynamic fields and wait for all promises to complete
    let walletBalance = 0;
    const balancePromises = balance.data.map(async (coin) => {
      const finalBalance = await sui.getObject({
        id: coin.objectId,
        options: { showContent: true },
      });
      
      if (finalBalance.data.content.fields.name === "0000000000000000000000000000000000000000000000000000000000000002::sui::SUI") {
        return parseInt(finalBalance.data.content.fields.value);
      }
      return 0;
    });
    
    // Wait for all promises to resolve
    const balanceResults = await Promise.all(balancePromises);
    
    // Sum up the results
    walletBalance = balanceResults.reduce((sum, value) => sum + value, 0);
    
    res.json({
      balance: (parseInt(ownerBalance.totalBalance) + walletBalance) / MIST_TO_SUI,
      walletBalance: walletBalance / MIST_TO_SUI,
      accountBalance: parseInt(ownerBalance.totalBalance) / MIST_TO_SUI,
    });
  } catch (error) {
    console.error('Error fetching balance:', error);
    res.status(500).json({ error: 'Failed to fetch balance' });
  }
});


router.get('/transactions', authMiddleware, async (req, res) => {
  try {
    // Determine if this is a merchant or user request based on the request's auth context
    const ownerType = req.query.userType || 'MERCHANT'; 
    const ownerId = req.query.id;
    
    // Get pagination parameters if provided
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;
    
    console.log(`Fetching transactions for ${ownerType} with ID: ${ownerId}`);
    
    if (!ownerId) {
      return res.status(400).json({ error: 'Missing ID parameter' });
    }
    
    let owner;
    if (ownerType === 'MERCHANT') {
      owner = await prisma.merchant.findUnique({
        where: { id: ownerId }
      });
    } else {
      owner = await prisma.user.findUnique({
        where: { id: ownerId }
      });
    }
    
    if (!owner) {
      return res.status(404).json({ error: `${ownerType} not found` });
    }
    
    // Get wallet object with content
    const txn = await sui.getObject({
      id: owner.wallet,
      options: { showContent: true },
    });
    
    // Check if wallet and history exist
    if (!txn.data?.content?.fields?.history) {
      return res.json({ 
        transactions: [],
        pagination: {
          page,
          limit,
          total: 0,
          pages: 0
        }
      });
    }
    
    // Extract transaction history
    const history = txn.data.content.fields.history;
    
    // Calculate total count for pagination
    const totalCount = history.length;
    const totalPages = Math.ceil(totalCount / limit);
    
    // Apply pagination
    const paginatedHistory = history.slice(skip, skip + limit);
    
    // Format transactions for response
    const formattedTransactions = paginatedHistory.map(transaction => {
      const fields = transaction.fields;
      
      // Convert MIST to SUI for amount
      const amountMist = fields.amount ? parseInt(fields.amount) : 0;
      const amountSui = amountMist / MIST_TO_SUI;
      
      return {
        amount: amountMist.toString(),
        amountSui: amountSui.toFixed(9),
        coin: fields.coin,
        memo: fields.memo || '',
        party: fields.party,
        timestamp: fields.timestamp,
        transactionType: fields.transactionType ? {
          type: fields.transactionType.type,
          variant: fields.transactionType.variant,
          fields: fields.transactionType.fields || {}
        } : null
      };
    });
    
    // Return transactions with pagination info
    return res.json({
      transactions: formattedTransactions,
      pagination: {
        page,
        limit,
        total: totalCount,
        pages: totalPages
      }
    });
      
  } catch (err) {
    console.error("Error fetching transaction history:", err);
    return res.status(500).json({
      error: "Error fetching transaction history",
      message: err.message || String(err)
    });
  }
});

export default router;