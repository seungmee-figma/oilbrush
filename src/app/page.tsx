"use client";

import dynamic from "next/dynamic";

const OilBrushCanvas = dynamic(() => import("@/components/OilBrushCanvas"), {
  ssr: false,
});

export default function Home() {
  return <OilBrushCanvas />;
}
