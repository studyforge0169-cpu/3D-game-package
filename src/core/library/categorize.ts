/** Auto-categorization into the library taxonomy (spec §5). */

import type { AssetCategory, AssetKind, AssetRef } from '../types';

const KEYWORD_MAP: { cat: AssetCategory; words: string[] }[] = [
  { cat: 'Weapons', words: ['sword', 'rifle', 'gun', 'pistol', 'weapon', 'axe', 'bow', 'knife', 'dagger', 'grenade', 'cannon', 'launcher', 'shotgun', 'katana', 'shield', 'armor'] },
  { cat: 'Vehicles', words: ['car', 'vehicle', 'truck', 'plane', 'aircraft', 'ship', 'boat', 'tank', 'train', 'helicopter', 'bike', 'motorcycle', 'bus', 'spaceship', 'drone', 'kart'] },
  { cat: 'Characters', words: ['character', 'human', 'person', 'man', 'woman', 'hero', 'soldier', 'knight', 'zombie', 'npc', 'player', 'rpg hero', 'villager', 'adventurer', 'pirate', 'ninja', 'alien humanoid'] },
  { cat: 'Creatures', words: ['creature', 'monster', 'dragon', 'beast', 'animal', 'dog', 'cat', 'wolf', 'bear', 'demon', 'golem', 'slime', 'insect', 'bird', 'fish', 'dinosaur', 'orc'] },
  { cat: 'Buildings', words: ['building', 'house', 'castle', 'tower', 'temple', 'church', 'barn', 'hut', 'shop', 'station', 'bunker', 'ruin', 'dungeon', 'bridge', 'wall', 'fortress', 'cabin'] },
  { cat: 'Vegetation', words: ['tree', 'bush', 'plant', 'flower', 'grass', 'fern', 'shrub', 'mushroom', 'cactus', 'palm', 'log', 'foliage', 'leaf', 'pine', 'oak'] },
  { cat: 'Environment', words: ['environment', 'terrain', 'landscape', 'cliff', 'mountain', 'island', 'cave', 'forest', 'desert', 'city', 'street', 'road', 'river', 'biome', 'level', 'modular'] },
  { cat: 'Props', words: ['prop', 'furniture', 'chair', 'table', 'crate', 'barrel', 'lamp', 'chest', 'door', 'window', 'clock', 'book', 'pot', 'tool', 'sign', 'bench', 'cabinet', 'stool', 'torch'] },
  { cat: 'HDRIs', words: ['hdri', 'sky', 'environment map', 'sunrise', 'sunset', 'night sky', 'studio lighting'] },
  { cat: 'Materials', words: ['material', 'pbr', 'substance', 'shader', 'bricks', 'concrete', 'wood floor', 'metal surface', 'fabric'] },
  { cat: 'Textures', words: ['texture', 'seamless', 'tiling', 'albedo', 'diffuse map', 'normal map'] },
  { cat: 'Animations', words: ['animation', 'motion capture', 'mocap', 'animset', 'walk cycle', 'idle'] },
  { cat: 'VFX', words: ['vfx', 'particle', 'effect', 'explosion', 'smoke', 'fire', 'magic', 'spell', 'fx'] },
];

const KIND_FALLBACK: Record<AssetKind, AssetCategory> = {
  hdri: 'HDRIs',
  texture: 'Textures',
  material: 'Materials',
  audio: 'Other',
  animation: 'Animations',
  vfx: 'VFX',
  brush: 'Other',
  scene: 'Environment',
  model: 'Other',
  other: 'Other',
};

export function categorize(asset: AssetRef): AssetCategory {
  const hay = `${asset.name} ${(asset.tags ?? []).join(' ')} ${asset.description ?? ''}`.toLowerCase();
  let best: { cat: AssetCategory; score: number } = { cat: KIND_FALLBACK[asset.kind] ?? 'Other', score: 0 };
  // name matches weigh double
  const name = asset.name.toLowerCase();
  for (const { cat, words } of KEYWORD_MAP) {
    let score = 0;
    for (const w of words) {
      if (name.includes(w)) score += 4;
      if (hay.includes(w)) score += 1;
    }
    if (score > best.score) best = { cat, score };
  }
  if (asset.kind === 'hdri') return 'HDRIs';
  if ((asset.kind === 'texture' || asset.kind === 'material') && best.score < 4) {
    return asset.kind === 'material' ? 'Materials' : 'Textures';
  }
  return best.score >= 2 ? best.cat : (KIND_FALLBACK[asset.kind] ?? 'Other');
}
