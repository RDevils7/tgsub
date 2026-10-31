// 临时探针：直接连到机器人归属 DC（5）后授权，验证是否能省掉迁移
import "dotenv/config";
import { Api, TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { getAppCredentials, currentProxy } from "../server/src/tg/client";

const token = process.argv[2] as string;
const dcId = Number(process.argv[3] ?? 5);
const DC_IP: Record<number, string> = {
  1: "149.154.175.53", 2: "149.154.167.51", 3: "149.154.175.100",
  4: "149.154.167.91", 5: "91.108.56.130",
};

const cred = getAppCredentials();
const session = new StringSession("");
(session as unknown as { setDC: (d: number, a: string, p: number) => void }).setDC(dcId, DC_IP[dcId], 80);

const client = new TelegramClient(session, cred.apiId, cred.apiHash, {
  connectionRetries: 2,
  autoReconnect: false,
  requestRetries: 1,
  timeout: 20000,
  proxy: currentProxy(),
});

const t0 = Date.now();
(async () => {
  try {
    await client.connect();
    console.log("connected", Date.now() - t0, "ms; dc =", (client.session as { dcId?: number }).dcId);
    const auth = (await client.invoke(new Api.auth.ImportBotAuthorization({
      apiId: cred.apiId, apiHash: cred.apiHash, botAuthToken: token,
    }))) as Api.auth.Authorization;
    console.log("授权成功", Date.now() - t0, "ms; id =", String(auth.user?.id), "dc =", (client.session as { dcId?: number }).dcId);
  } catch (err) {
    const e = err as { errorMessage?: string; message?: string };
    console.log("失败", Date.now() - t0, "ms:", e?.errorMessage || e?.message);
  } finally {
    await client.disconnect().catch(() => undefined);
    process.exit(0);
  }
})();
