import type {
  CanvasDocumentContractV3,
  CanvasGroupContract,
  CanvasLayerContract,
  CanvasLayerStackKind,
  CanvasNodeContract,
  CanvasStackForests,
} from '@workbench/canvas-engine/contracts';

import { LAYER_STACKS_TOP_FIRST } from '@workbench/canvas-engine/contracts';

import { collectSubtree, isGroupNode } from './documentTree';

/** Document facts about one node's place in its forest. */
export interface CanvasNodeEntry {
  readonly node: CanvasNodeContract;
  readonly stack: CanvasLayerStackKind;
  readonly parentId: string | null;
  /** Ancestor ids, root first; `path.length` is the node's depth. */
  readonly path: readonly string[];
  readonly siblingIndex: number;
  /** Position among every node, stacks top first, each stack in preorder. */
  readonly order: number;
  /** Whether every ancestor is enabled, unlocked, or unhidden respectively. */
  readonly ancestorsEnabled: boolean;
  readonly ancestorsLocked: boolean;
  readonly ancestorsHidden: boolean;
}

/**
 * The per-forest index shared by the reducer, the mirror and the document model. It is keyed on
 * the `stacks` object, which the reducer preserves across selection, bbox and geometry-only edits.
 */
export interface CanvasDocumentIndex {
  readonly stacks: CanvasStackForests;
  readonly byId: ReadonlyMap<string, CanvasNodeEntry>;
  /** Every node, stacks top first, each in preorder. A derived index materializes this on first read. */
  readonly nodes: readonly CanvasNodeEntry[];
  /** Every leaf, in the same order. */
  readonly leaves: readonly CanvasLayerContract[];
  readonly maxDepth: number;
  /** Set on an index derived from a value edit: the index it extends and the ids whose entries changed. */
  readonly derivedFrom?: { readonly previous: CanvasDocumentIndex; readonly changedIds: ReadonlySet<string> };
}

const diagnostics = { entriesVisited: 0, indexBuilds: 0, indexDerivations: 0, nodesMaterialized: 0 };

export const getDocumentIndexBuildCount = (): number => diagnostics.indexBuilds;

/** Indexes derived from a previous one after a value edit, without walking the forests. */
export const getDocumentIndexDerivationCount = (): number => diagnostics.indexDerivations;

/** Entries constructed, by a build or a derivation: the work an edit actually costs. */
export const getDocumentIndexVisitCount = (): number => diagnostics.entriesVisited;

/** Times a derived index had to materialize its full `nodes` array for a consumer. */
export const getDocumentIndexMaterializationCount = (): number => diagnostics.nodesMaterialized;

export const resetDocumentIndexBuildCount = (): void => {
  diagnostics.entriesVisited = 0;
  diagnostics.indexBuilds = 0;
  diagnostics.indexDerivations = 0;
  diagnostics.nodesMaterialized = 0;
};

/** How many derivations may chain before the next one flattens onto the plain root. */
const MAX_DERIVATION_DEPTH = 8;
/** Overrides may cover this fraction of the root before flattening rebuilds a plain index instead. */
const MAX_OVERRIDE_RATIO = 0.25;

/**
 * A map that reads through to the previous index's map for every entry a value edit did not touch.
 * Lookups cost one extra step per derivation; iteration substitutes overrides on the fly.
 */
class LayeredEntryMap implements ReadonlyMap<string, CanvasNodeEntry> {
  readonly [Symbol.toStringTag] = 'LayeredEntryMap';

  constructor(
    private readonly base: ReadonlyMap<string, CanvasNodeEntry>,
    private readonly overrides: ReadonlyMap<string, CanvasNodeEntry>
  ) {}

  get size(): number {
    return this.base.size;
  }

  get(key: string): CanvasNodeEntry | undefined {
    return this.overrides.get(key) ?? this.base.get(key);
  }

  has(key: string): boolean {
    return this.base.has(key);
  }

  forEach(
    callback: (value: CanvasNodeEntry, key: string, map: ReadonlyMap<string, CanvasNodeEntry>) => void,
    thisArg?: unknown
  ): void {
    for (const [key, value] of this) {
      callback.call(thisArg, value, key, this);
    }
  }

  *entries(): MapIterator<[string, CanvasNodeEntry]> {
    for (const [key, value] of this.base) {
      yield [key, this.overrides.get(key) ?? value];
    }
  }

  keys(): MapIterator<string> {
    return this.base.keys();
  }

  *values(): MapIterator<CanvasNodeEntry> {
    for (const [, value] of this) {
      yield value;
    }
  }

  [Symbol.iterator](): MapIterator<[string, CanvasNodeEntry]> {
    return this.entries();
  }
}

/**
 * An index that extends a source index by the entries a value edit replaced; the rest reads through.
 * Chains read through their predecessors; every ninth derivation flattens onto the plain root so
 * lookups stay bounded and nothing older than the root is retained.
 */
class DerivedIndex implements CanvasDocumentIndex {
  readonly byId: ReadonlyMap<string, CanvasNodeEntry>;
  readonly derivedFrom: { readonly previous: CanvasDocumentIndex; readonly changedIds: ReadonlySet<string> };
  readonly maxDepth: number;
  private nodesCache: readonly CanvasNodeEntry[] | null = null;
  private leavesCache: readonly CanvasLayerContract[] | null = null;

  constructor(
    readonly stacks: CanvasStackForests,
    private readonly source: CanvasDocumentIndex,
    readonly overrides: ReadonlyMap<string, CanvasNodeEntry>,
    readonly leafChanged: boolean
  ) {
    this.byId = new LayeredEntryMap(source.byId, overrides);
    this.derivedFrom = { changedIds: new Set(overrides.keys()), previous: source };
    this.maxDepth = source.maxDepth;
  }

  get nodes(): readonly CanvasNodeEntry[] {
    if (this.nodesCache === null) {
      diagnostics.nodesMaterialized += 1;
      this.nodesCache = this.patchedNodes();
    }
    return this.nodesCache;
  }

  /** The same content as a plain index; building it is part of flattening, not a consumer read. */
  plain(): CanvasDocumentIndex {
    return {
      byId: new Map(this.byId),
      leaves: this.leaves,
      maxDepth: this.maxDepth,
      nodes: this.nodesCache ?? this.patchedNodes(),
      stacks: this.stacks,
    };
  }

  private patchedNodes(): readonly CanvasNodeEntry[] {
    const nodes = this.source.nodes.slice();
    for (const entry of this.overrides.values()) {
      nodes[entry.order] = entry;
    }
    return nodes;
  }

  get leaves(): readonly CanvasLayerContract[] {
    if (!this.leafChanged) {
      return this.source.leaves;
    }
    if (this.leavesCache === null) {
      this.leavesCache = this.source.leaves.map(
        (leaf) => (this.overrides.get(leaf.id)?.node as CanvasLayerContract | undefined) ?? leaf
      );
    }
    return this.leavesCache;
  }
}

const derivationDepth = (index: CanvasDocumentIndex): number => {
  let depth = 0;
  let current: CanvasDocumentIndex | undefined = index;
  while (current?.derivedFrom) {
    depth += 1;
    current = current.derivedFrom.previous;
  }
  return depth;
};

/**
 * Folds a chain onto its plain root: one override layer holding the newest entry of every id the
 * chain touched. Once overrides cover too much of the root, a plain index is cheaper than the layer.
 */
const flatten = (index: DerivedIndex): CanvasDocumentIndex => {
  const overrides = new Map<string, CanvasNodeEntry>();
  let leafChanged = false;
  let current: CanvasDocumentIndex = index;
  while (current instanceof DerivedIndex) {
    for (const [id, entry] of current.overrides) {
      if (!overrides.has(id)) {
        overrides.set(id, entry);
      }
    }
    leafChanged ||= current.leafChanged;
    current = current.derivedFrom.previous;
  }
  const flat = new DerivedIndex(index.stacks, current, overrides, leafChanged);
  return overrides.size <= current.byId.size * MAX_OVERRIDE_RATIO ? flat : flat.plain();
};

type DocumentView = Pick<CanvasDocumentContractV3, 'stacks'> | null | undefined;

const EMPTY_LEAVES: readonly CanvasLayerContract[] = [];

const indexes = new WeakMap<CanvasStackForests, CanvasDocumentIndex>();

const build = (stacks: CanvasStackForests): CanvasDocumentIndex => {
  diagnostics.indexBuilds += 1;
  const byId = new Map<string, CanvasNodeEntry>();
  const nodes: CanvasNodeEntry[] = [];
  const leaves: CanvasLayerContract[] = [];
  let maxDepth = 0;
  const visit = (
    children: readonly CanvasNodeContract[],
    stack: CanvasLayerStackKind,
    parent: CanvasGroupContract | null,
    path: readonly string[],
    ancestorsEnabled: boolean,
    ancestorsLocked: boolean,
    ancestorsHidden: boolean
  ): void => {
    maxDepth = Math.max(maxDepth, path.length);
    children.forEach((node, siblingIndex) => {
      diagnostics.entriesVisited += 1;
      const entry: CanvasNodeEntry = {
        ancestorsEnabled,
        ancestorsHidden,
        ancestorsLocked,
        node,
        order: nodes.length,
        parentId: parent?.id ?? null,
        path,
        siblingIndex,
        stack,
      };
      byId.set(node.id, entry);
      nodes.push(entry);
      if (isGroupNode(node)) {
        visit(
          node.children,
          stack,
          node,
          [...path, node.id],
          ancestorsEnabled && node.isEnabled,
          ancestorsLocked || node.isLocked,
          ancestorsHidden || node.isHidden === true
        );
      } else {
        leaves.push(node);
      }
    });
  };
  for (const stack of LAYER_STACKS_TOP_FIRST) {
    visit(stacks[stack], stack, null, [], true, false, false);
  }
  return { byId, leaves, maxDepth, nodes, stacks };
};

const flagsChanged = (previous: CanvasNodeContract, next: CanvasNodeContract): boolean =>
  isGroupNode(previous) &&
  isGroupNode(next) &&
  (previous.isEnabled !== next.isEnabled ||
    previous.isLocked !== next.isLocked ||
    (previous.isHidden === true) !== (next.isHidden === true));

/**
 * Registers the index of `nextStacks` as a derivation of `previousStacks`' index after a value edit
 * that rewrote exactly the nodes in `changed` (and, through structural sharing, their ancestors).
 * Structure is untouched, so every entry keeps its place; only the replaced nodes, their ancestors,
 * and the subtree under a group whose flags changed get new entries. Everything else reads through
 * to the previous index, so the cost is the changed paths, never the document. Returns `null` when
 * no previous index exists or the edit was not a value edit, leaving the next lookup to build.
 */
export const deriveIndexForValueEdit = (
  previousStacks: CanvasStackForests,
  nextStacks: CanvasStackForests,
  changed: ReadonlyMap<string, CanvasNodeContract>
): CanvasDocumentIndex | null => {
  const existing = indexes.get(nextStacks);
  if (existing) {
    return existing;
  }
  const previous = indexes.get(previousStacks);
  if (!previous || previousStacks === nextStacks) {
    return null;
  }
  const replacedNodes = new Map<string, CanvasNodeContract>();
  const reflagged: CanvasGroupContract[] = [];
  for (const [id, node] of changed) {
    const entry = previous.byId.get(id);
    if (!entry || entry.node.id !== node.id || isGroupNode(entry.node) !== isGroupNode(node)) {
      return null;
    }
    replacedNodes.set(id, node);
    if (flagsChanged(entry.node, node) && isGroupNode(node)) {
      reflagged.push(node);
    }
  }
  // Ancestors were rebuilt along each changed path; find their new objects from the new roots.
  for (const id of changed.keys()) {
    const entry = previous.byId.get(id)!;
    let siblings: readonly CanvasNodeContract[] = nextStacks[entry.stack];
    for (const ancestorId of entry.path) {
      const known = replacedNodes.get(ancestorId);
      const ancestor = known ?? siblings.find((node) => node.id === ancestorId);
      if (!ancestor || !isGroupNode(ancestor)) {
        return null;
      }
      replacedNodes.set(ancestorId, ancestor);
      siblings = ancestor.children;
    }
  }
  diagnostics.indexDerivations += 1;
  const nodeOf = (id: string): CanvasNodeContract => replacedNodes.get(id) ?? previous.byId.get(id)!.node;
  const replaced = new Map<string, CanvasNodeEntry>();
  let leafChanged = false;
  const replaceEntry = (id: string, node: CanvasNodeContract, reflag: boolean): void => {
    const entry = previous.byId.get(id)!;
    diagnostics.entriesVisited += 1;
    if (node !== entry.node && !isGroupNode(node)) {
      leafChanged = true;
    }
    const ancestors = reflag ? entry.path.map(nodeOf) : null;
    replaced.set(id, {
      ...entry,
      ancestorsEnabled: ancestors ? ancestors.every((ancestor) => ancestor.isEnabled) : entry.ancestorsEnabled,
      ancestorsHidden: ancestors
        ? ancestors.some((ancestor) => isGroupNode(ancestor) && ancestor.isHidden === true)
        : entry.ancestorsHidden,
      ancestorsLocked: ancestors ? ancestors.some((ancestor) => ancestor.isLocked) : entry.ancestorsLocked,
      node,
    });
  };
  // Only the subtree under a group whose flags changed re-derives its ancestor-effective flags;
  // a replaced node inside such a subtree is entered there once, with the new ancestors.
  for (const group of reflagged) {
    for (const member of collectSubtree(group)) {
      if (member.id !== group.id) {
        replaceEntry(member.id, member, true);
      }
    }
  }
  for (const [id, node] of replacedNodes) {
    if (!replaced.has(id)) {
      replaceEntry(id, node, false);
    }
  }
  const derived = new DerivedIndex(nextStacks, previous, replaced, leafChanged);
  const registered = derivationDepth(derived) > MAX_DERIVATION_DEPTH ? flatten(derived) : derived;
  indexes.set(nextStacks, registered);
  return registered;
};

export const indexStacks = (stacks: CanvasStackForests): CanvasDocumentIndex => {
  const existing = indexes.get(stacks);
  if (existing) {
    return existing;
  }
  const built = build(stacks);
  indexes.set(stacks, built);
  return built;
};

export const getDocumentIndex = (document: Pick<CanvasDocumentContractV3, 'stacks'>): CanvasDocumentIndex =>
  indexStacks(document.stacks);

/** The document's leaves, stacks top first, each in preorder; the same array while `stacks` is unchanged. */
export const getDocumentLeaves = (document: DocumentView): readonly CanvasLayerContract[] =>
  document ? indexStacks(document.stacks).leaves : EMPTY_LEAVES;

export const getDocumentNode = (document: DocumentView, id: string | null | undefined): CanvasNodeContract | null =>
  document && id ? (indexStacks(document.stacks).byId.get(id)?.node ?? null) : null;

/** The leaf with `id`, or `null` when absent, a group, or there is no document. */
export const getDocumentLayer = (document: DocumentView, id: string | null | undefined): CanvasLayerContract | null => {
  const node = getDocumentNode(document, id);
  return node && !isGroupNode(node) ? node : null;
};

export const hasDocumentNode = (document: DocumentView, id: string): boolean =>
  !!document && indexStacks(document.stacks).byId.has(id);

/** True only when a document exists and holds no node with `id`. */
export const isNodeAbsent = (document: DocumentView, id: string): boolean =>
  !!document && !indexStacks(document.stacks).byId.has(id);

/** Whether `ancestorId` is `id` itself or one of its ancestors. */
export const isSelfOrAncestor = (index: CanvasDocumentIndex, id: string, ancestorId: string): boolean =>
  id === ancestorId || (index.byId.get(id)?.path.includes(ancestorId) ?? false);

/** Drops every id whose ancestor is also listed, keeping document order. */
export const outermostNodes = (index: CanvasDocumentIndex, ids: Iterable<string>): CanvasNodeEntry[] => {
  const selected = new Set(ids);
  const outer: CanvasNodeEntry[] = [];
  for (const entry of index.nodes) {
    if (selected.has(entry.node.id) && !entry.path.some((ancestor) => selected.has(ancestor))) {
      outer.push(entry);
    }
  }
  return outer;
};

/** The child list `parentId` names, read through the index; `null` when the parent is not a group of `stack`. */
export const childrenAt = (
  index: CanvasDocumentIndex,
  stack: CanvasLayerStackKind,
  parentId: string | null
): readonly CanvasNodeContract[] | null => {
  if (parentId === null) {
    return index.stacks[stack];
  }
  const parent = index.byId.get(parentId);
  return parent && parent.stack === stack && isGroupNode(parent.node) ? parent.node.children : null;
};
