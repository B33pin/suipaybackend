import express from 'express'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import prisma from '../../prismaClient.js';
import  {sui, serverKeyPair } from '../../utils/suiClient.js';
import { PackageId, ProductRegistry, WalletRegistry } from '../../utils/packageUtils.js';
import { Transaction } from '@mysten/sui/transactions';
import authMiddleware from '../../middleware/authMiddleware.js';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

async function buildTxData (){
  const ed25519 = Ed25519Keypair.deriveKeypair(
    "absent faint roof fog smile protect hybrid saddle admit volume rug grit",
    "m/44'/784'/0'/0'/0'" 
  );
  
  const tx = new Transaction();
  tx.moveCall(
  { target: `${PackageId}::product::createOneTimeProduct`,
    arguments: [
      tx.pure.string("Test"),
      tx.pure.u64(20),
      tx.object(`${ProductRegistry}`),
    ],}
  );
  tx.setSender(
    ed25519.getPublicKey().toSuiAddress()
  );

  const data = await tx.build(BuildT);
 const signedData = await ed25519.signTransaction(data);

 console.log("signedData", signedData);


 
};


const router = express.Router()

router.post('/signUp', async(req, res) => {
    const { id, email, password, businessName } = req.body;
    const hashedPassword = bcrypt.hashSync(password, 8);
    
    try {
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
      const walletEvent = eventsResult.data.find(event => 
        event.type.includes('::suipay::WalletCreationEvent')
      );
      if (!walletEvent || !walletEvent.parsedJson) {
        throw new Error('Wallet creation event not found');
      }
      if (!walletEvent || !walletEvent.parsedJson) {
        throw new Error('Wallet creation event not found');
      }
      const createdWallet = walletEvent.parsedJson.wallet_address;
      const user = await prisma.merchant.create({
        data: {
          id,
          businessName,
          email,
          password: hashedPassword,
          wallet: createdWallet, 
        }
      });
      
      const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET, { expiresIn: '24h' });
 
      res.status(200).send({
        accessToken: token,
       user:{
        id: user.id,
        businessName: user.businessName,
        email: user.email,
        wallet: user.wallet
       
       }
      });
      
    } catch (err) {
      var errorMessage;
      var statusCode;
      if(err.message.includes("function: 1") && err.message.includes("createSuiPayWallet")) {
        errorMessage = "Wallet already exists";
        statusCode = 400;
      } else {
        errorMessage = err.message;
        statusCode = 503;
      }

     res.status(statusCode).send({
      "error": "Error creating wallet",
      "message": errorMessage,
     })
    }
  });


  router.post('/login', async (req, res) => {
    const { id,password } = req.body;

    try {
      const user = await prisma.merchant.findUnique({
        where: { id }
      });
  
      if (!user) {
        return res.status(404).send({ message: 'User not found' });
      }
  
      const passwordIsValid = bcrypt.compareSync(password, user.password);
  
      if (!passwordIsValid) {
        return res.status(401).send({ accessToken: null, message: 'Invalid Password!' });
      }
  
      const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET, { expiresIn: '24h' });
  
      res.status(200).send({
        accessToken: token,
       user:{
        id: user.id,
        businessName: user.businessName,
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
      const user = await prisma.merchant.findUnique({
        where: { id:req.id }
      });

      if (!user) {
        return res.status(404).send({ message: 'User not found' });
      }
  
      res.status(200).send({
        id: user.id,
        businessName: user.businessName,
        email: user.email,
        wallet: user.wallet
      });
    } catch (err) {
      res.status(500).send({ message: 'Error fetching user' });
    }
  }
  );

  
export default router;