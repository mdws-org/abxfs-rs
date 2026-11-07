// Serve a recovered Find3r directory locally, including its public app URLs.
// Uses only Node built-ins. No RPC credentials, publishing or transactions.
import {createServer} from 'node:http';
import {readFile,realpath,stat} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';

const root=await realpath(resolve(process.argv[2]||'.')),port=Number(process.argv[3]||8787);
if(!Number.isInteger(port)||port<1||port>65535)throw new Error('Use a valid local port.');
const types={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.md':'text/markdown','.txt':'text/plain'};
const app=/^\/app(?:-full)?\/[1-9][0-9]*\/0x[0-9a-f]{40}\/(?:0|[1-9][0-9]*)(?:\/.*)?$/i;
createServer(async(req,res)=>{
  try{
    if(!['GET','HEAD'].includes(req.method)){res.writeHead(405).end();return;}
    const url=new URL(req.url,'http://localhost'),path=decodeURIComponent(url.pathname);
    let file=resolve(root,app.test(path)?'viewer.html':'.'+path);
    if(file!==root&&!file.startsWith(root+sep))throw new Error();
    if((await stat(file)).isDirectory())file=resolve(file,'index.html');
    file=await realpath(file);if(!file.startsWith(root+sep))throw new Error();
    const bytes=await readFile(file);
    res.writeHead(200,{'Content-Type':types[extname(file)]||'application/octet-stream','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
    res.end(req.method==='HEAD'?undefined:bytes);
  }catch{res.writeHead(404,{'Content-Type':'text/plain'}).end('Not found');}
}).listen(port,'127.0.0.1',()=>console.log(`Find3r: http://127.0.0.1:${port}/`));
