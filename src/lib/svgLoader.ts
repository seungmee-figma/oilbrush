import { parseSync, INode } from "svgson";

function resolveColor(node: INode, attr: string): string | null {
  const val = node.attributes[attr];
  if (!val || val === "none") return null;
  if (val.startsWith("#"))
    return val.length === 4
      ? `#${val[1]}${val[1]}${val[2]}${val[2]}${val[3]}${val[3]}`
      : val;
  const m = val.match(/^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/i);
  if (m)
    return `#${[m[1], m[2], m[3]].map((v) => parseInt(v).toString(16).padStart(2, "0")).join("")}`;
  const named: Record<string, string> = {
    red: "#ff0000",
    green: "#00ff00",
    blue: "#0000ff",
    black: "#000000",
    white: "#ffffff",
    orange: "#ffa500",
    yellow: "#ffff00",
    purple: "#800080",
    pink: "#ffc0cb",
    cyan: "#00ffff",
  };
  return named[val.toLowerCase()] || val;
}

export interface SvgData {
  paths: string[];
  colors: (string | null)[];
  dimensions: { width: number; height: number };
}

export const loadSvgPaths = async (svgFileName: string): Promise<SvgData> => {
  try {
    const response = await fetch(`/svg/${svgFileName}`);
    if (!response.ok) {
      throw new Error(`Failed to load SVG file: ${svgFileName} (${response.status})`);
    }
    const svgContent = await response.text();
    return parseSvgContent(svgContent);
  } catch (error) {
    console.error("Error loading SVG file:", error);
    return { paths: [], colors: [], dimensions: { width: 100, height: 100 } };
  }
};

export const parseSvgContent = (svgContent: string): SvgData => {
  try {
    const parsedSvg = parseSync(svgContent);

    const width = parsedSvg.attributes.width
      ? parseFloat(parsedSvg.attributes.width)
      : 0;
    const height = parsedSvg.attributes.height
      ? parseFloat(parsedSvg.attributes.height)
      : 0;
    const viewBox = parsedSvg.attributes.viewBox
      ? parsedSvg.attributes.viewBox.split(" ").map(Number)
      : null;

    const dimensions = {
      width: width || (viewBox ? viewBox[2] : 100),
      height: height || (viewBox ? viewBox[3] : 100),
    };

    const paths: string[] = [];
    const colors: (string | null)[] = [];

    const extractPaths = (node: INode, inheritedStroke: string | null) => {
      const stroke = resolveColor(node, "stroke") || inheritedStroke;
      if (node.name === "path" && node.attributes.d) {
        paths.push(node.attributes.d);
        colors.push(
          resolveColor(node, "stroke") ||
            resolveColor(node, "fill") ||
            stroke ||
            null
        );
      }
      if (node.children) {
        node.children.forEach((c) => extractPaths(c, stroke));
      }
    };

    extractPaths(parsedSvg, null);
    return { paths, colors, dimensions };
  } catch (error) {
    console.error("Error parsing SVG content:", error);
    return { paths: [], colors: [], dimensions: { width: 100, height: 100 } };
  }
};
