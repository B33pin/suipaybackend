import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import prisma from '../../prismaClient.js';
import { sui, serverKeyPair } from '../../utils/suiClient.js';
import { PackageId, WalletRegistry } from '../../utils/packageUtils.js';
import { Transaction } from '@mysten/sui/transactions';
import authMiddleware from '../../middleware/authMiddleware.js';

const router = express.Router();

router.post('/signUp', async(req, res) => {
    const { id, email, password } = req.body;
    const hashedPassword = bcrypt.hashSync(password, 8);
    
    try {
      // Use the same contract function as merchants since the contracts are the same
      const tx = new Transaction();
      tx.moveCall({
        target: `${PackageId}::suipay::createSuiPayWallet`,
        arguments: [tx.pure.address(id), tx.object(WalletRegistry)],
      });
      
      const result = await sui.signAndExecuteTransaction({
        signer: serverKeyPair,
        transaction: tx,
      });
      
      const eventsResult = await sui.queryEvents({
        query: { Transaction: result.digest },
      });
      
      // Use the same wallet creation event type as merchants
      const walletEvent = eventsResult.data.find(event => 
        event.type.includes('::suipay::WalletCreationEvent')
      );
      
      if (!walletEvent || !walletEvent.parsedJson) {
        throw new Error('Wallet creation event not found');
      }
      
      const createdWallet = walletEvent.parsedJson.wallet_address;
      
      // Create the user in the database
      const user = await prisma.user.create({
        data: {
          id,
          email,
          password: hashedPassword,
          wallet: createdWallet,
        }
      });
      
      // Include type in token to distinguish between users and merchants
      const token = jwt.sign({ 
        id: user.id,
        type: 'USER'
      }, process.env.JWT_SECRET, { expiresIn: '30d' });//need to implement refresh token later.
 
      res.status(200).send({
        accessToken: token,
        user: {
          id: user.id,
          email: user.email,
          wallet: user.wallet
        }
      });
      
    } catch (err) {
      let errorMessage;
      let statusCode;
      console.log(err);
      if(err.message.includes("function: 1") && err.message.includes("createSuiPayWallet")) {
        errorMessage = "Wallet already exists";
        statusCode = 400;
      } else {
        errorMessage = err.message;
        statusCode = 503;
      }

      res.status(statusCode).send({
        "error": "Error creating user wallet",
        "message": errorMessage,
      });
    }
});

router.post('/login', async (req, res) => {
    const { id, password } = req.body;

    try {
      const user = await prisma.user.findUnique({
        where: { id }
      });
  
      if (!user) {
        return res.status(404).send({ message: 'User not found' });
      }
  
      const passwordIsValid = bcrypt.compareSync(password, user.password);
  
      if (!passwordIsValid) {
        return res.status(401).send({ accessToken: null, message: 'Invalid Password!' });
      }
  
      const token = jwt.sign({ 
        id: user.id,
        type: 'USER'  // Explicitly indicate this is a user token
      }, process.env.JWT_SECRET, { expiresIn: '30d' });
  
      res.status(200).send({
        accessToken: token,
        user: {
          id: user.id,
          email: user.email,
          wallet: user.wallet
        }
      });
    } catch (err) {
      res.status(500).send({ message: 'Error logging in' });
    }
});

router.get('/me', authMiddleware, async (req, res) => {
    try {
      // Verify this is a user request, not a merchant
      if (req.ownerType !== 'USER') {
        return res.status(403).send({ message: 'Forbidden: Not a user account' });
      }
      
      const user = await prisma.user.findUnique({
        where: { id: req.id }
      });
  
      if (!user) {
        return res.status(404).send({ message: 'User not found' });
      }
  
      res.status(200).send({
        id: user.id,
        email: user.email,
        wallet: user.wallet
      });
    } catch (err) {
      res.status(500).send({ message: 'Error fetching user' });
    }
});

export default router;