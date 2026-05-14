"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { parsePathToPoints, applyPathNoise } from "@/lib/brush";
import { parseSvgContent, type SvgData } from "@/lib/svgLoader";
import { interpolateColor } from "@/lib/utils";
import { PerlinNoise } from "@/lib/perlin";

type ColorMode = "svg" | "single" | "gradient";

// ── Keyframe interpolation ──────────────────────────────────────────

function interpolatePoints(
  ptsA: { x: number; y: number }[],
  ptsB: { x: number; y: number }[],
  t: number
) {
  const maxLen = Math.max(ptsA.length, ptsB.length);
  const out: { x: number; y: number }[] = [];
  for (let i = 0; i < maxLen; i++) {
    const a = ptsA[Math.min(i, ptsA.length - 1)];
    const b = ptsB[Math.min(i, ptsB.length - 1)];
    out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  }
  return out;
}

function interpolateParsedPaths(
  ptsA: { x: number; y: number }[][],
  ptsB: { x: number; y: number }[][],
  t: number
) {
  const maxPaths = Math.max(ptsA.length, ptsB.length);
  const out: { x: number; y: number }[][] = [];
  for (let i = 0; i < maxPaths; i++) {
    const a = ptsA[Math.min(i, ptsA.length - 1)];
    const b = ptsB[Math.min(i, ptsB.length - 1)];
    out.push(interpolatePoints(a, b, t));
  }
  return out;
}

function interpolateColorArrays(colA: string[], colB: string[], t: number) {
  const maxLen = Math.max(colA.length, colB.length);
  const out: string[] = [];
  for (let i = 0; i < maxLen; i++) {
    const a = colA[Math.min(i, colA.length - 1)] || "#000000";
    const b = colB[Math.min(i, colB.length - 1)] || "#000000";
    out.push(interpolateColor(a, b, t));
  }
  return out;
}

// ── Component ───────────────────────────────────────────────────────

export default function OilBrushCanvas() {
  const [brushSize, setBrushSize] = useState(50);
  const [backgroundColor, setBackgroundColor] = useState("#ffffff");
  const [brushColors, setBrushColors] = useState({
    start: "#008bf5",
    end: "#ffd000",
  });
  const [colorMode, setColorMode] = useState<ColorMode>("svg");
  const [isRendering, setIsRendering] = useState(false);
  const [renderProgress, setRenderProgress] = useState(0);
  const [renderTime, setRenderTime] = useState<number | null>(null);
  const [hasResult, setHasResult] = useState(false);
  const [wWidth, setWWidth] = useState(800);
  const [wHeight, setWHeight] = useState(600);

  // SVG keyframes (multiple uploaded SVGs = keyframes for interpolation)
  const [svgKeyframes, setSvgKeyframes] = useState<SvgData[]>([]);

  // Tunable params
  const [readEvery, setReadEvery] = useState(50);
  const [mixStrength, setMixStrength] = useState(0.02);
  const [chainJoints, setChainJoints] = useState(2);
  const [pointStep, setPointStep] = useState(2);
  const [duration] = useState(5 * 60 * 1000);

  // Animation params
  const [animFrameCount, setAnimFrameCount] = useState(5);
  const [noiseAmplitude, setNoiseAmplitude] = useState(3);
  const [animFps, setAnimFps] = useState(10);
  const [transitionDuration, setTransitionDuration] = useState(2);

  // Pre-rendered frames
  const [preRenderedFrames, setPreRenderedFrames] = useState<ImageBitmap[]>([]);
  const [svgFrameIdx, setSvgFrameIdx] = useState(0);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const workerRef = useRef<Worker | null>(null);
  const renderStartRef = useRef(0);
  const animIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Derived: first keyframe is the "primary" for preview
  const primaryKf = svgKeyframes[0] || null;
  const svgDimensions = primaryKf?.dimensions || { width: 100, height: 100 };
  const rawPaths = primaryKf?.paths || [];
  const svgNativeColors = primaryKf?.colors || [];
  const hasMultipleKeyframes = svgKeyframes.filter((k) => k.paths.length > 0).length > 1;

  useEffect(() => {
    setWWidth(window.innerWidth);
    setWHeight(window.innerHeight);
  }, []);

  const computeColors = useCallback(
    (numPaths: number, nativeColors: (string | null)[]) => {
      if (colorMode === "svg" && nativeColors.length) {
        return Array.from(
          { length: numPaths },
          (_, i) =>
            nativeColors[Math.min(i, nativeColors.length - 1)] ||
            brushColors.start
        );
      } else if (colorMode === "single") {
        return Array.from({ length: numPaths }, () => brushColors.start);
      } else {
        return Array.from({ length: numPaths }, (_, i) => {
          const f = numPaths > 1 ? i / (numPaths - 1) : 0;
          return interpolateColor(brushColors.start, brushColors.end, f);
        });
      }
    },
    [colorMode, brushColors]
  );

  const handleSvgUpload = useCallback((files: FileList) => {
    const sorted = Array.from(files)
      .filter((f) => f.name.endsWith(".svg"))
      .sort((a, b) =>
        a.name.localeCompare(b.name, undefined, {
          numeric: true,
          sensitivity: "base",
        })
      );
    if (!sorted.length) return;

    const readers = sorted.map(
      (file) =>
        new Promise<string>((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.readAsText(file);
        })
    );

    Promise.all(readers).then((results) => {
      const keyframes: SvgData[] = [];
      for (const text of results) {
        const match = text.match(/<svg[\s\S]*<\/svg>/i);
        if (!match) continue;
        const data = parseSvgContent(match[0]);
        if (data.paths.length) keyframes.push(data);
      }
      if (keyframes.length) {
        setSvgKeyframes(keyframes);
        setHasResult(false);
        setRenderTime(null);
        setPreRenderedFrames([]);
      }
    });
  }, []);

  const startRender = useCallback(() => {
    if (!svgKeyframes.length || isRendering) return;

    setIsRendering(true);
    setRenderProgress(0);
    setHasResult(false);
    setRenderTime(null);
    setPreRenderedFrames([]);
    renderStartRef.current = performance.now();

    const validKeyframes = svgKeyframes.filter((k) => k.paths.length > 0);

    // Use the largest dimensions across all keyframes
    let maxDimW = 0,
      maxDimH = 0;
    for (const kf of validKeyframes) {
      maxDimW = Math.max(maxDimW, kf.dimensions.width);
      maxDimH = Math.max(maxDimH, kf.dimensions.height);
    }

    const maxW = 0.9 * wWidth;
    const maxH = 0.9 * wHeight;
    const scaleX = Math.min(maxW / maxDimW, maxH / maxDimH);
    const fittedW = maxDimW * scaleX;
    const fittedH = maxDimH * scaleX;
    const offsetX = (wWidth - fittedW) / 2;
    const offsetY = (wHeight - fittedH) / 2;

    let allFramePaths: { x: number; y: number }[][][] = [];
    let allFrameColors: string[][] = [];

    if (validKeyframes.length > 1) {
      // Multi-keyframe interpolation
      const framesPerTransition = Math.round(transitionDuration * animFps);
      const parsedKfs = validKeyframes.map((kf) =>
        kf.paths.map((d) => parsePathToPoints(d, 1000))
      );

      for (let ti = 0; ti < validKeyframes.length; ti++) {
        const ptsA = parsedKfs[ti];
        const ptsB = parsedKfs[(ti + 1) % validKeyframes.length];
        const colA = (validKeyframes[ti].colors || []).map(
          (c) => c || brushColors.start
        );
        const colB = (
          validKeyframes[(ti + 1) % validKeyframes.length].colors || []
        ).map((c) => c || brushColors.start);

        for (let fi = 0; fi < framesPerTransition; fi++) {
          const t = fi / framesPerTransition;
          const interpPts = interpolateParsedPaths(ptsA, ptsB, t);
          const scaledPts = interpPts.map((pts) =>
            pts.map((p) => ({
              x: p.x * scaleX + offsetX,
              y: p.y * scaleX + offsetY,
            }))
          );
          allFramePaths.push(scaledPts);

          if (colorMode === "svg") {
            allFrameColors.push(interpolateColorArrays(colA, colB, t));
          }
        }
      }
    } else {
      // Single SVG with noise-based animation
      const basePaths = validKeyframes[0].paths.map((pathD) => {
        const pts = parsePathToPoints(pathD, 1000);
        return pts.map((p) => ({
          x: p.x * scaleX + offsetX,
          y: p.y * scaleX + offsetY,
        }));
      });

      const noiseGen = new PerlinNoise();
      for (let fi = 0; fi < animFrameCount; fi++) {
        const seed = fi * 1000;
        let framePaths = basePaths.map((pts) => pts.map((p) => ({ ...p })));
        if (noiseAmplitude > 0) {
          framePaths = applyPathNoise(
            framePaths,
            seed,
            noiseAmplitude,
            noiseGen
          );
        }
        allFramePaths.push(framePaths);
      }
    }

    const baseColors = computeColors(
      allFramePaths[0].length,
      validKeyframes[0].colors
    );
    const maxBristles = Math.round(brushSize * 1.5);

    if (workerRef.current) workerRef.current.terminate();

    const worker = new Worker(
      new URL("@/lib/brushRenderWorker.js", import.meta.url)
    );
    workerRef.current = worker;

    worker.onmessage = (e) => {
      if (e.data.type === "progress") {
        setRenderProgress(e.data.value);
      } else if (e.data.type === "complete") {
        // Single frame result
        const elapsed = performance.now() - renderStartRef.current;
        setRenderTime(elapsed);
        setIsRendering(false);
        setRenderProgress(1);
        setHasResult(true);
        setPreRenderedFrames([e.data.bitmap]);
      } else if (e.data.type === "frames") {
        // Multi-frame result
        const elapsed = performance.now() - renderStartRef.current;
        setRenderTime(elapsed);
        setIsRendering(false);
        setRenderProgress(1);
        setHasResult(true);
        setPreRenderedFrames(e.data.bitmaps);
      } else if (e.data.type === "error") {
        console.error("Worker error:", e.data.message);
        setIsRendering(false);
      }
    };

    // Send all frames to worker at once — matches original pattern
    worker.postMessage({
      allFramePaths,
      allFrameColors: allFrameColors.length > 0 ? allFrameColors : null,
      config: {
        width: wWidth,
        height: wHeight,
        brushSize,
        duration,
        backgroundColor,
        pathColors: baseColors,
        simultaneous: false,
        svgType: "strokes",
        readEvery,
        mixMode: "gpu",
        mixStrength,
        maxBristles,
        chainJoints,
        pointStep,
        frameCount: allFramePaths.length,
      },
    });
  }, [
    svgKeyframes,
    isRendering,
    wWidth,
    wHeight,
    brushSize,
    duration,
    backgroundColor,
    computeColors,
    readEvery,
    mixStrength,
    chainJoints,
    pointStep,
    animFrameCount,
    noiseAmplitude,
    animFps,
    transitionDuration,
    colorMode,
    brushColors,
  ]);

  // Frame cycling animation
  useEffect(() => {
    if (animIntervalRef.current) {
      clearInterval(animIntervalRef.current);
      animIntervalRef.current = null;
    }
    if (!preRenderedFrames.length || !canvasRef.current) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    canvas.width = preRenderedFrames[0].width;
    canvas.height = preRenderedFrames[0].height;
    let idx = 0;
    ctx.drawImage(preRenderedFrames[0], 0, 0);
    setSvgFrameIdx(0);

    if (preRenderedFrames.length > 1) {
      animIntervalRef.current = setInterval(() => {
        idx = (idx + 1) % preRenderedFrames.length;
        ctx.drawImage(preRenderedFrames[idx], 0, 0);
        setSvgFrameIdx(idx);
      }, 1000 / animFps);
    }

    return () => {
      if (animIntervalRef.current) clearInterval(animIntervalRef.current);
    };
  }, [preRenderedFrames, animFps]);

  const clear = useCallback(() => {
    setHasResult(false);
    setRenderProgress(0);
    setRenderTime(null);
    setPreRenderedFrames([]);
    setSvgFrameIdx(0);
    if (animIntervalRef.current) {
      clearInterval(animIntervalRef.current);
      animIntervalRef.current = null;
    }
    if (workerRef.current) {
      workerRef.current.terminate();
      workerRef.current = null;
    }
    setIsRendering(false);
    const canvas = canvasRef.current;
    if (canvas) {
      const ctx = canvas.getContext("2d");
      if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
  }, []);

  useEffect(
    () => () => {
      if (workerRef.current) workerRef.current.terminate();
      if (animIntervalRef.current) clearInterval(animIntervalRef.current);
    },
    []
  );

  // SVG preview dimensions
  const svgFitScale = Math.min(
    (0.9 * wWidth) / svgDimensions.width,
    (0.9 * wHeight) / svgDimensions.height
  );
  const svgFitW = svgDimensions.width * svgFitScale;
  const svgFitH = svgDimensions.height * svgFitScale;

  return (
    <div className="w-full h-screen flex flex-row bg-gray-100 font-sans">
      {/* Canvas area */}
      <div
        className="flex-1 relative flex items-center justify-center overflow-hidden"
        style={{
          backgroundImage: "url(/canvas.jpeg)",
          backgroundRepeat: "repeat",
          backgroundSize: "250px 250px",
        }}
      >
        {/* SVG reference overlay */}
        {rawPaths.length > 0 && !hasResult && (
          <div
            className="absolute pointer-events-none"
            style={{
              width: `${svgFitW}px`,
              height: `${svgFitH}px`,
              opacity: 0.12,
              left: "50%",
              top: "50%",
              transform: "translate(-50%, -50%)",
            }}
          >
            <svg
              width="100%"
              height="100%"
              viewBox={`0 0 ${svgDimensions.width} ${svgDimensions.height}`}
              preserveAspectRatio="xMidYMid meet"
              overflow="visible"
            >
              {rawPaths.map((d, i) => (
                <path
                  key={i}
                  d={d}
                  fill="none"
                  stroke={
                    colorMode === "svg" && svgNativeColors[i]
                      ? svgNativeColors[i]!
                      : "black"
                  }
                  strokeWidth="1"
                />
              ))}
            </svg>
          </div>
        )}

        {/* Result canvas */}
        <canvas
          ref={canvasRef}
          className="absolute top-0 left-0 w-full h-full"
          style={{
            mixBlendMode: "multiply",
            display: hasResult ? "block" : "none",
          }}
        />

        {/* Frame counter */}
        {hasResult && preRenderedFrames.length > 1 && (
          <div className="absolute top-4 left-4 bg-white/80 backdrop-blur rounded-lg px-3 py-1 text-xs text-gray-500">
            {svgFrameIdx + 1} / {preRenderedFrames.length}
          </div>
        )}

        {/* Empty state */}
        {!rawPaths.length && !hasResult && (
          <div className="text-gray-400 text-center">
            <p className="text-lg font-medium">Upload an SVG to get started</p>
            <p className="text-sm mt-1">
              Upload multiple SVGs to interpolate between keyframes
            </p>
          </div>
        )}

        {/* Progress bar */}
        {isRendering && (
          <div className="absolute bottom-8 left-1/2 -translate-x-1/2 w-64">
            <div className="bg-white/80 backdrop-blur rounded-full h-2 overflow-hidden">
              <div
                className="bg-gray-900 h-full transition-all duration-300"
                style={{ width: `${renderProgress * 100}%` }}
              />
            </div>
          </div>
        )}
      </div>

      {/* Right panel */}
      <div className="flex-none w-64 bg-white border-l border-gray-200 flex flex-col overflow-y-auto z-10">
        <div className="px-4 py-4 flex flex-col gap-5">
          {/* Upload */}
          <div className="flex flex-col gap-1.5">
            <label className="text-xs text-gray-500 font-medium uppercase tracking-wide">
              SVG Input
            </label>
            <label className="w-full px-3 py-2 bg-gray-100 rounded-lg text-sm text-center cursor-pointer hover:bg-gray-200 transition-colors">
              Upload SVG
              <input
                type="file"
                accept=".svg"
                multiple
                className="hidden"
                onChange={(e) =>
                  e.target.files && handleSvgUpload(e.target.files)
                }
              />
            </label>
            {svgKeyframes.length > 0 && (
              <div className="text-xs text-gray-400">
                {svgKeyframes.length} keyframe{svgKeyframes.length > 1 ? "s" : ""} loaded
              </div>
            )}
          </div>

          <hr className="border-gray-100" />

          {/* Brush */}
          <div className="flex flex-col gap-1.5">
            <label className="text-xs text-gray-500 font-medium uppercase tracking-wide">
              Brush
            </label>
            <div className="flex items-center justify-between">
              <span className="text-xs text-gray-600">Size</span>
              <span className="text-xs text-gray-400 tabular-nums">
                {brushSize}
              </span>
            </div>
            <input
              type="range"
              min={5}
              max={200}
              value={brushSize}
              onChange={(e) => setBrushSize(Number(e.target.value))}
              className="w-full"
            />
            <div className="flex items-center justify-between">
              <span className="text-xs text-gray-600">Joints</span>
              <span className="text-xs text-gray-400 tabular-nums">
                {chainJoints}
              </span>
            </div>
            <input
              type="range"
              min={2}
              max={6}
              value={chainJoints}
              onChange={(e) => setChainJoints(Number(e.target.value))}
              className="w-full"
            />
            <div className="flex items-center justify-between">
              <span className="text-xs text-gray-600">Step</span>
              <span className="text-xs text-gray-400 tabular-nums">
                {pointStep}
              </span>
            </div>
            <input
              type="range"
              min={1}
              max={50}
              value={pointStep}
              onChange={(e) => setPointStep(Number(e.target.value))}
              className="w-full"
            />
          </div>

          <hr className="border-gray-100" />

          {/* Color */}
          <div className="flex flex-col gap-1.5">
            <label className="text-xs text-gray-500 font-medium uppercase tracking-wide">
              Color
            </label>
            <div className="flex gap-1">
              {(["svg", "single", "gradient"] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => setColorMode(m)}
                  className={`flex-1 px-2 py-1 text-xs rounded ${
                    colorMode === m
                      ? "bg-gray-900 text-white"
                      : "bg-gray-100 hover:bg-gray-200"
                  }`}
                >
                  {m}
                </button>
              ))}
            </div>
            {colorMode === "single" && (
              <div className="flex items-center gap-2 mt-1">
                <span className="text-xs text-gray-600">Brush</span>
                <input
                  type="color"
                  value={brushColors.start}
                  onChange={(e) =>
                    setBrushColors((p) => ({ ...p, start: e.target.value }))
                  }
                  className="w-6 h-6 rounded cursor-pointer"
                />
              </div>
            )}
            {colorMode === "gradient" && (
              <div className="flex items-center gap-3 mt-1">
                <div className="flex items-center gap-1.5">
                  <span className="text-xs text-gray-600">Start</span>
                  <input
                    type="color"
                    value={brushColors.start}
                    onChange={(e) =>
                      setBrushColors((p) => ({ ...p, start: e.target.value }))
                    }
                    className="w-6 h-6 rounded cursor-pointer"
                  />
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="text-xs text-gray-600">End</span>
                  <input
                    type="color"
                    value={brushColors.end}
                    onChange={(e) =>
                      setBrushColors((p) => ({ ...p, end: e.target.value }))
                    }
                    className="w-6 h-6 rounded cursor-pointer"
                  />
                </div>
              </div>
            )}
            <div className="flex items-center gap-2 mt-1">
              <span className="text-xs text-gray-600">Canvas</span>
              <input
                type="color"
                value={backgroundColor}
                onChange={(e) => setBackgroundColor(e.target.value)}
                className="w-6 h-6 rounded cursor-pointer"
              />
            </div>
          </div>

          <hr className="border-gray-100" />

          {/* Mixing */}
          <div className="flex flex-col gap-1.5">
            <label className="text-xs text-gray-500 font-medium uppercase tracking-wide">
              Mixing
            </label>
            <div className="flex items-center justify-between">
              <span className="text-xs text-gray-600">Strength</span>
              <span className="text-xs text-gray-400 tabular-nums">
                {mixStrength.toFixed(2)}
              </span>
            </div>
            <input
              type="range"
              min={1}
              max={30}
              value={mixStrength * 100}
              onChange={(e) => setMixStrength(Number(e.target.value) / 100)}
              className="w-full"
            />
            <div className="flex items-center justify-between">
              <span className="text-xs text-gray-600">Read Every</span>
              <span className="text-xs text-gray-400 tabular-nums">
                {readEvery}
              </span>
            </div>
            <input
              type="range"
              min={1}
              max={100}
              value={readEvery}
              onChange={(e) => setReadEvery(Number(e.target.value))}
              className="w-full"
            />
          </div>

          <hr className="border-gray-100" />

          {/* Animation */}
          <div className="flex flex-col gap-1.5">
            <label className="text-xs text-gray-500 font-medium uppercase tracking-wide">
              Animation
            </label>
            {hasMultipleKeyframes ? (
              <>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-gray-600">Transition (s)</span>
                  <span className="text-xs text-gray-400 tabular-nums">
                    {transitionDuration.toFixed(1)}
                  </span>
                </div>
                <input
                  type="range"
                  min={5}
                  max={50}
                  value={transitionDuration * 10}
                  onChange={(e) =>
                    setTransitionDuration(Number(e.target.value) / 10)
                  }
                  className="w-full"
                />
              </>
            ) : (
              <>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-gray-600">Frames</span>
                  <span className="text-xs text-gray-400 tabular-nums">
                    {animFrameCount}
                  </span>
                </div>
                <input
                  type="range"
                  min={1}
                  max={10}
                  value={animFrameCount}
                  onChange={(e) => setAnimFrameCount(Number(e.target.value))}
                  className="w-full"
                />
                <div className="flex items-center justify-between">
                  <span className="text-xs text-gray-600">Noise</span>
                  <span className="text-xs text-gray-400 tabular-nums">
                    {noiseAmplitude}
                  </span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={20}
                  value={noiseAmplitude}
                  onChange={(e) => setNoiseAmplitude(Number(e.target.value))}
                  className="w-full"
                />
              </>
            )}
            <div className="flex items-center justify-between">
              <span className="text-xs text-gray-600">FPS</span>
              <span className="text-xs text-gray-400 tabular-nums">
                {animFps}
              </span>
            </div>
            <input
              type="range"
              min={1}
              max={30}
              value={animFps}
              onChange={(e) => setAnimFps(Number(e.target.value))}
              className="w-full"
            />
          </div>
        </div>

        {/* Render buttons pinned to bottom */}
        <div className="mt-auto px-4 py-4 border-t border-gray-100 flex gap-2">
          <button
            onClick={startRender}
            disabled={isRendering || !svgKeyframes.length}
            className="flex-1 px-4 py-2 bg-gray-900 text-white text-sm rounded-lg hover:bg-gray-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {isRendering
              ? `${Math.round(renderProgress * 100)}%`
              : renderTime != null
                ? `Render (${(renderTime / 1000).toFixed(1)}s)`
                : "Render"}
          </button>
          <button
            onClick={clear}
            className="px-4 py-2 bg-gray-100 text-sm rounded-lg hover:bg-gray-200 transition-colors"
          >
            Clear
          </button>
        </div>
      </div>
    </div>
  );
}
