// The editor's model: React Flow nodes and edges <-> the stored graph, new steps, inserting and undo history.
import { useCallback, useRef, useState } from "react";
import type { Edge, Node } from "@xyflow/react";
import { NODE_GAP, actionDef, defaultConfig, triggerDef, type AutomationEdge, type AutomationGraph, type AutomationNode, type NodeData, type NodeKind } from "@reachstack/shared";

export type FlowData = NodeData & Record<string, unknown>;
export type FlowNode = Node<FlowData, NodeKind>;
export type FlowEdge = Edge;

const hex = (n: number) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, "0")).join("");
export const newId = (prefix = "n") => `${prefix}_${hex(5)}`;

export function toFlow(graph: AutomationGraph): { nodes: FlowNode[]; edges: FlowEdge[] } {
  return {
    nodes: graph.nodes.map((n) => ({ id: n.id, type: n.type, position: { ...n.position }, data: { ...n.data } as FlowData })),
    edges: graph.edges.map((e) => ({ id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle ?? null, type: "step" })),
  };
}

function cleanData(data: FlowData): NodeData {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) if (v !== undefined) out[k] = v;
  return out as NodeData;
}

export function toGraph(nodes: FlowNode[], edges: FlowEdge[]): AutomationGraph {
  return {
    nodes: nodes.map((n) => ({ id: n.id, type: n.type as NodeKind, position: { x: Math.round(n.position.x), y: Math.round(n.position.y) }, data: cleanData(n.data) })),
    edges: edges.map((e) => ({ id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle ?? null })),
  };
}

/** A new step of a kind, with its fields' defaults (a timezone starts on `zone`, the workspace's). */
export function makeNode(kind: NodeKind, key: string | null, position: { x: number; y: number }, zone?: string): AutomationNode {
  const id = newId();
  const fields = kind === "trigger" ? triggerDef(key)?.fields : kind === "action" ? actionDef(key)?.fields : undefined;
  const data: NodeData =
    kind === "trigger" || kind === "action"
      ? { key, config: defaultConfig(fields ?? [], zone) }
      : kind === "condition"
        ? { groups: [{ rules: [{ field: "", operator: "equals", value: "" }] }] }
        : kind === "delay"
          ? { amount: 1, unit: "days" }
          : kind === "paths"
            ? { paths: [{ id: newId("p"), name: "Path A" }, { id: newId("p"), name: "Path B" }] }
            : {};
  return { id, type: kind, position, data };
}

/** The handle a new step continues from: a condition's true branch, the first path, or the default output. */
export function firstHandle(node: Pick<AutomationNode, "type" | "data">): string | null {
  if (node.type === "condition") return "true";
  if (node.type === "paths") return node.data.paths?.[0]?.id ?? null;
  return null;
}

/** Horizontal offset of a step added under one of several branches. */
export function branchOffset(node: Pick<AutomationNode, "type" | "data">, handle: string | null): number {
  if (node.type === "condition") return handle === "false" ? NODE_GAP.x / 2 : -NODE_GAP.x / 2;
  if (node.type === "paths") {
    const paths = node.data.paths ?? [];
    const i = Math.max(0, paths.findIndex((p) => p.id === handle));
    return (i - (paths.length - 1) / 2) * NODE_GAP.x;
  }
  return 0;
}

/** Steps reachable from a step (itself included). */
export function descendants(graph: AutomationGraph, id: string): Set<string> {
  const out = new Set([id]);
  const queue = [id];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const e of graph.edges) if (e.source === cur && !out.has(e.target)) (out.add(e.target), queue.push(e.target));
  }
  return out;
}

/** Steps that run before a step (the ones whose data it can use). */
export function ancestors(graph: AutomationGraph, id: string): Set<string> {
  const out = new Set<string>();
  const queue = [id];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const e of graph.edges) if (e.target === cur && !out.has(e.source) && e.source !== id) (out.add(e.source), queue.push(e.source));
  }
  return out;
}

/** Adds a step after `source` (on `handle`); returns the new graph. */
export function addAfter(graph: AutomationGraph, sourceId: string, handle: string | null, node: AutomationNode): AutomationGraph {
  const source = graph.nodes.find((n) => n.id === sourceId)!;
  node.position = { x: source.position.x + branchOffset(source, handle), y: source.position.y + NODE_GAP.y };
  return { nodes: [...graph.nodes, node], edges: [...graph.edges, { id: newId("e"), source: sourceId, target: node.id, sourceHandle: handle }] };
}

/** Puts a step on a connection, pushing the steps below it down a row. */
export function insertOnEdge(graph: AutomationGraph, edgeId: string, node: AutomationNode): AutomationGraph {
  const edge = graph.edges.find((e) => e.id === edgeId)!;
  const target = graph.nodes.find((n) => n.id === edge.target)!;
  const below = descendants(graph, target.id);
  node.position = { ...target.position };
  const edges: AutomationEdge[] = [
    ...graph.edges.filter((e) => e.id !== edgeId),
    { id: newId("e"), source: edge.source, target: node.id, sourceHandle: edge.sourceHandle ?? null },
    { id: newId("e"), source: node.id, target: target.id, sourceHandle: firstHandle(node) },
  ];
  const nodes = graph.nodes.map((n) => (below.has(n.id) ? { ...n, position: { x: n.position.x, y: n.position.y + NODE_GAP.y } } : n));
  return { nodes: [...nodes, node], edges };
}

/** Removes steps and every connection touching them. */
export function removeNodes(graph: AutomationGraph, ids: string[]): AutomationGraph {
  const gone = new Set(ids);
  return { nodes: graph.nodes.filter((n) => !gone.has(n.id)), edges: graph.edges.filter((e) => !gone.has(e.source) && !gone.has(e.target)) };
}

/**
 * Removes one step. A step in a plain chain (one way in, one way out) is closed up: the step before connects to the
 * step after, and the steps below move up a row when nothing else leads into them.
 */
export function removeStep(graph: AutomationGraph, id: string): AutomationGraph {
  const node = graph.nodes.find((n) => n.id === id);
  const ins = graph.edges.filter((e) => e.target === id);
  const outs = graph.edges.filter((e) => e.source === id);
  const next = removeNodes(graph, [id]);
  if (!node || node.type === "trigger" || node.type === "condition" || node.type === "paths" || ins.length !== 1 || outs.length !== 1) return next;
  const [inEdge, outEdge] = [ins[0]!, outs[0]!];
  const handle = inEdge.sourceHandle ?? null;
  if (!next.edges.some((e) => e.source === inEdge.source && e.target === outEdge.target && (e.sourceHandle ?? null) === handle)) {
    next.edges.push({ id: newId("e"), source: inEdge.source, target: outEdge.target, sourceHandle: handle });
  }
  const below = descendants(graph, outEdge.target);
  const joinedFromElsewhere = graph.edges.some((e) => below.has(e.target) && !below.has(e.source) && e.source !== id);
  if (!joinedFromElsewhere) next.nodes = next.nodes.map((n) => (below.has(n.id) ? { ...n, position: { x: n.position.x, y: n.position.y - NODE_GAP.y } } : n));
  return next;
}

export interface History {
  /** Records the graph as it was before a change; changes with the same key within a second count as one. */
  push(before: AutomationGraph, key?: string): void;
  undo(current: AutomationGraph): AutomationGraph | null;
  redo(current: AutomationGraph): AutomationGraph | null;
  canUndo: boolean;
  canRedo: boolean;
  reset(): void;
}

export function useHistory(limit = 100): History {
  const past = useRef<AutomationGraph[]>([]);
  const future = useRef<AutomationGraph[]>([]);
  const last = useRef<{ key: string; at: number } | null>(null);
  const [, setTick] = useState(0);
  const bump = () => setTick((t) => t + 1);
  const push = useCallback((before: AutomationGraph, key?: string) => {
    const now = Date.now();
    if (key && last.current?.key === key && now - last.current.at < 1_000) {
      last.current.at = now;
      return;
    }
    last.current = key ? { key, at: now } : null;
    past.current = [...past.current.slice(-(limit - 1)), before];
    future.current = [];
    bump();
  }, [limit]);
  const undo = useCallback((current: AutomationGraph) => {
    const prev = past.current.pop();
    if (!prev) return null;
    future.current.push(current);
    last.current = null;
    bump();
    return prev;
  }, []);
  const redo = useCallback((current: AutomationGraph) => {
    const next = future.current.pop();
    if (!next) return null;
    past.current.push(current);
    last.current = null;
    bump();
    return next;
  }, []);
  const reset = useCallback(() => {
    past.current = [];
    future.current = [];
    last.current = null;
    bump();
  }, []);
  return { push, undo, redo, reset, canUndo: past.current.length > 0, canRedo: future.current.length > 0 };
}
