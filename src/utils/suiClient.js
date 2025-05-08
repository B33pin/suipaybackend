import { getFullnodeUrl, SuiClient } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';


export const sui = new SuiClient({ url: getFullnodeUrl('devnet') });

export const serverKeyPair =  Ed25519Keypair.fromSecretKey(
    process.env.SUI_SECRET_KEY
);

console.log('SUI_SERVER_KEY:', serverKeyPair.toSuiAddress());


