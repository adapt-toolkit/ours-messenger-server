// Test-only credential-free evidence of whether a contender reaches daemon HTTP.
const original=globalThis.fetch;
globalThis.fetch=(input,init)=>{
 const url=new URL(typeof input==='string'||input instanceof URL?String(input):input.url);
 if(url.hostname==='127.0.0.1'&&url.port==='38351')console.error('V1_DAEMON_HTTP '+(init?.method??'GET')+' '+url.pathname);
 return original(input,init);
};
