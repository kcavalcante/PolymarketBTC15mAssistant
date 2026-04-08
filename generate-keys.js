import { ClobClient } from "@polymarket/clob-client";
import { createWalletClient, http } from "viem";
import { polygon } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

async function main() {
    let privateKey = process.env.WALLET_PRIVATE_KEY;
    
    if (!privateKey || privateKey.includes("aqui")) {
        console.log("\n❌ ERRO: Defina a WALLET_PRIVATE_KEY no arquivo .env!\n");
        process.exit(1);
    }
    
    if (!privateKey.startsWith("0x")) privateKey = "0x" + privateKey;

    try {
        console.log("⛓️ Autenticando com Viem na L1 da Polygon...");
        const account = privateKeyToAccount(privateKey);
        const walletClient = createWalletClient({
            account,
            chain: polygon,
            transport: http(),
        });
        
        const client = new ClobClient("https://clob.polymarket.com", 137, walletClient);

        console.log("⏳ Encriptando assinaturas seguras (API L2) com a chave...", account.address);
        const apiCreds = await client.createOrDeriveApiKey();

        console.log("\n✅ SUCESSO ABSOLUTO! Substitua as linhas vazias do seu `.env` por:");
        const key = apiCreds.apiKey || apiCreds.key || typeof apiCreds === 'string' ? apiCreds : "undefined";
        
        console.log(`\nCLOB_API_KEY="${key}"`);
        console.log(`CLOB_SECRET="${apiCreds.secret || "undefined"}"`);
        console.log(`CLOB_PASSPHRASE="${apiCreds.passphrase || "undefined"}"\n`);
        
        console.log("------------------------");
        console.log("⚠️ RETORNO TÉCNICO BRUTO PARA DEBUG:");
        console.log(JSON.stringify(apiCreds, null, 2));
        console.log("------------------------\n");

    } catch (e) {
        console.log("\n❌ Falha estrutural:", e.message);
    }
}

main();
