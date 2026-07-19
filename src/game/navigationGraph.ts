import type { NavigationTraversal, Vec3, WaypointLink } from './types';

export interface NavigationGraph {
  waypoints: Vec3[];
  links: WaypointLink[];
}

export type NamedWalkEdge = readonly [from: string, to: string];
export type NamedDirectedEdge = readonly [
  from: string,
  to: string,
  traversal: NavigationTraversal,
];

/**
 * Resolves readable, authored node names to the compact numeric graph stored
 * in MapDefinition. This runs once when a map module loads; bot ticks only see
 * the precomputed indexes and never perform string lookups.
 */
export const createNamedNavigationGraph = (
  nodes: Readonly<Record<string, Vec3>>,
  walkEdges: readonly NamedWalkEdge[],
  directedEdges: readonly NamedDirectedEdge[] = [],
): NavigationGraph => {
  const names = Object.keys(nodes);
  const indexes = new Map(names.map((name, index) => [name, index]));
  const indexOf = (name: string): number => {
    const index = indexes.get(name);
    if (index === undefined) throw new Error(`Unknown navigation waypoint "${name}".`);
    return index;
  };

  return {
    waypoints: names.map((name) => nodes[name]!),
    links: [
      ...walkEdges.map(([from, to]): WaypointLink => ({
        from: indexOf(from),
        to: indexOf(to),
        traversal: 'walk',
        bidirectional: true,
      })),
      ...directedEdges.map(([from, to, traversal]): WaypointLink => ({
        from: indexOf(from),
        to: indexOf(to),
        traversal,
        bidirectional: false,
      })),
    ],
  };
};
