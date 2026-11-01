import { useCallback, useEffect, useRef, useState } from "react";
import type { CropRect } from "../types";
import { Button, Modal } from "./ui";
import { IconCrop, IconRefresh } from "./icons";

/**
 * 手动框选画面：在图片上拖出一个选框，选框比例锁定为该封面类型的比例
 * （poster 2:3、landscape 16:9、banner 1000×185…），提交的是归一化坐标，
 * 服务端再按原图尺寸换算成像素去裁。
 */

type Handle = "move" | "nw" | "ne" | "sw" | "se";

interface DragState {
  mode: Handle;
  startX: number;
  startY: number;
  box: CropRect;
}

const MIN_SIDE = 0.06; // 最小框边（归一化），防止拖成一条线

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/** 默认框：在比例允许的范围内尽可能大，并居中 */
function defaultBox(ratio: number, width: number, height: number): CropRect {
  if (!width || !height) return { x: 0.1, y: 0.1, width: 0.8, height: 0.8 };
  let w = width;
  let h = w / ratio;
  if (h > height) {
    h = height;
    w = h * ratio;
  }
  // 留一点余量，方便用户看出「这是可以拖的框」
  const wn = (w * 0.92) / width;
  const hn = (h * 0.92) / height;
  return { x: (1 - wn) / 2, y: (1 - hn) / 2, width: wn, height: hn };
}

export function CropDialog({
  open,
  src,
  ratio,
  targetLabel,
  onCancel,
  onApply,
  onUseFull,
}: {
  open: boolean;
  src: string;
  /** 目标宽高比（宽 / 高） */
  ratio: number;
  targetLabel: string;
  onCancel: () => void;
  onApply: (crop: CropRect) => void;
  onUseFull: () => void;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [box, setBox] = useState<CropRect | null>(null);

  const measure = useCallback(() => {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect || !rect.width || !rect.height) return;
    setSize({ w: rect.width, h: rect.height });
    setBox((prev) => prev ?? defaultBox(ratio, rect.width, rect.height));
  }, [ratio]);

  useEffect(() => {
    if (!open) return;
    setBox(null);
    setSize({ w: 0, h: 0 });
  }, [open, src, ratio]);

  useEffect(() => {
    if (!open) return undefined;
    const onResize = () => measure();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [open, measure]);

  // 归一化 → 像素，仅用于显示
  const px = box
    ? { x: box.x * size.w, y: box.y * size.h, w: box.width * size.w, h: box.height * size.h }
    : null;

  const span = box ? `${Math.round(box.width * 100)}% × ${Math.round(box.height * 100)}%` : "";

  const startDrag = (event: React.PointerEvent, mode: Handle) => {
    if (!box) return;
    event.preventDefault();
    event.stopPropagation();
    (event.target as Element).setPointerCapture?.(event.pointerId);
    dragRef.current = { mode, startX: event.clientX, startY: event.clientY, box };
  };

  const onPointerMove = (event: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag || !size.w || !size.h) return;
    const dxn = (event.clientX - drag.startX) / size.w;
    const dyn = (event.clientY - drag.startY) / size.h;
    const base = drag.box;

    if (drag.mode === "move") {
      setBox({
        ...base,
        x: clamp(base.x + dxn, 0, 1 - base.width),
        y: clamp(base.y + dyn, 0, 1 - base.height),
      });
      return;
    }

    // 角落拖动：对角固定，宽高按目标比例联动
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect || !rect.width || !rect.height) return;
    const anchorX = drag.mode.includes("w") ? base.x + base.width : base.x;
    const anchorY = drag.mode.includes("n") ? base.y + base.height : base.y;
    const pointerX = clamp((event.clientX - rect.left) / rect.width, 0, 1);
    const pointerY = clamp((event.clientY - rect.top) / rect.height, 0, 1);
    // 归一化空间里的宽高比：w / h = ratio * (H / W)
    const k = (ratio * size.h) / size.w;
    const dirX = drag.mode.includes("w") ? -1 : 1;
    const dirY = drag.mode.includes("n") ? -1 : 1;
    const roomX = dirX < 0 ? anchorX : 1 - anchorX;
    const roomY = dirY < 0 ? anchorY : 1 - anchorY;
    const maxWidth = Math.max(MIN_SIDE, Math.min(roomX, roomY * k));
    // 指针离锚点的横向 / 纵向距离，哪个大听哪个，拖起来更跟手
    const width = clamp(
      Math.max(Math.abs(pointerX - anchorX), Math.abs(pointerY - anchorY) * k),
      MIN_SIDE,
      maxWidth,
    );
    const height = width / k;
    setBox({
      x: dirX < 0 ? anchorX - width : anchorX,
      y: dirY < 0 ? anchorY - height : anchorY,
      width,
      height,
    });
  };

  const endDrag = () => {
    dragRef.current = null;
  };

  return (
    <Modal
      open={open}
      onClose={onCancel}
      title="框选画面"
      description={`在画面上拖出要用的区域，选框比例固定为 ${targetLabel}，框外的内容会被裁掉`}
      width="max-w-3xl"
      footer={
        <>
          <Button size="sm" onClick={onUseFull}>
            用整张图
          </Button>
          <Button size="sm" variant="primary" disabled={!box} onClick={() => box && onApply(box)}>
            <IconCrop className="h-3.5 w-3.5" />
            应用框选
          </Button>
        </>
      }
    >
      <div className="space-y-2.5">
        <div className="flex items-center justify-between text-[11.5px] text-slate-400">
          <span>拖动框内移动，拖四角缩放；框外变暗的部分就是会被裁掉的</span>
          <span className="tabular-nums text-slate-500">
            选区 {span} · 输出比例 {targetLabel}
          </span>
        </div>

        <div className="flex max-h-[64vh] items-center justify-center overflow-hidden rounded-xl border border-white/10 bg-black/40 p-2">
          <div
            ref={wrapRef}
            className="relative inline-block touch-none select-none"
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
          >
            <img
              src={src}
              alt="待框选画面"
              draggable={false}
              className="block max-h-[60vh] max-w-full"
              onLoad={measure}
            />
            {px && box && (
              <>
                {/* 四块半透明遮罩拼出「框外」区域，比 box-shadow 的扩散更可控 */}
                <div className="pointer-events-none absolute inset-0">
                  <div
                    className="absolute left-0 top-0 w-full"
                    style={{ height: px.y, backgroundColor: "rgba(0,0,0,0.58)" }}
                  />
                  <div
                    className="absolute left-0 w-full"
                    style={{ top: px.y + px.h, bottom: 0, backgroundColor: "rgba(0,0,0,0.58)" }}
                  />
                  <div
                    className="absolute left-0"
                    style={{ top: px.y, width: px.x, height: px.h, backgroundColor: "rgba(0,0,0,0.58)" }}
                  />
                  <div
                    className="absolute"
                    style={{
                      top: px.y,
                      left: px.x + px.w,
                      right: 0,
                      height: px.h,
                      backgroundColor: "rgba(0,0,0,0.58)",
                    }}
                  />
                </div>
                <div
                  className="absolute cursor-move border border-[#fff]/90"
                  style={{ left: px.x, top: px.y, width: px.w, height: px.h }}
                  onPointerDown={(event) => startDrag(event, "move")}
                >
                  {/* 三分线，构图参考 */}
                  <div className="pointer-events-none absolute inset-0 opacity-40">
                    <div className="absolute left-1/3 top-0 h-full w-px bg-[#fff]/70" />
                    <div className="absolute left-2/3 top-0 h-full w-px bg-[#fff]/70" />
                    <div className="absolute top-1/3 left-0 w-full h-px bg-[#fff]/70" />
                    <div className="absolute top-2/3 left-0 w-full h-px bg-[#fff]/70" />
                  </div>
                </div>
                {(
                  [
                    ["nw", "cursor-nwse-resize"],
                    ["ne", "cursor-nesw-resize"],
                    ["sw", "cursor-nesw-resize"],
                    ["se", "cursor-nwse-resize"],
                  ] as Array<[Handle, string]>
                ).map(([mode, cls]) => (
                  <span
                    key={mode}
                    onPointerDown={(event) => startDrag(event, mode)}
                    className={`absolute h-3 w-3 rounded-full border border-black/40 bg-[#fff] shadow ${cls}`}
                    style={{
                      left: (mode.includes("w") ? px.x : px.x + px.w) - 6,
                      top: (mode.includes("n") ? px.y : px.y + px.h) - 6,
                    }}
                  />
                ))}
              </>
            )}
          </div>
        </div>

        <div className="flex justify-end">
          <Button size="sm" onClick={() => setBox(defaultBox(ratio, size.w, size.h))}>
            <IconRefresh className="h-3.5 w-3.5" />
            重置选框
          </Button>
        </div>
      </div>
    </Modal>
  );
}
