// Runs only when the owner launches it. No Cloudflare credentials are handled
// by Find3r. Wrangler signs in directly with Cloudflare's browser flow.
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const directory=dirname(fileURLToPath(import.meta.url));
if(Number(process.versions.node.split('.')[0])<22){console.error('Use Node 22 or newer.');process.exit(1);}
const run=(args)=>new Promise((resolve,reject)=>{const child=spawn('npx',['--yes','wrangler@4',...args],{cwd:directory,stdio:'inherit',shell:false});child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error('Cloudflare deployment did not finish.')));});
let temporary;
try{
 console.log('This deploys only the BAMFS gateway reader. Your website files remain on-chain.\nCloudflare may ask you to sign in, choose an account and confirm plan requirements.');
 const args=['deploy'];
 if(process.env.BAMFS_GATEWAY_RPC){temporary=await mkdtemp(join(tmpdir(),'bamfs-gateway-'));const path=join(temporary,'secrets.json');await writeFile(path,JSON.stringify({RPC_URL:process.env.BAMFS_GATEWAY_RPC}),{mode:0o600});args.push('--secrets-file',path);}
 // Prevent a provider URL from becoming an inherited build variable.
 delete process.env.BAMFS_GATEWAY_RPC;
 await run(args);
 console.log('Open the workers.dev URL above. Attach a custom domain in Cloudflare Settings → Domains & Routes.\nYou can set RPC_URL later under Settings → Variables and Secrets (type: Secret).');
}catch{console.error('Deployment was not completed. Check Cloudflare sign-in, permissions, billing and the generated configuration.');process.exitCode=1;}
finally{if(temporary)await rm(temporary,{recursive:true,force:true});}
