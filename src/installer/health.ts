import { request } from "node:https";
import { rootCertificates } from "node:tls";
import { InstallerError } from "./release.ts";

/** Validates HTTPS normally, including the selected origin's certificate SAN. */
export async function verifyGateway(origin:string,publicTrustCertificate:string):Promise<void>{
  for(let attempt=0;attempt<30;attempt++){
    try{
      await new Promise<void>((resolve,reject)=>{
        const req=request(new URL("/connect",origin),{method:"GET",ca:[...rootCertificates,publicTrustCertificate],timeout:1000},response=>{
          let bytes=0;response.on("data",(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>256*1024)req.destroy(new InstallerError("The HTTPS setup page exceeded its response bound."));});
          response.once("error",reject);response.once("end",()=>response.statusCode===200?resolve():reject(new InstallerError("The HTTPS setup page is not ready.")));
        });
        const timer=setTimeout(()=>req.destroy(new Error("connect timeout")),2000);
        req.once("close",()=>clearTimeout(timer));req.once("error",reject);req.once("timeout",()=>req.destroy(new Error("connect timeout")));req.end();
      });
      return;
    }catch(error){
      const code=(error as NodeJS.ErrnoException).code??"";
      if(/CERT|TLS|SSL/.test(code))throw new InstallerError("HTTPS certificate validation failed. The saved identity was retained; no certificate bypass was attempted.");
      if(attempt===29)throw new InstallerError("The HTTPS gateway did not become reachable on the saved private address and port. Rerun setup after checking that address.");
      await new Promise(resolve=>setTimeout(resolve,500));
    }
  }
}
