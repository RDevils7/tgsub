const path=require("node:path"),fs=require("node:fs"),crypto=require("node:crypto");
const Database=require("better-sqlite3");
const ROOT="C:/Users/RDevils7/WorkBuddy/tgsub";
const DATA=path.join(ROOT,"data");
const secret=fs.readFileSync(path.join(DATA,".session-secret"),"utf8").trim();
const key=crypto.createHash("sha256").update(secret).digest();
const db=new Database(path.join(DATA,"tgsub.db"),{readonly:true});
const row=db.prepare("select value from settings where key='session'").get();
const [,iv,tag,data]=row.value.split(":");
const d=crypto.createDecipheriv("aes-256-gcm",key,Buffer.from(iv,"base64"));
d.setAuthTag(Buffer.from(tag,"base64"));
const session=Buffer.concat([d.update(Buffer.from(data,"base64")),d.final()]).toString("utf8");
const settings={};for(const r of db.prepare("select key,value from settings").all())settings[r.key]=r.value;
(async()=>{
  const {TelegramClient}=require("telegram");const {StringSession}=require("telegram/sessions");
  const u=new URL(settings.proxy_url);
  const client=new TelegramClient(new StringSession(session),2040,"b18441a1ff607e10a989891a5462e627",{
    connectionRetries:1,requestRetries:1,timeout:20000,useWSS:false,
    deviceModel:"Desktop",systemVersion:"Windows 10",appVersion:"4.2.4 x64",langCode:"zh",
    proxy:{ip:u.hostname,port:Number(u.port||1080),socksType:5,timeout:15},
  });
  await client.connect();
  try{const me=await client.getMe();console.log("getMe OK:",me.id,me.username);}
  catch(e){console.log("getMe 失败 =>",e.errorMessage||e.message,"| 类名:",e.constructor&&e.constructor.name);}
  await client.disconnect().catch(()=>{});
  process.exit(0);
})();
