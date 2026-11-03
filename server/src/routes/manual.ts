import { Router } from "express";
import { asyncHandler, assert } from "../lib/http";
import { clearManual, deleteManual, listManual, recordManual } from "../manual/history";
import type { ManualKind, ManualStatus } from "../manual/note";

/**
 * 手动下载提交记录（Web「手动下载」页最下面的历史列表）
 *
 *   GET    /api/manual/history?limit=&offset=&status=&kind=&q=
 *   POST   /api/manual/history   客户端补记（合集弹窗点「取消」这类服务端不知道的结果）
 *   DELETE /api/manual/history?scope=all|error|older   清空
 *   DELETE /api/manual/history/:id                     删单条
 *
 * 主链路的记录在 POST /api/downloads/link 与 POST /api/platform/task 里写，
 * 这样关掉页面也不会丢；POST 这条只给客户端补记用，别在提交成功后再调一遍，会记两条。
 */

const KINDS: ManualKind[] = ["telegram", "platform", "web"];
const STATUSES: ManualStatus[] = ["ok", "existing", "empty", "error", "cancel"];

export const manualRouter = Router();

manualRouter.get(
  "/history",
  asyncHandler(async (req, res) => {
    res.json(
      listManual({
        limit: Number(req.query.limit ?? 30),
        offset: Number(req.query.offset ?? 0),
        status: String(req.query.status ?? ""),
        kind: String(req.query.kind ?? ""),
        q: String(req.query.q ?? "").trim(),
      }),
    );
  }),
);

manualRouter.post(
  "/history",
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const link = String(body.link ?? "").trim();
    assert(link, 400, "缺少链接");
    const kind = KINDS.includes(body.kind as ManualKind) ? (body.kind as ManualKind) : "web";
    const status = STATUSES.includes(body.status as ManualStatus) ? (body.status as ManualStatus) : "error";
    recordManual({
      link,
      kind,
      platform: body.platform ? String(body.platform) : null,
      status,
      title: body.title ? String(body.title) : null,
      note: body.note ? String(body.note) : null,
      error: body.error ? String(body.error) : null,
    });
    res.json({ ok: true });
  }),
);

manualRouter.delete(
  "/history",
  asyncHandler(async (req, res) => {
    const raw = String(req.query.scope ?? "all");
    const scope = raw === "error" || raw === "older" ? raw : "all";
    res.json({ ok: true, count: clearManual(scope) });
  }),
);

manualRouter.delete(
  "/history/:id",
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    res.json({ ok: deleteManual(Number.isFinite(id) ? id : 0) });
  }),
);
