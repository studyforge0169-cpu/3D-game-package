/** Provider registry — assembles all 16 connectors (+ mock for tests). */

import type { AssetProvider, HttpClientLike } from '../types';
import { PolyHavenProvider } from './polyhaven';
import { AmbientCGProvider } from './ambientcg';
import { SketchfabProvider } from './sketchfab';
import { PolyPizzaProvider } from './polypizza';
import { BlenderKitProvider } from './blenderkit';
import { GlTFSamplesProvider } from './gltfsamples';
import { OpenGameArtProvider } from './opengameart';
import { ManualProvider, MANUAL_SOURCES } from './manual';
import { MockProvider } from './mock';

export function createProviders(http: HttpClientLike, opts: { includeMock?: boolean } = {}): Map<string, AssetProvider> {
  const map = new Map<string, AssetProvider>();
  const add = (p: AssetProvider) => map.set(p.info.id, p);
  add(new PolyHavenProvider(http));
  add(new AmbientCGProvider(http));
  add(new SketchfabProvider(http));
  add(new PolyPizzaProvider(http));
  add(new BlenderKitProvider(http));
  add(new GlTFSamplesProvider(http));
  add(new OpenGameArtProvider(http));
  for (const spec of MANUAL_SOURCES) add(new ManualProvider(spec, http));
  if (opts.includeMock) add(new MockProvider(http));
  return map;
}

export const PROVIDER_IDS = [
  'polyhaven', 'ambientcg', 'sketchfab', 'polypizza', 'blenderkit', 'gltfsamples', 'opengameart',
  'kenney', 'quaternius', 'kaykit', 'cgbookcase', 'itch', 'cgtrader', 'turbosquid',
  'free3d', 'mixamo', 'fab',
] as const;

export function isRealProvider(id: string): boolean {
  return (PROVIDER_IDS as readonly string[]).includes(id);
}
