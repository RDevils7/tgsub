// 临时探针：验证机器人 MTProto 登录到底卡在哪一步
// 用法：npx tsx scripts/probe-bot-login.ts <token>
import "dotenv/config";
import { Api, TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { getAppCredentials, currentProxy } from "../server/src/tg/client";

const token = process.argv[2];
if (!token) {
  console.error("需要 bot token");
  process.exit(1);
}

const cred = getAppCredentials();
console.log("api_id", cred.apiId, "proxy", currentProxy());

function makeClient(): TelegramClient {
  return new TelegramClient(new StringSession(""), cred.apiId, cred.apiHash, {
    connectionRetries: 2,
    retryDelay: 1500,
    autoReconnect: false,
    requestRetries: 1,
    timeout: 20000,
    deviceModel: "tgsub",
    systemVersion: "1.0",
    appVersion: "1.0",
    langCode: "zh",
    systemLangCode: "zh",
    proxy: currentProxy(),
    baseLogger: undefined,
  });
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} 超时 ${ms}ms`)), ms)),
  ]);
}

(async () => {
  const client = makeClient();
  const t0 = Date.now();
  try {
    await withTimeout(client.connect() as unknown as Promise<void>, 30000, "connect");
    console.log("connected in", Date.now() - t0, "ms; dc =", (client.session as { dcId?: number }).dcId);

    const run = async (round: string) => {
      const ts = Date.now();
      try {
        const auth = (await withTimeout(
          client.invoke(
            new Api.auth.ImportBotAuthorization({
              apiId: cred.apiId,
              apiHash: cred.apiHash,
              botAuthToken: token,
            }),
          ),
          45000,
          round,
        )) as Api.auth.Authorization;
        console.log(round, "成功后耗时", Date.now() - ts, "ms; id =", String(auth.user?.id));
        return auth;
      } catch (err) {
        const msg = (err as { errorMessage?: string; message?: string })?.errorMessage || (err as Error)?.message;
        console.log(round, "失败", Date.now() - ts, "ms:", msg);
        throw err;
      }
    };

    await run("第一次授权");
    await client.disconnect();
    process.exit(0);
  } catch (err) {
    const msg = (err as { errorMessage?: string; message?: string })?.errorMessage || (err as Error)?.message;
    console.log("整体失败:", msg);

    // 关键实验：迁移到新 DC 之后，同一个客户端重试是否就能成功
    for (let i = 1; i <= 3; i += 1) {
      await new Promise((r) => setTimeout(r, 2000));
      const ts = Date.now();
      try {
        const auth = (await withTimeout(
          client.invoke(
            new Api.auth.ImportBotAuthorization({
              apiId: cred.apiId,
              apiHash: cred.apiHash,
              botAuthToken: token,
            }),
          ),
          40000,
          `重试${i}`,
        )) as Api.auth.Authorization;
        console.log(`重试${i} 成功`, Date.now() - ts, "ms; id =", String(auth.user?.id), "dc =", (client.session as { dcId?: number }).dcId);
        await client.disconnect().catch(() => undefined);
        process.exit(0);
      } catch (e) {
        const mm = (e as { errorMessage?: string; message?: string })?.errorMessage || (e as Error)?.message;
        console.log(`重试${i} 失败`, Date.now() - ts, "ms:", mm, "connected =", client.connected);
      }
    }
    await client.disconnect().catch(() => undefined);
    process.exit(0);
  }
})();
